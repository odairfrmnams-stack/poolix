/*
  Pure reserve reconstruction from Uniswap v2 pair events. No I/O, no network, no state.

  Sync is the source of truth. A v2 pair emits Sync(uint112 reserve0, uint112 reserve1)
  after every operation that moves reserves — mint, burn, swap, skim, sync — and it
  carries ABSOLUTE reserves, not deltas. So replaying Sync alone reconstructs exact state
  at any point, and it is self-correcting: a missed event is repaired by the next one
  rather than corrupting everything after it, which is not true of a delta chain.

  Mint and Burn are decoded and applied here too, but only as a cross-check: their deltas
  must agree with the Sync that follows in the same transaction. They are not needed for
  reserves, and the ingestion does not depend on them.

  Everything is bigint. A uint112 reserve does not fit in a double, and a rounded reserve
  is a wrong reserve.
*/

/** Sync(uint112 reserve0, uint112 reserve1) */
export const SYNC_TOPIC0 = "0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1";
/** Mint(address indexed sender, uint amount0, uint amount1) */
export const MINT_TOPIC0 = "0x4c209b5fc8ad50758f13e2e1088ba56a560dff690a1c6fef26394f4c03821c4f";
/** Burn(address indexed sender, uint amount0, uint amount1, address indexed to) */
export const BURN_TOPIC0 = "0xdccd412f0b1252819cb1fd330b93224ca42612892bb3f4f789976e6d81936496";

/** uint112 ceiling. A reserve above this cannot have come from a real pair. */
export const MAX_UINT112 = 2n ** 112n - 1n;

export interface PairEvent {
  readonly pair: string;
  readonly blockNumber: number;
  readonly logIndex: number;
  readonly topic0: string;
  readonly data: string;
}

export interface Reserves {
  readonly reserve0: bigint;
  readonly reserve1: bigint;
}

/** Two uint256 words, so 2 + 2 * 64 characters. */
const TWO_WORDS = 2 + 2 * 64;

/**
 * Decodes two uint256 words. Returns null for anything malformed rather than throwing,
 * so one bad log cannot abandon a reconstruction over tens of thousands of them.
 */
function decodeTwoWords(data: string): { first: bigint; second: bigint } | null {
  if (typeof data !== "string" || !data.startsWith("0x") || data.length !== TWO_WORDS) return null;
  const body = data.slice(2);
  if (!/^[0-9a-fA-F]+$/.test(body)) return null;
  return {
    first: BigInt(`0x${body.slice(0, 64)}`),
    second: BigInt(`0x${body.slice(64, 128)}`),
  };
}

/** Absolute reserves carried by a Sync event. */
export function decodeSync(data: string): Reserves | null {
  const words = decodeTwoWords(data);
  if (words === null) return null;
  // A pair stores reserves as uint112; anything larger is not a reserve.
  if (words.first > MAX_UINT112 || words.second > MAX_UINT112) return null;
  return { reserve0: words.first, reserve1: words.second };
}

/** The amounts added or removed by a Mint or Burn. Used only to cross-check Sync. */
export function decodeAmounts(data: string): { amount0: bigint; amount1: bigint } | null {
  const words = decodeTwoWords(data);
  if (words === null) return null;
  return { amount0: words.first, amount1: words.second };
}

/**
 * Chronological order for pair events.
 *
 * Block number first, then log index within the block. Timestamps are not sufficient on
 * their own: this chain produces blocks every ~0.1s and several share a timestamp, so
 * ordering by time alone would leave events in an arbitrary order relative to each other
 * and the "last state before a boundary" would stop being deterministic.
 */
export function compareEvents(a: PairEvent, b: PairEvent): number {
  if (a.blockNumber !== b.blockNumber) return a.blockNumber - b.blockNumber;
  return a.logIndex - b.logIndex;
}

export function orderEvents(events: readonly PairEvent[]): PairEvent[] {
  return [...events].sort(compareEvents);
}

