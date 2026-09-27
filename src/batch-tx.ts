/**
 * Real batch-transaction construction for {@link ConduitBatcher}.
 *
 * ## Why a batch is several transactions, not one
 *
 * Soroban permits exactly **one `InvokeHostFunction` operation per
 * transaction**. There is no way to pack N contract calls into a single
 * envelope, which is why the previous placeholder XDR was never replaced with
 * a real one — the shape it promised (`xdr: string` for N operations) is not
 * expressible on this network.
 *
 * So a batch builds **one genuine transaction per operation**. That matches how
 * the rest of the SDK already batches: `StreamsModule.batchWithdraw` issues one
 * transaction per withdrawal.
 *
 * ## What "submittable" means here
 *
 * A Soroban invocation is only submittable once it has been simulated, so the
 * network can attach its footprint and authorisation entries. Two levels:
 *
 * - **Offline** (`sequence` supplied, no `rpcUrl`): a well-formed, decodable
 *   transaction envelope. Not yet submittable — it still needs preparing.
 * - **Prepared** (`rpcUrl` supplied): simulated and assembled via RPC, so the
 *   footprint and auth are attached and the XDR can go straight to the network.
 *
 * `prepared` on the result says which one you got, so a caller is never left
 * guessing whether the XDR is ready.
 */

import {
  Account,
  Address,
  Contract,
  SorobanRpc,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  xdr,
  BASE_FEE,
} from '@stellar/stellar-sdk';
import { NETWORK_PASSPHRASE, createRpcServer } from './soroban.js';
import { RateLimitError } from './errors.js';
import type { Network } from './types/index.js';

export const DEFAULT_BATCH_TIMEOUT_SECONDS = 30;

/**
 * Everything needed to turn a validated operation list into real transactions.
 *
 * Supply `sequence` to build offline, or `rpcUrl` to fetch the sequence and
 * produce prepared, submittable XDR. Supplying neither is an error — that is
 * exactly the gap the placeholder XDR used to paper over.
 */
export interface BatchTransactionContext {
  /** Soroban contract the batched operations are invoked against. */
  contractId: string;
  /** Source account (G-address) that will sign and pay for the transactions. */
  sourceAccount: string;
  /** Named network. Ignored when `networkPassphrase` is given. */
  network?: Network;
  /** Explicit passphrase, for networks not covered by {@link Network}. */
  networkPassphrase?: string;
  /**
   * Current sequence number of `sourceAccount`. Required for offline building.
   * Each operation in the batch consumes one sequence number, in order.
   */
  sequence?: string;
  /** Soroban RPC endpoint. When set, transactions are simulated and prepared. */
  rpcUrl?: string;
  /** Per-transaction fee in stroops. Defaults to `BASE_FEE`. */
  fee?: string;
  /** Transaction timeout in seconds. Defaults to 30. */
  timeoutSeconds?: number;
}

/** One built transaction, with the operation it came from. */
export interface BuiltBatchTransaction {
  /** Index of the source operation in the input array. */
  index: number;
  method: string;
  xdr: string;
  /** True when simulated and assembled, so the XDR is ready to submit. */
  prepared: boolean;
}

export class BatchBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BatchBuildError';
  }
}

/** Resolve the passphrase from an explicit value or a named network. */
export function resolvePassphrase(context: BatchTransactionContext): string {
  if (context.networkPassphrase && context.networkPassphrase.trim().length > 0) {
    return context.networkPassphrase;
  }
  if (context.network) {
    const passphrase = NETWORK_PASSPHRASE[context.network];
    if (passphrase) return passphrase;
    throw new BatchBuildError(`Unknown network "${context.network}"`);
  }
  throw new BatchBuildError(
    'BatchTransactionContext requires either networkPassphrase or network',
  );
}

/**
 * Validate the context up front, so a caller gets a named problem instead of a
 * transaction that fails at submission.
 */
export function validateContext(context: BatchTransactionContext): string[] {
  const errors: string[] = [];

  if (!context || typeof context !== 'object') {
    return ['Batch transaction context is required to build XDR'];
  }
  if (!context.contractId || !StrKey.isValidContract(context.contractId)) {
    errors.push(
      `contractId must be a valid Soroban contract ID (C-address), got "${context.contractId}"`,
    );
  }
  if (!context.sourceAccount || !StrKey.isValidEd25519PublicKey(context.sourceAccount)) {
    errors.push(
      `sourceAccount must be a valid Stellar public key (G-address), got "${context.sourceAccount}"`,
    );
  }
  if (!context.network && !context.networkPassphrase) {
    errors.push('Either network or networkPassphrase must be provided');
  }
  if (context.network && !NETWORK_PASSPHRASE[context.network]) {
    errors.push(`Unknown network "${context.network}"`);
  }
  if (context.sequence === undefined && !context.rpcUrl) {
    errors.push(
      'Either sequence (to build offline) or rpcUrl (to fetch it and prepare) must be provided',
    );
  }
  if (context.sequence !== undefined && !/^\d+$/.test(String(context.sequence))) {
    errors.push(`sequence must be a non-negative integer string, got "${context.sequence}"`);
  }

  return errors;
}

