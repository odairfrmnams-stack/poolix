import { PONS_DISCOVERY_CONFIG } from "@/services/pons/pons-config";

/*
  Price, market cap and qualification for Pons tokens. Pure: no I/O.

  Two rules run through all of it.

  INTEGERS ONLY. Every on-chain quantity stays a bigint from the pool's sqrtPriceX96 to the
  USD cents figure. Floating point appears nowhere, because a token with 18 decimals and a
  supply of 1e27 overflows a double long before it reaches a screen.

  NULL, NEVER A GUESS. Every function below returns null when its inputs cannot support an
  answer. A token with no verified price has `marketCapUsdCents = null`, which the UI
  renders as "--". It does not have a market cap of zero, because zero is a number and
  would be read as one.
*/

const Q96 = 2n ** 96n;
/** USD figures are carried in cents so nothing is lost to integer division. */
const CENTS = 100n;

export interface PriceInput {
  /** Straight from the pool's slot0. */
  readonly sqrtPriceX96: bigint;
  /** True when WETH sorts second, which decides which way the ratio reads. */
  readonly quoteIsToken1: boolean;
  readonly tokenDecimals: number;
  readonly quoteDecimals: number;
}

/**
 * Token price denominated in the quote asset, scaled by 1e18.
 *
 * Uniswap V3 stores `sqrt(token1/token0) * 2^96`. Squaring it recovers the ratio, and the
 * scaling below is arranged so the division happens last — dividing first would floor
 * intermediate values to zero for any token whose price is small in ETH terms, which is
 * most of them.
 *
 * Returns null rather than zero when the pool is uninitialised, because "no price" and "a
 * price of zero" are different facts.
 */
export function priceInQuoteE18(input: PriceInput): bigint | null {
  const { sqrtPriceX96, quoteIsToken1, tokenDecimals, quoteDecimals } = input;
  if (sqrtPriceX96 <= 0n) return null;
  if (!Number.isInteger(tokenDecimals) || tokenDecimals < 0 || tokenDecimals > 36) return null;
  if (!Number.isInteger(quoteDecimals) || quoteDecimals < 0 || quoteDecimals > 36) return null;

  const numerator = sqrtPriceX96 * sqrtPriceX96;
  const tokenScale = 10n ** BigInt(tokenDecimals);
  const quoteScale = 10n ** BigInt(quoteDecimals);

  /*
    quoteIsToken1: the pool ratio already reads quote-per-token, so scale and divide by 2^192.
    Otherwise the ratio is token-per-quote and has to be inverted, which means the 2^192
    moves to the numerator instead.
  */
  const price = quoteIsToken1
    ? (numerator * 10n ** 18n * tokenScale) / (Q96 * Q96 * quoteScale)
    : (Q96 * Q96 * 10n ** 18n * tokenScale) / (numerator * quoteScale);

  return price > 0n ? price : null;
}

export interface MarketCapInput {
  /** Token price in the quote asset, scaled 1e18. */
  readonly priceInQuoteE18: bigint | null;
  /** Raw `totalSupply()`. */
  readonly totalSupply: bigint | null;
  readonly tokenDecimals: number;
  /** Chainlink answer for the quote asset in USD. */
  readonly quoteUsdAnswer: bigint | null;
  readonly quoteUsdDecimals: number | null;
}

/**
 * Market capitalisation in USD cents, or null.
 *
 * Null propagates deliberately: a missing price, a missing supply or an unavailable oracle
 * each make the whole figure unknowable, and Poolix would rather show "--" than a number
 * assembled from two facts and one assumption.
 */
export function marketCapUsdCents(input: MarketCapInput): bigint | null {
  const { priceInQuoteE18: price, totalSupply, tokenDecimals, quoteUsdAnswer, quoteUsdDecimals } = input;

  if (price === null || price <= 0n) return null;
  if (totalSupply === null || totalSupply <= 0n) return null;
  if (quoteUsdAnswer === null || quoteUsdAnswer <= 0n) return null;
  if (quoteUsdDecimals === null || !Number.isInteger(quoteUsdDecimals) || quoteUsdDecimals < 0 || quoteUsdDecimals > 36) {
    return null;
  }
  if (!Number.isInteger(tokenDecimals) || tokenDecimals < 0 || tokenDecimals > 36) return null;

  // supply (raw) * price (quote per whole token, 1e18) / 10^tokenDecimals  -> quote wei
  const valueInQuoteWei = (totalSupply * price) / 10n ** BigInt(tokenDecimals);
  if (valueInQuoteWei <= 0n) return null;

  // quote wei * usd answer -> cents, unscaling both the 1e18 and the oracle's decimals.
  const cents = (valueInQuoteWei * quoteUsdAnswer * CENTS) / (10n ** 18n * 10n ** BigInt(quoteUsdDecimals));
  return cents > 0n ? cents : null;
}

