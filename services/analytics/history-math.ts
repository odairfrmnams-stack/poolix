/*
  Pure arithmetic for the historical volume window. No I/O, no network, no state.

  Two decisions here come from measuring the chain rather than from convention, and both
  are load-bearing.

  Buckets are defined by TIMESTAMP, not by block count. The existing 24h window uses
  864,000 blocks as a stand-in for a day, and measurement says that is really 24.17h —
  fine for a rolling figure, but over 30 days the same assumption drifts by about 1%, so
  "30D" would silently mean 30.3 days. HyperSync does return block timestamps, so the
  window boundaries are real hours and the drift disappears.

  Aggregation still happens over BLOCK ranges. Asking HyperSync for each log's timestamp
  costs 53% more payload, measured, and over a 30-day sweep that is hundreds of megabytes
  to learn something the bucket boundaries already encode. So each bucket stores the block
  range its hour maps to, resolved once, and swaps are filed by block number.
*/

import { tradingFeesWei } from "@/services/analytics/swap-math";

/** One hour. 30 days is 720 buckets, which is small enough to keep and fine enough to chart. */
export const BUCKET_SECONDS = 3_600;

export const DAY_SECONDS = 86_400;

/** The timeframes the UI offers. 24H stays on the existing rolling window. */
export const HISTORY_DAYS = { "7D": 7, "30D": 30 } as const;
export type HistoryTimeframe = keyof typeof HISTORY_DAYS;

export interface HistoryBucket {
  /** Inclusive start of the hour this bucket covers, in epoch seconds. */
  readonly startTimestamp: number;
  /** Exclusive end. */
  readonly endTimestamp: number;
  /** Inclusive first block of the range this hour maps to. */
  readonly fromBlock: number;
  /** Exclusive last block. */
  readonly toBlock: number;
  readonly volumeWei: bigint;
  readonly swaps: number;
  readonly ignoredNonWeth: number;
  readonly unresolvedSwaps: number;
}

/** The hour a timestamp falls in. */
export function bucketStartFor(timestamp: number, bucketSeconds = BUCKET_SECONDS): number {
  return Math.floor(timestamp / bucketSeconds) * bucketSeconds;
}

/**
 * The bucket starts a rolling window covers, oldest first.
 *
 * The window ends at the last *complete* hour rather than at `now`: a bucket still being
 * filled would otherwise read as a collapse in volume on the right edge of the chart.
 */
export function windowBuckets(
  nowTimestamp: number,
  days: number,
  bucketSeconds = BUCKET_SECONDS,
): number[] {
  const end = bucketStartFor(nowTimestamp, bucketSeconds);
  const count = Math.round((days * DAY_SECONDS) / bucketSeconds);
  const starts: number[] = [];
  for (let index = count; index >= 1; index--) {
    starts.push(end - index * bucketSeconds);
  }
  return starts;
}

/**
 * Estimates the block at a timestamp from a known reference point.
 *
 * Only ever a starting guess: the caller refines it against real block headers before a
 * boundary is committed. Measured block time held between 0.1006s and 0.1013s across 1h,
 * 24h, 7D and 30D spans, so the estimate lands within a few hundred blocks.
 */
export function estimateBlockAt(
  targetTimestamp: number,
  referenceBlock: number,
  referenceTimestamp: number,
  blockTimeSeconds: number,
): number {
  const delta = (targetTimestamp - referenceTimestamp) / blockTimeSeconds;
  return Math.max(0, Math.round(referenceBlock + delta));
}

export interface WindowTotals {
  readonly volumeWei: bigint;
  readonly feesWei: bigint;
  readonly swaps: number;
  readonly ignoredNonWeth: number;
  readonly unresolvedSwaps: number;
  /** Buckets that hold data. */
  readonly bucketsPresent: number;
  /** Buckets the window asks for. */
  readonly bucketsExpected: number;
  /** Bucket starts with no data at all. Never treated as zero volume. */
  readonly missing: readonly number[];
  /** True only when every expected bucket is present. */
  readonly complete: boolean;
}

/**
 * Totals a window from whatever buckets exist.
 *
 * A missing bucket is reported, not counted as zero. The difference matters: an hour with
 * no trades and an hour that was never ingested produce the same sum, and only one of
 * them is a fact. Callers withhold the figure until `complete`, and the UI says how much
 * of the window is actually covered.
 */
