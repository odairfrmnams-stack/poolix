/*
  Pure arithmetic and validation for USD valuation from a Chainlink price feed.
  No I/O, no network, no state.

  Every value is integer maths on bigints. Floating point never touches an onchain
  quantity: the only conversion to a number happens in the presentation layer, on a
  value already reduced to cents.
*/

export interface ChainlinkRound {
  readonly roundId: bigint;
  readonly answer: bigint;
  readonly startedAt: bigint;
  readonly updatedAt: bigint;
  readonly answeredInRound: bigint;
}

/**
 * This feed publishes on a ~24h heartbeat, so a shorter staleness threshold would
 * reject perfectly valid prices. The grace period covers ordinary publication jitter.
 */
export const FEED_HEARTBEAT_SECONDS = 24 * 60 * 60;
export const FEED_STALENESS_GRACE_SECONDS = 2 * 60 * 60;
export const MAX_PRICE_AGE_SECONDS = FEED_HEARTBEAT_SECONDS + FEED_STALENESS_GRACE_SECONDS;

/** The decimals this feed is expected to report; asserted rather than assumed. */
export const EXPECTED_FEED_DECIMALS = 8;

export type PriceRejection =
  | "answer-not-positive"
  | "never-updated"
  | "invalid-round"
  | "incomplete-round"
  | "stale"
  | "unexpected-decimals";

export type PriceValidation = { readonly ok: true } | { readonly ok: false; readonly reason: PriceRejection };

export interface ValidateOptions {
  readonly nowSeconds: bigint;
  readonly decimals: number;
  readonly maxAgeSeconds?: number;
  readonly expectedDecimals?: number;
}

/**
 * Applies every check the feed exposes. A rejection is returned rather than thrown so
 * the caller renders `--` with a reason instead of a number it cannot stand behind.
 */
export function validateRound(round: ChainlinkRound, options: ValidateOptions): PriceValidation {
  const expected = options.expectedDecimals ?? EXPECTED_FEED_DECIMALS;
  if (!Number.isInteger(options.decimals) || options.decimals !== expected) {
    return { ok: false, reason: "unexpected-decimals" };
  }
  if (round.answer <= 0n) return { ok: false, reason: "answer-not-positive" };
  if (round.updatedAt <= 0n) return { ok: false, reason: "never-updated" };
  if (round.roundId <= 0n) return { ok: false, reason: "invalid-round" };
  // A round answered in an earlier round carries a price that was never refreshed.
  if (round.answeredInRound < round.roundId) return { ok: false, reason: "incomplete-round" };

  const maxAge = BigInt(options.maxAgeSeconds ?? MAX_PRICE_AGE_SECONDS);
  // A timestamp ahead of now is clock skew, not staleness; only lateness is rejected.
  if (round.updatedAt < options.nowSeconds && options.nowSeconds - round.updatedAt > maxAge) {
    return { ok: false, reason: "stale" };
  }

  return { ok: true };
}

/** Seconds since the feed last published. Zero when the timestamp is in the future. */
export function priceAgeSeconds(round: ChainlinkRound, nowSeconds: bigint): bigint {
  return round.updatedAt >= nowSeconds ? 0n : nowSeconds - round.updatedAt;
}

/**
 * Converts a token amount to USD cents using the feed's answer.
 *
 * Cents rather than a float: the largest realistic value here is a few billion cents,
 * far inside the safe integer range, so the presentation layer can divide by 100 without
 * losing precision. Working in the feed's own 1e8 scale would overflow that range around
 * $90 million.
 */
export function usdCentsFrom(
  amount: bigint,
  answer: bigint,
  priceDecimals: number,
  tokenDecimals = 18,
): bigint {
  if (amount <= 0n || answer <= 0n) return 0n;
  if (!Number.isInteger(priceDecimals) || priceDecimals < 0) return 0n;
  if (!Number.isInteger(tokenDecimals) || tokenDecimals < 0) return 0n;

  const scale = 10n ** BigInt(tokenDecimals) * 10n ** BigInt(priceDecimals);
  return (amount * answer * 100n) / scale;
}

/**
 * Cents to a number, for formatting only. Safe because cents stay well inside
 * Number.MAX_SAFE_INTEGER for any plausible TVL.
 */
export function centsToNumber(cents: bigint): number {
  return Number(cents) / 100;
}

/** The feed's answer as a plain USD number, for display beside the TVL figure. */
export function answerToUsd(answer: bigint, priceDecimals: number): number {
  return centsToNumber(usdCentsFrom(10n ** 18n, answer, priceDecimals));
}
