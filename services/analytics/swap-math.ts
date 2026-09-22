/*
  Pure arithmetic for Uniswap v2 Swap events. No I/O, no network, no state — so every
  rule below is unit-testable in isolation.

  Scope for this stage: Token/WETH pairs only. Token/token pairs are counted as ignored
  rather than guessed at, because valuing them would need a price for a third asset and
  Poolix has no verified price feed.
*/

/** Swap(address indexed sender, uint amount0In, uint amount1In, uint amount0Out, uint amount1Out, address indexed to) */
export const SWAP_TOPIC0 = "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822";

/** PairCreated(address indexed token0, address indexed token1, address pair, uint) */
export const PAIR_CREATED_TOPIC0 = "0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9";

/** Which side of a pair holds WETH. `none` marks a pair this stage deliberately skips. */
export type WethSide = "token0" | "token1" | "none";

export interface DecodedSwap {
  readonly amount0In: bigint;
  readonly amount1In: bigint;
  readonly amount0Out: bigint;
  readonly amount1Out: bigint;
}

/** The four non-indexed uint256 words, so 2 + 4 * 64 characters. */
const SWAP_DATA_LENGTH = 2 + 4 * 64;

/**
 * Decodes a Swap event's data field. Returns null for anything malformed rather than
 * throwing, so one bad log cannot abort an aggregation over a hundred thousand of them.
 */
export function decodeSwapData(data: string): DecodedSwap | null {
  if (typeof data !== "string" || !data.startsWith("0x") || data.length !== SWAP_DATA_LENGTH) {
    return null;
  }
  const body = data.slice(2);
  if (!/^[0-9a-fA-F]+$/.test(body)) return null;

  return {
    amount0In: BigInt(`0x${body.slice(0, 64)}`),
    amount1In: BigInt(`0x${body.slice(64, 128)}`),
    amount0Out: BigInt(`0x${body.slice(128, 192)}`),
    amount1Out: BigInt(`0x${body.slice(192, 256)}`),
  };
}

/**
 * WETH moved by a single swap, in wei.
 *
 * Exactly one of in/out is non-zero on a given side, so summing them yields the amount
 * that crossed the pool without needing to know the trade direction. A pair with no
 * WETH side contributes nothing.
 */
export function wethAmountOfSwap(swap: DecodedSwap, side: WethSide): bigint {
  switch (side) {
    case "token0":
      return swap.amount0In + swap.amount0Out;
    case "token1":
      return swap.amount1In + swap.amount1Out;
    case "none":
      return 0n;
  }
}

export interface SwapLogLike {
  readonly address: string;
  readonly data: string;
}

export interface AggregateResult {
  readonly volumeWei: bigint;
  /** Swaps that contributed to the volume. */
  readonly counted: number;
  /** Token/token pairs, skipped by design at this stage. */
  readonly ignoredNonWeth: number;
  /** Pairs whose sides are not known yet, so they cannot be counted safely. */
  readonly unresolvedPairs: number;
  /** Logs whose data field could not be decoded. */
  readonly undecodable: number;
}

/**
 * Sums the WETH side of every swap in a batch.
 *
 * `sideOf` returns undefined for a pair that has not been classified yet. Those swaps
 * are reported separately and contribute zero — never guessed at — so a caller can
 * decide to resolve them and retry rather than silently under-reporting.
 */
export function aggregateWethVolume(
  logs: readonly SwapLogLike[],
  sideOf: (pair: string) => WethSide | undefined,
): AggregateResult {
  let volumeWei = 0n;
  let counted = 0;
  let ignoredNonWeth = 0;
  let unresolvedPairs = 0;
  let undecodable = 0;

  for (const log of logs) {
    const side = sideOf(log.address.toLowerCase());
    if (side === undefined) {
      unresolvedPairs++;
      continue;
    }
    if (side === "none") {
      ignoredNonWeth++;
      continue;
    }

    const swap = decodeSwapData(log.data);
    if (swap === null) {
      undecodable++;
      continue;
    }

    volumeWei += wethAmountOfSwap(swap, side);
    counted++;
  }

  return { volumeWei, counted, ignoredNonWeth, unresolvedPairs, undecodable };
}

/** Uniswap v2 takes 0.30% of the input amount on every swap. */
export const FEE_NUMERATOR = 3n;
export const FEE_DENOMINATOR = 1_000n;

