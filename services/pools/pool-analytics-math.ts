/*
  Pure arithmetic for per-pool analytics. No I/O, no network, no state.

  Everything here works from the pair's own two sides without assuming which one holds
  WETH. That assumption is the single easiest way to get a v2 pool wrong: token0 and
  token1 are ordered by address, so WETH lands on either side depending on the other
  token, and a pool whose WETH side is token1 would silently report the *other* token's
  reserve as its ETH liquidity.

  Raw amounts stay bigint throughout. Prices convert to a number only at the very end,
  because a price is a ratio for display while a reserve is an exact on-chain quantity.
*/

import { APR_SCALE, historicalFeeApr, type LiquiditySample } from "@/services/analytics/apr-math";
import { BUCKET_SECONDS, DAY_SECONDS, windowBuckets } from "@/services/analytics/history-math";
import { tradingFeesWei } from "@/services/analytics/swap-math";

/** Which side of a pair holds WETH. Mirrors the global analytics classification. */
export type WethSide = "token0" | "token1" | "none";

/** Lower-cased, so one pool is one key no matter how its address was written. */
export function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

export function sameAddress(a: string, b: string): boolean {
  return normalizeAddress(a) === normalizeAddress(b);
}

/**
 * Which side of the pair is WETH, decided by comparing addresses rather than assuming.
 * Returns "none" for a token/token pair, which is excluded from ETH-denominated figures
 * exactly as it is from global volume.
 */
export function wethSideOf(token0: string, token1: string, weth: string): WethSide {
  if (sameAddress(token0, weth)) return "token0";
  if (sameAddress(token1, weth)) return "token1";
  return "none";
}

export interface PairReserves {
  readonly reserve0: bigint;
  readonly reserve1: bigint;
}

/** The WETH reserve, or null when neither side is WETH. */
export function wethReserveOf(reserves: PairReserves, side: WethSide): bigint | null {
  switch (side) {
    case "token0":
      return reserves.reserve0;
    case "token1":
      return reserves.reserve1;
    case "none":
      return null;
  }
}

/** The non-WETH reserve, or null for a token/token pair. */
export function otherReserveOf(reserves: PairReserves, side: WethSide): bigint | null {
  switch (side) {
    case "token0":
      return reserves.reserve1;
    case "token1":
      return reserves.reserve0;
    case "none":
      return null;
  }
}

/**
 * ETH liquidity held by a pool: the WETH side doubled.
 *
 * The same definition Phase 2 uses for the chain-wide series — a balanced constant
 * product pool holds equal value on each side. Null rather than zero for a token/token
 * pair, because "not denominated in ETH" is not "holds no ETH".
 */
export function ethLiquidityOf(reserves: PairReserves, side: WethSide): bigint | null {
  const weth = wethReserveOf(reserves, side);
  return weth === null ? null : weth * 2n;
}

/** Price of one whole token in wei of the quote asset, exact until the caller rounds. */
export function priceInQuoteWei(
  baseReserve: bigint,
  baseDecimals: number,
  quoteReserve: bigint,
): bigint | null {
  if (baseReserve <= 0n || quoteReserve <= 0n) return null;
  // One whole unit of the base asset, so the result reads as "per token" not "per wei".
  return (quoteReserve * 10n ** BigInt(baseDecimals)) / baseReserve;
}

export interface PoolPrice {
  /** Non-WETH token priced in WETH, as a decimal string. Null when not a WETH pair. */
  readonly tokenInWethWei: bigint | null;
  /** The same price in USD cents, only when a verified ETH/USD reading was supplied. */
  readonly usdCents: bigint | null;
}

/**
 * Price of the pool's non-WETH token.
 *
 * USD is produced only when an ETH/USD answer is passed in — there is no fallback and no
 * second oracle. A token with no WETH side has no price here at all rather than a guessed
 * one, because pricing it would need a rate for a third asset Poolix cannot verify.
 */
export function poolPrice(
  reserves: PairReserves,
  side: WethSide,
  otherDecimals: number,
  ethUsd: { answer: bigint; decimals: number } | null,
): PoolPrice {
  const wethReserve = wethReserveOf(reserves, side);
  const otherReserve = otherReserveOf(reserves, side);
  if (wethReserve === null || otherReserve === null) {
    return { tokenInWethWei: null, usdCents: null };
  }

  const tokenInWethWei = priceInQuoteWei(otherReserve, otherDecimals, wethReserve);
  if (tokenInWethWei === null || ethUsd === null || ethUsd.answer <= 0n) {
    return { tokenInWethWei, usdCents: null };
  }

  // price(wei of WETH per token) x ETH/USD, expressed in cents. Integer throughout.
  const scale = 10n ** 18n * 10n ** BigInt(ethUsd.decimals);
  return { tokenInWethWei, usdCents: (tokenInWethWei * ethUsd.answer * 100n) / scale };
}