export interface VolumeInput {
  /** Absolute quote-asset movement summed over the window, in wei. */
  readonly quoteVolumeWei: bigint;
  /** False when the window was not fully covered; the figure is then unusable. */
  readonly windowComplete: boolean;
  readonly quoteUsdAnswer: bigint | null;
  readonly quoteUsdDecimals: number | null;
}

/**
 * 24-hour volume in USD cents, or null.
 *
 * `windowComplete` is the important argument. A partially scanned window produces a number
 * that is always too small and never says so, and a volume that reads low is worse than a
 * volume that reads "--" — the first invites a decision, the second invites a question.
 * There is deliberately no extrapolation from a partial window.
 */
export function volumeUsdCents(input: VolumeInput): bigint | null {
  const { quoteVolumeWei, windowComplete, quoteUsdAnswer, quoteUsdDecimals } = input;

  if (!windowComplete) return null;
  if (quoteVolumeWei < 0n) return null;
  if (quoteUsdAnswer === null || quoteUsdAnswer <= 0n) return null;
  if (quoteUsdDecimals === null || !Number.isInteger(quoteUsdDecimals) || quoteUsdDecimals < 0 || quoteUsdDecimals > 36) {
    return null;
  }

  // A complete window with no trades really is zero, so zero is returned rather than null.
  return (quoteVolumeWei * quoteUsdAnswer * CENTS) / (10n ** 18n * 10n ** BigInt(quoteUsdDecimals));
}

/**
 * Absolute quote-asset movement in one V3 swap.
 *
 * The pool's two amounts are signed and opposite; the quote side is taken whole, whichever
 * direction it went, because volume counts turnover rather than net flow.
 */
export function swapQuoteVolumeWei(
  amount0: bigint,
  amount1: bigint,
  quoteIsToken1: boolean,
): bigint {
  const quoteAmount = quoteIsToken1 ? amount1 : amount0;
  return quoteAmount < 0n ? -quoteAmount : quoteAmount;
}

export type DisqualificationReason =
  | "no-market-cap"
  | "no-volume"
  | "market-cap-below-threshold"
  | "volume-below-threshold";

export interface QualificationInput {
  readonly marketCapUsdCents: bigint | null;
  readonly volume24hUsdCents: bigint | null;
}

export interface Qualification {
  readonly qualified: boolean;
  /** Null when qualified; otherwise the first condition that failed. */
  readonly reason: DisqualificationReason | null;
}

/**
 * The "Qualified" filter: market cap AND 24h volume both at or above their thresholds.
 *
 * Deterministic, total, and purely numeric. It ranks nothing and judges nothing — a
 * qualifying token is not "safe" or "good", it is a token above two numbers.
 *
 * A null on either input is a disqualification with its own reason, never a zero. The
 * distinction is what lets the UI say "no verified price" instead of implying the token
 * traded nothing.
 */
export function qualify(input: QualificationInput): Qualification {
  const minCapCents = BigInt(PONS_DISCOVERY_CONFIG.minMarketCapUsd) * CENTS;
  const minVolumeCents = BigInt(PONS_DISCOVERY_CONFIG.minVolume24hUsd) * CENTS;

  if (input.marketCapUsdCents === null) return { qualified: false, reason: "no-market-cap" };
  if (input.volume24hUsdCents === null) return { qualified: false, reason: "no-volume" };
  if (input.marketCapUsdCents < minCapCents) {
    return { qualified: false, reason: "market-cap-below-threshold" };
  }
  if (input.volume24hUsdCents < minVolumeCents) {
    return { qualified: false, reason: "volume-below-threshold" };
  }
  return { qualified: true, reason: null };
}

/** Why a token is not listed as qualified, in words a reader can act on. */
export function describeDisqualification(reason: DisqualificationReason): string {
  switch (reason) {
    case "no-market-cap":
      return "No verified price, so market cap cannot be calculated";
    case "no-volume":
      return "The 24-hour window is not fully indexed, so volume cannot be calculated";
    case "market-cap-below-threshold":
      return `Market cap is below $${PONS_DISCOVERY_CONFIG.minMarketCapUsd.toLocaleString("en-US")}`;
    case "volume-below-threshold":
      return `24-hour volume is below $${PONS_DISCOVERY_CONFIG.minVolume24hUsd.toLocaleString("en-US")}`;
  }
}

/**
 * Coverage of an indexing run, as a percentage with one decimal.
 *
 * Returns null when the range is not yet meaningful rather than reporting 0% or 100%,
 * either of which would be a claim the data does not support.
 */
export function coveragePercent(from: number, indexed: number, target: number): number | null {
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(indexed) || !Number.isSafeInteger(target)) {
    return null;
  }
  if (target <= from || indexed < from) return null;
  const covered = Math.min(indexed, target) - from;
  const total = target - from;
  return Math.round((covered / total) * 1000) / 10;
}