/** Identity of an event occurrence, for detecting duplicates across page boundaries. */
export function eventKey(event: PairEvent): string {
  return `${event.pair.toLowerCase()}:${event.blockNumber}:${event.logIndex}`;
}

export interface ReconstructResult {
  /** Final reserves per pair, or absent when the pair never emitted a usable Sync. */
  readonly reserves: Map<string, Reserves>;
  readonly syncsApplied: number;
  readonly mintsSeen: number;
  readonly burnsSeen: number;
  readonly duplicates: number;
  readonly invalid: number;
}

/**
 * Replays events in order and returns the reserve state they leave behind.
 *
 * Duplicates are dropped by (pair, block, logIndex) rather than counted twice. With
 * absolute-valued Sync a duplicate is harmless to the final number, but it is still a
 * sign that a range was read twice, so it is reported.
 */
export function reconstruct(
  events: readonly PairEvent[],
  seed?: ReadonlyMap<string, Reserves>,
): ReconstructResult {
  const reserves = new Map<string, Reserves>(seed ?? []);
  const seen = new Set<string>();
  let syncsApplied = 0;
  let mintsSeen = 0;
  let burnsSeen = 0;
  let duplicates = 0;
  let invalid = 0;

  for (const event of orderEvents(events)) {
    const key = eventKey(event);
    if (seen.has(key)) {
      duplicates++;
      continue;
    }
    seen.add(key);

    const topic = event.topic0.toLowerCase();
    if (topic === MINT_TOPIC0) {
      if (decodeAmounts(event.data) === null) invalid++;
      else mintsSeen++;
      continue;
    }
    if (topic === BURN_TOPIC0) {
      if (decodeAmounts(event.data) === null) invalid++;
      else burnsSeen++;
      continue;
    }
    if (topic !== SYNC_TOPIC0) continue;

    const decoded = decodeSync(event.data);
    if (decoded === null) {
      // Left out rather than guessed at: the previous state stands, which is the last
      // thing actually known to be true.
      invalid++;
      continue;
    }
    reserves.set(event.pair.toLowerCase(), decoded);
    syncsApplied++;
  }

  return { reserves, syncsApplied, mintsSeen, burnsSeen, duplicates, invalid };
}

export interface BucketBoundary {
  readonly startTimestamp: number;
  /** Exclusive upper block of the bucket, matching the volume window's own boundaries. */
  readonly toBlock: number;
}

export interface PairSnapshot {
  readonly reserve0: bigint;
  readonly reserve1: bigint;
  /** True when this is the previous bucket's state carried forward unchanged. */
  readonly carried: boolean;
}

export interface BucketSnapshot {
  readonly startTimestamp: number;
  readonly perPair: ReadonlyMap<string, PairSnapshot>;
  /** Pairs with no known state at this point. Never counted as zero. */
  readonly unknownPairs: readonly string[];
}

/**
 * Hourly snapshots: for each boundary, the last state at or before it.
 *
 * Carrying the previous state forward is exact rather than an approximation — reserves
 * change only when a Sync fires, so an hour with no Sync genuinely ended where the last
 * one left it. What is NOT exact is a pair with no Sync at all yet, and that case is
 * reported as unknown rather than filled with a zero, because "held nothing" and "not
 * observed" are different claims.
 */
export interface SnapshotOptions {
  /** State known to hold before the first boundary. */
  readonly seed?: ReadonlyMap<string, Reserves>;
  /**
   * Set only when `events` covers the pair's entire history from block 0.
   *
   * With a genesis scan, a pair that has emitted no Sync yet is not an unknown — it is a
   * pair that provably held nothing. A Uniswap v2 pair starts at 0/0 and every operation
   * that moves reserves emits Sync, so "no Sync observed, over a complete scan" is an
   * observation of zero rather than an absence of data. That distinction is the whole
   * reason this is a flag and not a default: given a partial scan the same silence means
   * the opposite, and assuming zero there would invent history.
   */
  readonly genesisScan?: boolean;
}