/**
 * Convert a single parameter to an ScVal.
 *
 * Strings that are valid Stellar addresses become `Address` values rather than
 * string values — passing a G- or C-address as a plain string is a common way
 * to build a transaction the contract then rejects.
 */
export function paramToScVal(value: unknown): xdr.ScVal {
  // Values with no ScVal representation (symbols, functions, undefined) map to
  // void rather than throwing — validation has already accepted the payload, so
  // a stray non-serialisable field must not take the whole batch down.
  if (
    value === undefined ||
    typeof value === 'symbol' ||
    typeof value === 'function'
  ) {
    return xdr.ScVal.scvVoid();
  }
  if (value === null) {
    return xdr.ScVal.scvVoid();
  }
  if (typeof value === 'string' && (StrKey.isValidEd25519PublicKey(value) || StrKey.isValidContract(value))) {
    return new Address(value).toScVal();
  }
  if (typeof value === 'bigint') {
    return nativeToScVal(value, { type: 'i128' });
  }
  if (typeof value === 'number' && Number.isInteger(value)) {
    return nativeToScVal(value, { type: 'i64' });
  }
  return nativeToScVal(value);
}

/**
 * Build the argument list for one operation.
 *
 * `args` wins when present, so a caller who knows the contract ABI controls the
 * positional arguments exactly. Otherwise `params` is passed as a single map
 * argument, keyed by field name.
 */
export function operationToScVals(operation: {
  params?: Record<string, unknown> | undefined;
  args?: unknown[] | undefined;
}): xdr.ScVal[] {
  if (Array.isArray(operation.args)) {
    return operation.args.map(paramToScVal);
  }

  const params = operation.params ?? {};
  const entries = Object.entries(params);
  if (entries.length === 0) return [];

  return [
    xdr.ScVal.scvMap(
      entries
        // Soroban map keys must be sorted for the value to be canonical.
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, value]) =>
          new xdr.ScMapEntry({
            key: nativeToScVal(key, { type: 'symbol' }),
            val: paramToScVal(value),
          }),
        ),
    ),
  ];
}

interface BuildableOperation {
  method: string;
  params?: Record<string, unknown> | undefined;
  args?: unknown[] | undefined;
}

/**
 * Build one unsigned transaction per operation, offline.
 *
 * Requires `context.sequence`. Sequence numbers are consumed in order, so the
 * transactions are submitted in the same order they appear here.
 */
export function buildBatchTransactionsSync(
  operations: BuildableOperation[],
  context: BatchTransactionContext,
): BuiltBatchTransaction[] {
  const errors = validateContext(context);
  if (errors.length > 0) throw new BatchBuildError(errors.join('; '));
  if (context.sequence === undefined) {
    throw new BatchBuildError('sequence is required to build batch transactions offline');
  }

  const passphrase = resolvePassphrase(context);
  const contract = new Contract(context.contractId);
  const fee = context.fee ?? BASE_FEE;
  const timeout = context.timeoutSeconds ?? DEFAULT_BATCH_TIMEOUT_SECONDS;

  return operations.map((operation, index) => {
    if (!operation?.method || typeof operation.method !== 'string') {
      throw new BatchBuildError(`Operation at index ${index} is missing a method name`);
    }

    // One sequence number per transaction, since each is submitted separately.
    const sequence = (BigInt(context.sequence as string) + BigInt(index)).toString();
    const account = new Account(context.sourceAccount, sequence);

    const tx = new TransactionBuilder(account, { fee, networkPassphrase: passphrase })
      .addOperation(contract.call(operation.method, ...operationToScVals(operation)))
      .setTimeout(timeout)
      .build();

    return { index, method: operation.method, xdr: tx.toXDR(), prepared: false };
  });
}

/**
 * Build one transaction per operation and prepare each via RPC simulation, so
 * the returned XDR carries its footprint and auth and is ready to submit.
 *
 * Falls back to offline building when no `rpcUrl` is configured.
 */