// --------------------------------------------------------------- per-pool series

/*
  The windows a pool page offers, in hours.

  A pool store keeps 30 days of hourly buckets, so 1H and 24H are slices of the same
  series rather than a second measurement — every frame here sums the identical buckets
  over a different span. This is the one place the pool page goes finer than the global
  analytics page, and it can only do so because per-pool ingestion keeps the hour grid.

  24H here is NOT the chain-wide 24h tile. That one measures 864,000 blocks, which is
  really 24.17 hours; this one is 24 exact clock hours. They are different windows over
  different scopes and are never compared.
*/
export const POOL_TIMEFRAME_HOURS = { "1H": 1, "24H": 24, "7D": 168, "30D": 720 } as const;
export type PoolTimeframe = keyof typeof POOL_TIMEFRAME_HOURS;

/** The bucket starts one pool timeframe covers, oldest first, on the shared hour grid. */
export function poolWindowStarts(
  nowTimestamp: number,
  frame: PoolTimeframe,
  bucketSeconds = BUCKET_SECONDS,
): number[] {
  return windowBuckets(nowTimestamp, (POOL_TIMEFRAME_HOURS[frame] * 3_600) / DAY_SECONDS, bucketSeconds);
}

export interface PoolBucket {
  readonly startTimestamp: number;
  /** ETH-side swap volume attributed to this pool, in wei. */
  readonly volumeWei: bigint;
  readonly swaps: number;
  /** Unique transactions touching this pool in the hour. */
  readonly transactions: number;
  /** ETH liquidity at the hour's close, or null when never observed. */
  readonly liquidityWei: bigint | null;
}

export interface PoolWindowTotals {
  readonly volumeWei: bigint;
  readonly feesWei: bigint;
  readonly swaps: number;
  readonly transactions: number;
  readonly bucketsPresent: number;
  readonly bucketsExpected: number;
  /** Hours whose liquidity is known. Fewer than expected means the window has holes. */
  readonly liquidityPoints: number;
  readonly volumeComplete: boolean;
  readonly liquidityComplete: boolean;
  readonly twalWei: bigint | null;
  readonly aprScaled: bigint | null;
  readonly aprReason: string;
}

/**
 * Totals one window for one pool.
 *
 * Fees come from this pool's own volume at the same 0.30% rate the global series uses,
 * and the APR denominator comes from this pool's own liquidity — the two can never be
 * crossed with another pool's because they arrive together in the same buckets.
 *
 * A missing bucket is counted as missing, never as a zero hour. The distinction is the
 * difference between a pool that was quiet and a pool that was not indexed.
 */
export function totalPoolWindow(
  buckets: ReadonlyMap<number, PoolBucket>,
  expectedStarts: readonly number[],
  bucketSeconds: number,
): PoolWindowTotals {
  let volumeWei = 0n;
  let swaps = 0;
  let transactions = 0;
  let bucketsPresent = 0;
  const samples: LiquiditySample[] = [];

  for (const start of expectedStarts) {
    const bucket = buckets.get(start);
    if (bucket === undefined) continue;
    bucketsPresent++;
    volumeWei += bucket.volumeWei;
    swaps += bucket.swaps;
    transactions += bucket.transactions;
    if (bucket.liquidityWei !== null) {
      samples.push({
        startTimestamp: start,
        durationSeconds: bucketSeconds,
        liquidityWei: bucket.liquidityWei,
      });
    }
  }

  const feesWei = tradingFeesWei(volumeWei);
  const volumeComplete = bucketsPresent === expectedStarts.length && expectedStarts.length > 0;
  const liquidityComplete = samples.length === expectedStarts.length && expectedStarts.length > 0;
  const windowSeconds = expectedStarts.length * bucketSeconds;

  // The same Phase 3 arithmetic, unchanged. There is no second APR formula.
  const apr = historicalFeeApr({ feesWei, samples, windowSeconds });
  const publishable = volumeComplete && liquidityComplete && apr.reason === "ok";

  return {
    volumeWei,
    feesWei,
    swaps,
    transactions,
    bucketsPresent,
    bucketsExpected: expectedStarts.length,
    liquidityPoints: samples.length,
    volumeComplete,
    liquidityComplete,
    twalWei: apr.twalWei,
    aprScaled: publishable ? apr.aprScaled : null,
    aprReason: publishable
      ? "ok"
      : !volumeComplete
        ? "volume-incomplete"
        : !liquidityComplete
          ? "liquidity-incomplete"
          : apr.reason,
  };
}