export function buildSnapshots(
  events: readonly PairEvent[],
  boundaries: readonly BucketBoundary[],
  pairs: readonly string[],
  options: SnapshotOptions = {},
): BucketSnapshot[] {
  const { seed, genesisScan = false } = options;
  const ordered = orderEvents(events);
  const wanted = pairs.map((pair) => pair.toLowerCase());
  const state = new Map<string, Reserves>(seed ?? []);
  const touchedSince = new Set<string>();
  const seen = new Set<string>();

  const snapshots: BucketSnapshot[] = [];
  let cursor = 0;

  for (const boundary of [...boundaries].sort((a, b) => a.startTimestamp - b.startTimestamp)) {
    // Apply everything strictly before the bucket's exclusive upper block.
    while (cursor < ordered.length) {
      const event = ordered[cursor];
      if (event === undefined || event.blockNumber >= boundary.toBlock) break;
      cursor++;

      const key = eventKey(event);
      if (seen.has(key)) continue;
      seen.add(key);

      if (event.topic0.toLowerCase() !== SYNC_TOPIC0) continue;
      const decoded = decodeSync(event.data);
      if (decoded === null) continue;
      const pair = event.pair.toLowerCase();
      state.set(pair, decoded);
      touchedSince.add(pair);
    }

    const perPair = new Map<string, PairSnapshot>();
    const unknownPairs: string[] = [];
    for (const pair of wanted) {
      const current = state.get(pair);
      if (current === undefined) {
        // Over a genesis scan, silence means the pair had not been funded yet.
        if (genesisScan) {
          perPair.set(pair, { reserve0: 0n, reserve1: 0n, carried: true });
          continue;
        }
        unknownPairs.push(pair);
        continue;
      }
      perPair.set(pair, {
        reserve0: current.reserve0,
        reserve1: current.reserve1,
        carried: !touchedSince.has(pair),
      });
    }
    touchedSince.clear();

    snapshots.push({ startTimestamp: boundary.startTimestamp, perPair, unknownPairs });
  }

  return snapshots;
}

/** Which side of a pair holds WETH. Mirrors the volume path's own classification. */
export type WethSide = "token0" | "token1" | "none";

export interface LiquidityPoint {
  readonly startTimestamp: number;
  /** WETH held across qualifying pairs, in wei. */
  readonly wethReserve: bigint;
  /** Both sides of a balanced pool, so twice the WETH side. */
  readonly liquidityWei: bigint;
  readonly pairsCounted: number;
  /** True only when every qualifying pair had a known reserve at this point. */
  readonly complete: boolean;
}

/**
 * Aggregates the WETH side across qualifying pairs.
 *
 * Token/token pairs contribute nothing, exactly as they contribute nothing to volume —
 * valuing them would need a price for a third asset that Poolix does not have. A bucket
 * missing any qualifying pair's state is marked incomplete rather than summed short.
 */
export function aggregateWethLiquidity(
  snapshots: readonly BucketSnapshot[],
  sideOf: (pair: string) => WethSide | undefined,
): LiquidityPoint[] {
  return snapshots.map((snapshot) => {
    let wethReserve = 0n;
    let pairsCounted = 0;
    let missing = 0;

    for (const [pair, reserves] of snapshot.perPair) {
      const side = sideOf(pair);
      if (side === undefined) {
        missing++;
        continue;
      }
      if (side === "none") continue;
      wethReserve += side === "token0" ? reserves.reserve0 : reserves.reserve1;
      pairsCounted++;
    }

    // An unknown pair might be a WETH pair, so it cannot be dismissed.
    for (const pair of snapshot.unknownPairs) {
      if (sideOf(pair) !== "none") missing++;
    }

    return {
      startTimestamp: snapshot.startTimestamp,
      wethReserve,
      liquidityWei: wethReserve * 2n,
      pairsCounted,
      complete: missing === 0,
    };
  });
}