export async function buildBatchTransactions(
  operations: BuildableOperation[],
  context: BatchTransactionContext,
): Promise<BuiltBatchTransaction[]> {
  const errors = validateContext(context);
  if (errors.length > 0) throw new BatchBuildError(errors.join('; '));

  if (!context.rpcUrl) {
    return buildBatchTransactionsSync(operations, context);
  }

  const server = createRpcServer(context.rpcUrl);

  let sequence = context.sequence;
  if (sequence === undefined) {
    try {
      const account = await server.getAccount(context.sourceAccount);
      sequence = account.sequenceNumber();
    } catch (err) {
      throw RateLimitError.fromRpcError(err) ?? err;
    }
  }

  const passphrase = resolvePassphrase(context);
  const contract = new Contract(context.contractId);
  const fee = context.fee ?? BASE_FEE;
  const timeout = context.timeoutSeconds ?? DEFAULT_BATCH_TIMEOUT_SECONDS;

  // Build all transactions offline first (sequence numbers are deterministic),
  // then simulate them all in parallel. Soroban simulations are independent
  // read operations — they do not mutate state and do not depend on each
  // other's outcome — so there is no correctness reason to run them serially.
  const txs = operations.map((operation, index) => {
    if (!operation?.method || typeof operation.method !== 'string') {
      throw new BatchBuildError(`Operation at index ${index} is missing a method name`);
    }
    const txSequence = (BigInt(sequence) + BigInt(index)).toString();
    const account = new Account(context.sourceAccount, txSequence);
    const tx = new TransactionBuilder(account, { fee, networkPassphrase: passphrase })
      .addOperation(contract.call(operation.method, ...operationToScVals(operation)))
      .setTimeout(timeout)
      .build();
    return { operation, index, tx };
  });

  const simulationResults = await Promise.all(
    txs.map(async ({ tx, index, operation }) => {
      let simulation;
      try {
        simulation = await server.simulateTransaction(tx);
      } catch (err) {
        throw RateLimitError.fromRpcError(err) ?? err;
      }
      if (SorobanRpc.Api.isSimulationError(simulation)) {
        throw new BatchBuildError(
          `Simulation failed for operation ${index} (${operation.method}): ${simulation.error}`,
        );
      }
      return { index, operation, tx, simulation };
    }),
  );

  return simulationResults.map(({ index, operation, tx, simulation }) => {
    const assembled = SorobanRpc.assembleTransaction(tx, simulation).build();
    return { index, method: operation.method, xdr: assembled.toXDR(), prepared: true };
  });
}

// ── Batch submission ──────────────────────────────────────────────────────────

/** Per-transaction outcome produced by {@link submitBatch}. */
export interface BatchSubmitOutcome {
  /** The transaction's position in the original operations array. */
  index: number;
  /** `true` when the network accepted the transaction. */
  success: boolean;
  /** Transaction hash returned by the RPC node, when available. */
  hash?: string;
  /** Error message when `success` is `false`. */
  error?: string;
}

/** Aggregate result returned by {@link submitBatch} when `throwOnPartial` is `false`. */
export interface BatchSubmitResult {
  /** Outcome for every transaction, in submission order. */
  outcomes: BatchSubmitOutcome[];
  /** Number of transactions the network accepted. */
  successCount: number;
  /** Number of transactions that failed. */
  failureCount: number;
}

/** Options accepted by {@link submitBatch}. */
export interface BatchSubmitOptions {
  /**
   * When `true` and at least one transaction fails, throw a
   * {@link BatchPartiallySubmittedError} instead of returning the aggregate
   * result. Defaults to `false`.
   */
  throwOnPartial?: boolean;
  /** AbortSignal to cancel in-flight submissions. */
  signal?: AbortSignal;
}

/**
 * Thrown by {@link submitBatch} when `throwOnPartial: true` and at least one
 * transaction in the batch failed. Carries the full per-transaction outcome
 * so callers can inspect what succeeded and what did not.
 *
 * Use {@link getFailedOperations} to extract the subset of original operations
 * that still need to be resubmitted, ready to pass back into
 * {@link buildBatchTransactions} + {@link submitBatch}:
 *
 * @example
 * ```ts
 * import {
 *   buildBatchTransactions,
 *   submitBatch,
 *   BatchPartiallySubmittedError,
 * } from '@conduit-protocol/sdk';
 *
 * try {
 *   const built = await buildBatchTransactions(operations, context);
 *   await submitBatch(built, rpcUrl, { throwOnPartial: true });
 * } catch (err) {
 *   if (err instanceof BatchPartiallySubmittedError) {
 *     console.log(`${err.result.failureCount} of ${err.result.outcomes.length} failed`);
 *     const retry = err.getFailedOperations(operations);
 *     // retry is the subset of `operations` whose transactions failed
 *   }
 * }
 * ```
 *
 * See #803.
 */
export class BatchPartiallySubmittedError extends Error {
  /** Full per-transaction submission result. */
  readonly result: BatchSubmitResult;

  /**
   * The built transactions that were passed to {@link submitBatch}.
   * Retained so {@link getFailedOperations} can correlate outcomes back to
   * the caller's original operation list.
   */
  readonly builtTransactions: BuiltBatchTransaction[];