export function totalWindow(
  buckets: ReadonlyMap<number, HistoryBucket>,
  expectedStarts: readonly number[],
): WindowTotals {
  let volumeWei = 0n;
  let swaps = 0;
  let ignoredNonWeth = 0;
  let unresolvedSwaps = 0;
  let bucketsPresent = 0;
  const missing: number[] = [];

  for (const start of expectedStarts) {
    const bucket = buckets.get(start);
    if (bucket === undefined) {
      missing.push(start);
      continue;
    }
    bucketsPresent++;
    volumeWei += bucket.volumeWei;
    swaps += bucket.swaps;
    ignoredNonWeth += bucket.ignoredNonWeth;
    unresolvedSwaps += bucket.unresolvedSwaps;
  }

  return {
    volumeWei,
    // The same 0.30% rule the 24h figure uses, applied to the same WETH-side volume.
    feesWei: tradingFeesWei(volumeWei),
    swaps,
    ignoredNonWeth,
    unresolvedSwaps,
    bucketsPresent,
    bucketsExpected: expectedStarts.length,
    missing,
    complete: missing.length === 0 && expectedStarts.length > 0,
  };
}

export interface SeriesPoint {
  readonly startTimestamp: number;
  readonly endTimestamp: number;
  readonly volumeWei: bigint;
  readonly feesWei: bigint;
  readonly swaps: number;
  /** False when any bucket behind this point is missing, so the chart can show the hole. */
  readonly complete: boolean;
}

/**
 * Groups buckets into chart points, summing whole hours into a coarser step.
 *
 * Used to render 30 days as daily bars from the same hourly store, so there is one source
 * of truth and no second ingestion at a different resolution. A point built from an
 * incomplete set of hours is flagged rather than dropped or silently shortened.
 */
export function toSeries(
  buckets: ReadonlyMap<number, HistoryBucket>,
  expectedStarts: readonly number[],
  groupSeconds: number,
  bucketSeconds = BUCKET_SECONDS,
): SeriesPoint[] {
  if (expectedStarts.length === 0) return [];
  const perGroup = Math.max(1, Math.round(groupSeconds / bucketSeconds));

  const points: SeriesPoint[] = [];
  for (let index = 0; index < expectedStarts.length; index += perGroup) {
    const slice = expectedStarts.slice(index, index + perGroup);
    const first = slice[0];
    const last = slice[slice.length - 1];
    if (first === undefined || last === undefined) continue;

    let volumeWei = 0n;
    let swaps = 0;
    let present = 0;
    for (const start of slice) {
      const bucket = buckets.get(start);
      if (bucket === undefined) continue;
      present++;
      volumeWei += bucket.volumeWei;
      swaps += bucket.swaps;
    }

    points.push({
      startTimestamp: first,
      endTimestamp: last + bucketSeconds,
      volumeWei,
      feesWei: tradingFeesWei(volumeWei),
      swaps,
      complete: present === slice.length,
    });
  }

  return points;
}

/**
 * Buckets to keep. Anything older than the longest window plus a buffer is dropped, so
 * storage stays bounded instead of growing for the life of the process.
 */
export function retainedStarts(
  nowTimestamp: number,
  maxDays: number,
  bufferHours = 6,
  bucketSeconds = BUCKET_SECONDS,
): number {
  const end = bucketStartFor(nowTimestamp, bucketSeconds);
  return end - maxDays * DAY_SECONDS - bufferHours * bucketSeconds;
}

/**
 * Checks a set of block ranges tiles its span with no overlap and no hole.
 *
 * Ranges are half-open, so a correct chain has each range starting exactly where the last
 * ended. An overlap would double-count swaps in the intersection and a hole would drop
 * them, and neither is visible in the totals alone — which is why this is checked rather
 * than assumed.
 */
export function findRangeFaults(
  ranges: readonly { fromBlock: number; toBlock: number }[],
): { overlaps: number; gaps: number } {
  const sorted = [...ranges].sort((a, b) => a.fromBlock - b.fromBlock);
  let overlaps = 0;
  let gaps = 0;

  for (let index = 1; index < sorted.length; index++) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    if (previous === undefined || current === undefined) continue;
    if (current.fromBlock < previous.toBlock) overlaps++;
    else if (current.fromBlock > previous.toBlock) gaps++;
  }

  return { overlaps, gaps };
}