/**
 * Trading fees implied by a WETH-denominated volume.
 *
 * Exact when WETH is the input side. When WETH is the output, the protocol takes its
 * cut in the *other* token, and this expresses that cut at the pool's own rate — so it
 * is a faithful conversion of a real fee, not an independent estimate. It never invents
 * a number: zero volume yields zero fees.
 */
export function tradingFeesWei(volumeWei: bigint): bigint {
  if (volumeWei <= 0n) return 0n;
  return (volumeWei * FEE_NUMERATOR) / FEE_DENOMINATOR;
}

/** Block bucket a swap belongs to, used to age entries out of the 24h window. */
export function bucketOf(blockNumber: number, bucketSize: number): number {
  return Math.floor(blockNumber / bucketSize) * bucketSize;
}

// --------------------------------------------------------------- reconciliation

/*
  Re-attributing swaps whose pair was not yet classified when their hour was first read.

  A pair is classified by reading token0/token1 from the contract, and that read can be
  refused when the endpoint is throttled. The swaps on such a pair are then recorded as
  `unresolvedSwaps` — correctly, since guessing a side would invent volume — and the
  bucket's total is a floor rather than a measurement. The pair is usually classified
  moments later by another page, but nothing ever went back for those swaps, so the
  undercount became permanent until the bucket aged out of the window.

  The repair rests on one property, which is what these functions exist to make explicit:

      a bucket's totals are a pure function of (its logs, the classification map)

  They do not depend on what the bucket previously held. So a bucket can be re-read and its
  totals REPLACED, and doing that twice changes nothing the second time. That is what makes
  reconciliation idempotent and makes double-counting impossible by construction rather
  than by bookkeeping — the alternative, adding a correction delta, would need the previous
  value to be exactly right, which is precisely what is in doubt.
*/

export interface BucketTotals {
  readonly volumeWei: bigint;
  readonly swaps: number;
  readonly ignoredNonWeth: number;
  readonly unresolvedSwaps: number;
}

/**
 * A bucket's totals, computed from its logs alone.
 *
 * Deliberately takes no prior state. Callers replace with this rather than merging into
 * it, so re-reading a range can never inflate it.
 */
export function bucketTotalsFrom(
  logs: readonly SwapLogLike[],
  sideOf: (pair: string) => WethSide | undefined,
): BucketTotals {
  const result = aggregateWethVolume(logs, sideOf);
  return {
    volumeWei: result.volumeWei,
    swaps: result.counted,
    ignoredNonWeth: result.ignoredNonWeth,
    // An undecodable log is unattributed for the same reason an unclassified pair is:
    // nothing about it is known, and unknown is not zero.
    unresolvedSwaps: result.unresolvedPairs + result.undecodable,
  };
}

/**
 * Whether a bucket's whole block range has been ingested.
 *
 * Reconciliation replaces a bucket outright, so it may only touch a bucket the window has
 * fully covered. The newest bucket is still being filled forwards and the oldest may be
 * half-covered by the backward walk; replacing either with a partial re-read would turn an
 * undercount into a different undercount.
 */
export function bucketRangeCovered(
  bucketStart: number,
  bucketBlocks: number,
  tail: number,
  head: number,
): boolean {
  return bucketStart >= tail && bucketStart + bucketBlocks <= head;
}

/** A bucket worth re-reading: it has unattributed swaps and its range is complete. */
export function needsReconciliation(
  bucket: { readonly unresolvedSwaps: number },
  bucketStart: number,
  bucketBlocks: number,
  tail: number,
  head: number,
): boolean {
  if (bucket.unresolvedSwaps <= 0) return false;
  return bucketRangeCovered(bucketStart, bucketBlocks, tail, head);
}

/**
 * The buckets to reconcile this tick, in a deterministic order and bounded in number.
 *
 * Oldest first, so a bucket about to age out of the window is repaired before it is lost,
 * and so two runs over the same state pick the same work. Bounded because a tick has a
 * budget and re-reading every affected bucket at once would starve the forward catch-up
 * that keeps the window current.
 */
export function reconciliationTargets(
  buckets: ReadonlyMap<number, { readonly unresolvedSwaps: number }>,
  bucketBlocks: number,
  tail: number,
  head: number,
  limit: number,
): number[] {
  if (limit <= 0) return [];
  return [...buckets.entries()]
    .filter(([start, bucket]) => needsReconciliation(bucket, start, bucketBlocks, tail, head))
    .map(([start]) => start)
    .sort((a, b) => a - b)
    .slice(0, limit);
}