  constructor(result: BatchSubmitResult, builtTransactions: BuiltBatchTransaction[]) {
    const { failureCount, outcomes } = result;
    super(
      `Batch partially submitted: ${failureCount} of ${outcomes.length} transaction(s) failed. ` +
      `Call getFailedOperations(originalOperations) to get the failed subset for retry.`,
    );
    this.name = 'BatchPartiallySubmittedError';
    this.result = result;
    this.builtTransactions = builtTransactions;
    // Maintain correct prototype chain for `instanceof` checks in transpiled JS.
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /**
   * Returns the subset of `originalOperations` whose transactions failed,
   * preserving the original order.
   *
   * Pass the same array you supplied to {@link buildBatchTransactions} that
   * produced the built transactions stored in {@link builtTransactions}.
   * The returned array is ready to feed directly back into
   * `buildBatchTransactions` + `submitBatch` for a retry.
   *
   * @param originalOperations - The full list of operations that was passed to
   *   `buildBatchTransactions`. Must be indexable by the `index` field on each
   *   {@link BuiltBatchTransaction}.
   */
  getFailedOperations<T extends { method: string; params?: Record<string, unknown>; args?: unknown[] }>(
    originalOperations: T[],
  ): T[] {
    const failedIndices = new Set(
      this.result.outcomes
        .filter(o => !o.success)
        .map(o => o.index),
    );
    return this.builtTransactions
      .filter(tx => failedIndices.has(tx.index))
      .map(tx => {
        const op = originalOperations[tx.index];
        if (op === undefined) {
          throw new RangeError(
            `getFailedOperations: no operation at index ${tx.index}. ` +
            `Make sure originalOperations is the same array passed to buildBatchTransactions.`,
          );
        }
        return op;
      });
  }
}

/**
 * Submit a list of pre-built (and optionally prepared) batch transactions to
 * the Soroban RPC, collecting per-transaction outcomes.
 *
 * Failures are isolated: one transaction failing does not abort the others.
 * Use `throwOnPartial: true` to receive a {@link BatchPartiallySubmittedError}
 * with a {@link BatchPartiallySubmittedError.getFailedOperations} helper when
 * any transaction fails.
 *
 * @param builtTransactions - Output of {@link buildBatchTransactions}.
 * @param rpcUrl - Soroban RPC endpoint to submit against.
 * @param options - Optional abort signal and `throwOnPartial` flag.
 *
 * @example
 * ```ts
 * const built = await buildBatchTransactions(operations, context);
 * const result = await submitBatch(built, context.rpcUrl!);
 * console.log(result.successCount, 'of', result.outcomes.length, 'succeeded');
 * ```
 */
export async function submitBatch(
  builtTransactions: BuiltBatchTransaction[],
  rpcUrl: string,
  options?: BatchSubmitOptions,
): Promise<BatchSubmitResult> {
  if (!rpcUrl || typeof rpcUrl !== 'string' || rpcUrl.trim().length === 0) {
    throw new BatchBuildError('submitBatch: rpcUrl must be a non-empty string');
  }
  if (!Array.isArray(builtTransactions)) {
    throw new BatchBuildError('submitBatch: builtTransactions must be an array');
  }

  const signal = options?.signal;
  const throwOnPartial = options?.throwOnPartial ?? false;

  const server = createRpcServer(rpcUrl);

  const outcomes: BatchSubmitOutcome[] = await Promise.all(
    builtTransactions.map(async (tx): Promise<BatchSubmitOutcome> => {
      if (signal?.aborted) {
        return { index: tx.index, success: false, error: 'Aborted' };
      }

      try {
        const sent = await server.sendTransaction(
          // The RPC client accepts the raw XDR envelope string.
          // Cast through unknown to satisfy the SDK's overloaded type.
          tx.xdr as unknown as Parameters<typeof server.sendTransaction>[0],
        );

        if (sent.status === 'ERROR') {
          const hash = (sent as { hash?: string }).hash;
          return {
            index: tx.index,
            success: false,
            ...(hash != null ? { hash } : {}),
            error: `RPC returned status ERROR for transaction at index ${tx.index}`,
          };
        }

        const hash = (sent as { hash?: string }).hash;
        return {
          index: tx.index,
          success: true,
          ...(hash != null ? { hash } : {}),
        };
      } catch (err) {
        const classified = RateLimitError.fromRpcError(err);
        const message = classified
          ? classified.message
          : err instanceof Error
            ? err.message
            : String(err);
        return { index: tx.index, success: false, error: message };
      }
    }),
  );

  const successCount = outcomes.filter(o => o.success).length;
  const failureCount = outcomes.length - successCount;
  const result: BatchSubmitResult = { outcomes, successCount, failureCount };

  if (throwOnPartial && failureCount > 0) {
    throw new BatchPartiallySubmittedError(result, builtTransactions);
  }

  return result;
}