// ------------------------------------------------------------ series shaping

/**
 * One point of a per-pool series as it crosses to the client: wei as decimal strings.
 *
 * Declared structurally so the presentation view assigns to it without this module having
 * to import the view types, which would make the two mutually dependent for no gain.
 */
export interface PoolPointLike {
  readonly startTimestamp: number;
  readonly volumeWei: string;
  readonly liquidityWei: string | null;
  readonly swaps: number;
  readonly transactions: number;
}

/**
 * Drops liquidity readings from hours before the pool existed.
 *
 * A genesis scan can prove a pair that never emitted a Sync held nothing, so those hours
 * legitimately carry zero. That is a fact about a contract which had not been deployed,
 * not a measurement of this pool — and shown as "liquidity" beside live reserves it reads
 * as a contradiction rather than as history. Volume is untouched: a pool that did not
 * exist genuinely traded nothing, and zero is the right answer for it.
 *
 * Callers use this for what they DISPLAY as the pool's liquidity. It must not be used on
 * the APR denominator, which has to keep covering the same span the rate annualizes over.
 */
export function maskPreCreation<T extends PoolPointLike>(
  points: readonly T[],
  creation: PoolCreation | null,
  bucketSeconds = BUCKET_SECONDS,
): (T | (Omit<T, "liquidityWei"> & { liquidityWei: null }))[] {
  if (creation === null) return [...points];
  const creationBucket = Math.floor(creation.timestamp / bucketSeconds) * bucketSeconds;
  return points.map((point) =>
    point.startTimestamp < creationBucket ? { ...point, liquidityWei: null } : point,
  );
}

/**
 * Collapses hourly points into coarser ones for drawing.
 *
 * Volume is a sum over its window, so grouped volume adds. Liquidity is a level that
 * holds until it changes, so a group takes its LAST observed reading — the close — rather
 * than an average, which would report a level the pool never actually held. A group with
 * no reading at all stays null, so a gap survives grouping instead of being smoothed over
 * by its neighbours.
 */
export function groupPoolPoints<T extends PoolPointLike>(
  points: readonly T[],
  perGroup: number,
): PoolPointLike[] {
  if (perGroup <= 1) return [...points];

  const grouped: PoolPointLike[] = [];
  for (let index = 0; index < points.length; index += perGroup) {
    const slice = points.slice(index, index + perGroup);
    const first = slice[0];
    if (first === undefined) continue;

    let volumeWei = 0n;
    let swaps = 0;
    let transactions = 0;
    let liquidityWei: string | null = null;

    for (const point of slice) {
      volumeWei += BigInt(point.volumeWei);
      swaps += point.swaps;
      transactions += point.transactions;
      if (point.liquidityWei !== null) liquidityWei = point.liquidityWei;
    }

    grouped.push({
      startTimestamp: first.startTimestamp,
      volumeWei: volumeWei.toString(),
      liquidityWei,
      swaps,
      transactions,
    });
  }
  return grouped;
}

/** The most recent hour that actually holds a reading. A null is a hole, never a zero. */
export function latestObservedLiquidity(points: readonly PoolPointLike[]): string | null {
  for (let index = points.length - 1; index >= 0; index--) {
    const value = points[index]?.liquidityWei;
    if (value !== null && value !== undefined) return value;
  }
  return null;
}

export interface PoolCreation {
  readonly blockNumber: number;
  readonly timestamp: number;
  /** True when taken from PairCreated; false when inferred and therefore approximate. */
  readonly fromPairCreated: boolean;
}

/**
 * Whether a window starts before the pool existed.
 *
 * A pool created mid-window has no history before its creation, and that is not missing
 * data — there was nothing to record. Callers use this to explain a short window rather
 * than to pad it, which is the distinction between a stated limit and a silent one.
 */
export function windowPredatesPool(
  expectedStarts: readonly number[],
  creation: PoolCreation | null,
): boolean {
  if (creation === null) return false;
  const first = expectedStarts[0];
  return first !== undefined && creation.timestamp > first;
}

export { APR_SCALE };
