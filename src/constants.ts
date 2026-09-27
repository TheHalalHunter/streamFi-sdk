/**
 * A syntactically valid Stellar G-address with no known keypair. Used only
 * as the transaction source for read-only simulation calls when no real
 * keypair is configured — Soroban's simulateTransaction doesn't require the
 * source account to actually exist or sign anything for a read-only
 * invocation. Never used to sign or move funds.
 */
export const ZERO_ADDR = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

/** Default page size for `FactoryModule` / `StreamsModule.list()` pagination. */
export const DEFAULT_LIST_LIMIT = 20;

/**
 * Maximum page size the SDK will send to `DripFactory::streams_by_sender` /
 * `streams_by_recipient`. The contract itself does not clamp this — an
 * unbounded `limit` produces an oversized simulation response — so the SDK
 * enforces the README-documented max client-side (see #489).
 */
export const MAX_LIST_LIMIT = 100;

/**
 * Clamp a caller-supplied list `limit` into the valid `[0, MAX_LIST_LIMIT]`
 * range expected by `streams_by_sender` / `streams_by_recipient`. Non-finite
 * input (NaN, ±Infinity) falls back to {@link DEFAULT_LIST_LIMIT} rather than
 * producing an invalid u32 conversion.
 */
export function clampListLimit(limit: number): number {
  if (!Number.isFinite(limit)) return DEFAULT_LIST_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 0), MAX_LIST_LIMIT);
}

/**
 * Known USDC issuer G-addresses per network.
 *
 * - `mainnet` — Circle's production issuer.
 * - `testnet` — Circle's Testnet issuer (SDF Test Network).
 * - `local`   — No canonical USDC issuer exists on a local Soroban instance.
 *   Accessing this entry throws at runtime so callers get a clear error
 *   instead of silently inheriting the mainnet address (see #804).
 *
 * @example
 * ```ts
 * import { USDC_ISSUER } from './constants.js';
 * const issuer = USDC_ISSUER[network]; // throws on 'local'
 * ```
 */
export const USDC_ISSUER: Record<'mainnet' | 'testnet', string> & {
  readonly local: never;
} = {
  mainnet: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5REANYOUR',
  testnet: 'GBBD47IF6LWK7P7MDEVSCWTTCJM4TWCHZR4TCEFUB8IQVGIGY4MBKOMZ',
  get local(): never {
    throw new Error(
      "token: 'USDC' is not supported on the 'local' network — no canonical " +
      'USDC issuer exists on a local Soroban instance. ' +
      'Pass an explicit contract address for your locally-deployed token instead.',
    );
  },
} as const;
