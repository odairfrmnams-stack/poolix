import "server-only";

import { createPublicClient, getAddress, http, type PublicClient } from "viem";

import { poolixConfig } from "@/config/poolix";
import { workerLog } from "@/services/storage/log";
import { memoizeSnapshotRead, SNAPSHOT_TTL_MS } from "@/services/storage/snapshot-read";
import { analyticsStore } from "@/services/storage/storage";
import { isUniswapV2Available } from "@/config/resolve";
import { HISTORY_DAYS, windowBuckets, type HistoryTimeframe } from "@/services/analytics/history-math";
import { getBucketRanges } from "@/services/analytics/history-window";
import {
  aggregateWethLiquidity,
  buildSnapshots,
  BURN_TOPIC0,
  MINT_TOPIC0,
  reconstruct,
  SYNC_TOPIC0,
  type LiquidityPoint,
  type PairEvent,
} from "@/services/analytics/liquidity-math";
import { resolvePairSides } from "@/services/analytics/pair-sides";
import type { WethSide } from "@/services/analytics/swap-math";
import type { Address } from "@/types/web3";

/*
  Historical WETH liquidity, reconstructed from on-chain Sync events.

  Why this is affordable where historical volume was not. Volume needs every Swap on the
  chain — 3.7M events over 30 days. Liquidity only needs the pairs already in Poolix's
  scope, and HyperSync filters by address server-side. Measured on 2026-09-18 over 25
  scoped pairs: 5,177 Sync events across 7 days in 5 requests and 1.2MB, extrapolating to
  roughly 22,000 events and 5MB for 30 days. Seconds, not hours.

  Sync carries ABSOLUTE reserves (two uint112 words), confirmed against live payloads, so
  reserve state is read rather than accumulated. Mint and Burn are counted for reporting
  but are not needed: the Sync emitted alongside them already carries the result. That
  also makes the reconstruction self-correcting — a missed event is repaired by the next
  Sync instead of corrupting everything downstream, which a delta chain cannot do.

  Events are scanned from block 0 for each pair rather than from the window start. A pair
  whose first Sync lands inside the window would otherwise need a seed from before it, and
  guessing that seed is exactly the kind of invention this project refuses. From genesis
  there is nothing to guess.

  SCOPE LIMITATION, stated rather than buried: the pairs are the ones Poolix's scan holds
  TODAY. This is the history of today's pool set, not a reconstruction of what Poolix
  would have displayed a month ago — a pool that has since dropped out of the scanned
  window is absent from the whole series, and one added yesterday is present across it.
*/

const HYPERSYNC_URL = "https://4663.hypersync.xyz/query";

const BACKOFF_MS = [1_000, 2_500, 6_000, 12_000];
const TICK_BUDGET_MS = 25_000;
const STATE_VERSION = 1;
/** Refresh cadence once the series is built. */
const REFRESH_MS = 120_000;

interface StoredPoint {
  startTimestamp: number;
  wethReserveWei: string;
  liquidityWei: string;
  pairsCounted: number;
  complete: boolean;
}

interface PersistedState {
  version: number;
  chainId: number;
  /** Aggregated hourly points, keyed by bucket start. */
  points: Record<string, StoredPoint>;
  /** The pair set the series was built from, recorded so drift is visible. */
  pairs: string[];
  pairSides: Record<string, WethSide>;
  syncsProcessed: number;
  mintsSeen: number;
  burnsSeen: number;
  duplicates: number;
  /** Events whose payload could not be decoded. Surfaced so a silent loss is visible. */
  invalid: number;
  /** Events fetched, before decoding. */
  eventsFetched: number;
  /** Highest block scanned for events. */
  scannedTo: number;
  updatedAt: number;
}

export interface LiquidityWindowTotals {
  readonly complete: boolean;
  readonly bucketsPresent: number;
  readonly bucketsExpected: number;
  /** Latest point in the window. */
  readonly latestWei: bigint;
  readonly minWei: bigint;
  readonly maxWei: bigint;
  readonly points: readonly { startTimestamp: number; liquidityWei: bigint; complete: boolean }[];
}

export interface LiquidityHistorySummary {
  readonly available: boolean;
  readonly totals: Readonly<Record<HistoryTimeframe, LiquidityWindowTotals>>;
  readonly pairsTracked: number;
  /**
   * The exact pairs this series was built from.
   *
   * Exposed so the APR fee series can be gathered over the same set rather than
   * rediscovering it. Fees and liquidity must describe the same pools or their ratio is
   * not an APR of anything — sharing the list makes that structural instead of a
   * coincidence that holds until the pool scan shifts.
   */
  readonly pairs: readonly string[];
  readonly syncsProcessed: number;
  readonly mintsSeen: number;
  readonly burnsSeen: number;
  readonly duplicates: number;
  readonly updatedAt: number | null;
  /** True while points are still being built. */
  readonly building: boolean;
}

const emptyTotals: LiquidityWindowTotals = {
  complete: false,
  bucketsPresent: 0,
  bucketsExpected: 0,
  latestWei: 0n,
  minWei: 0n,
  maxWei: 0n,
  points: [],
};

const EMPTY: LiquidityHistorySummary = {
  available: false,
  totals: { "7D": emptyTotals, "30D": emptyTotals },
  pairsTracked: 0,
  pairs: [],
  syncsProcessed: 0,
  mintsSeen: 0,
  burnsSeen: 0,
  duplicates: 0,
  updatedAt: null,
  building: false,
};

const token = () => process.env.ENVIO_API_TOKEN?.trim() ?? "";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- persistence

function emptyState(): PersistedState {
  return {
    version: STATE_VERSION,
    chainId: poolixConfig.chain.id,
    points: {},
    pairs: [],
    pairSides: {},
    syncsProcessed: 0,
    mintsSeen: 0,
    burnsSeen: 0,
    duplicates: 0,
    invalid: 0,
    eventsFetched: 0,
    scannedTo: 0,
    updatedAt: 0,
  };
}

/*
  Persistence goes through the storage layer rather than straight to a file.

  The key, the schema check and the atomic write all live in one place now, so this module
  no longer carries its own copy of "what does an unreadable cache mean". The answer is
  unchanged and deliberate: discard and rebuild. Every dataset here is derived from
  HyperSync and the chain, so a doubtful cache costs time to replace, while reinterpreting
  one costs correctness in a number someone acts on.
*/
const store = analyticsStore<PersistedState>(
  "liquidity-history",
  STATE_VERSION,
  poolixConfig.chain.id,
  (value: unknown): value is PersistedState =>
    typeof value === "object" && value !== null && typeof (value as PersistedState).points === "object",
);

async function loadState(): Promise<PersistedState> {
  const result = await store.load();
  if (result.value === null) {
    // "missing" is an ordinary cold start; anything else means state was thrown away and
    // is worth saying out loud rather than silently rebuilding.
    if (result.outcome !== "missing") {
      workerLog.warn({ dataset: "liquidity-history", reason: "load", error: result.detail });
    }
    return emptyState();
  }
  const state = result.value;
  return {
    ...emptyState(),
    ...state,
    points: state.points ?? {},
    pairSides: state.pairSides ?? {},
  };
}

async function saveState(state: PersistedState): Promise<void> {
  await store.save(state);
}

// ------------------------------------------------------------------ hypersync

/** One request, backing off on rate limiting rather than failing the tick. */
async function post(body: unknown): Promise<Record<string, unknown> | null> {
  for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {
    try {
      const res = await fetch(HYPERSYNC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token()}` },
        body: JSON.stringify(body),
      });
      if (res.status === 429 || res.status === 503) {
        const wait = BACKOFF_MS[attempt];
        if (wait === undefined) return null;
        await sleep(wait);
        continue;
      }
      if (!res.ok) return null;
      return (await res.json()) as Record<string, unknown>;
    } catch {
      const wait = BACKOFF_MS[attempt];
      if (wait === undefined) return null;
      await sleep(wait);
    }
  }
  return null;
}

interface RawLog {
  address: string;
  block_number: number;
  log_index: number;
  topic0?: string;
  data: string;
}

/**
 * Every Sync, Mint and Burn emitted by the scoped pairs in a block range.
 *
 * Restricted to those addresses, which is what makes the whole of history affordable:
 * chain-wide these three events run to millions, but across 25 pairs they are thousands.
 */
async function fetchPairEvents(
  pairs: readonly string[],
  fromBlock: number,
  toBlock: number,
  deadline: number,
): Promise<{ events: PairEvent[]; complete: boolean; reached: number }> {
  const events: PairEvent[] = [];
  let cursor = fromBlock;

  while (cursor < toBlock) {
    if (Date.now() >= deadline) return { events, complete: false, reached: cursor };

    const json = await post({
      from_block: cursor,
      to_block: toBlock,
      logs: [{ address: [...pairs], topics: [[SYNC_TOPIC0, MINT_TOPIC0, BURN_TOPIC0]] }],
      field_selection: { log: ["block_number", "log_index", "address", "topic0", "data"] },
    });
    if (json === null) return { events, complete: false, reached: cursor };

    const batches = (json.data ?? []) as { logs?: RawLog[] }[];
    for (const batch of batches) {
      for (const log of batch.logs ?? []) {
        events.push({
          pair: log.address.toLowerCase(),
          blockNumber: log.block_number,
          logIndex: log.log_index,
          topic0: (log.topic0 ?? "").toLowerCase(),
          data: log.data,
        });
      }
    }

    const next = (json.next_block as number | undefined) ?? toBlock;
    if (next <= cursor) return { events, complete: false, reached: cursor };
    cursor = Math.min(next, toBlock);
  }

  return { events, complete: true, reached: cursor };
}

// ----------------------------------------------------------------------- tick

let inFlight: Promise<LiquidityHistorySummary> | null = null;
let cached: { at: number; value: LiquidityHistorySummary } | null = null;

function summarise(state: PersistedState): LiquidityHistorySummary {
  const nowTimestamp = Math.floor(Date.now() / 1000);
  const totals = {} as Record<HistoryTimeframe, LiquidityWindowTotals>;

  for (const frame of Object.keys(HISTORY_DAYS) as HistoryTimeframe[]) {
    const wanted = windowBuckets(nowTimestamp, HISTORY_DAYS[frame]);
    const points: { startTimestamp: number; liquidityWei: bigint; complete: boolean }[] = [];
    let present = 0;
    let min: bigint | null = null;
    let max: bigint | null = null;
    let latest = 0n;

    for (const start of wanted) {
      const stored = state.points[String(start)];
      if (stored === undefined) continue;
      present++;
      const value = BigInt(stored.liquidityWei);
      points.push({ startTimestamp: start, liquidityWei: value, complete: stored.complete });
      if (stored.complete) {
        if (min === null || value < min) min = value;
        if (max === null || value > max) max = value;
        latest = value;
      }
    }

    const allComplete = present === wanted.length && points.every((point) => point.complete);
    totals[frame] = {
      complete: allComplete && wanted.length > 0,
      bucketsPresent: present,
      bucketsExpected: wanted.length,
      latestWei: latest,
      minWei: min ?? 0n,
      maxWei: max ?? 0n,
      points,
    };
  }

  return {
    available: true,
    totals,
    pairsTracked: state.pairs.length,
    pairs: state.pairs,
    syncsProcessed: state.syncsProcessed,
    mintsSeen: state.mintsSeen,
    burnsSeen: state.burnsSeen,
    duplicates: state.duplicates,
    updatedAt: state.updatedAt || null,
    building: !(totals["30D"]?.complete ?? false),
  };
}

async function runTick(): Promise<LiquidityHistorySummary> {
  if (token() === "") return EMPTY;

  const state = await loadState();
  const persisted = () => (state.updatedAt === 0 ? EMPTY : summarise(state));

  // The same hour grid the volume buckets use, so a liquidity point and a volume bar
  // always describe the same hour.
  const ranges = await getBucketRanges();
  if (ranges.length === 0) return persisted();

  const discovery = isUniswapV2Available(poolixConfig)
    ? await import("@/services/pools/discovery").then((m) => m.discoverPools())
    : { pools: [], totalPairs: 0, scanned: 0, complete: false };

  const pairs = [...new Set(discovery.pools.map((pool) => pool.address.toLowerCase()))];
  if (pairs.length === 0) return persisted();

  const deadline = Date.now() + TICK_BUDGET_MS;
  const rpcUrl = process.env.RPC_URL?.trim() || poolixConfig.rpcUrl;
  const client = createPublicClient({ transport: http(rpcUrl, { batch: { wait: 16 } }) }) as PublicClient;

  // Classify any pair not yet known, using the same rule the volume path uses.
  const unclassified = pairs.filter((pair) => state.pairSides[pair] === undefined);
  if (unclassified.length > 0) {
    const resolved = await resolvePairSides(client, unclassified.map((p) => getAddress(p) as Address));
    for (const [pair, side] of resolved) state.pairSides[pair] = side;
  }

  const highest = ranges[ranges.length - 1]?.toBlock ?? 0;

  /*
    From block 0, not from the window start. A pair whose first Sync falls inside the
    window would otherwise need a seed from before it, and there is no honest way to
    invent one. Scoped to these pairs the whole of history is a few thousand events.

    A changed pair set restarts the scan, because a newly added pair has no history in
    the store and carrying the old points forward would silently exclude it.
  */
  /*
    Always from block 0, every tick. Never incremental.

    An incremental fetch would hand buildSnapshots only the new events, so a pair whose
    entire history predates the fetch would look like it had none — and the genesis rule
    below, which reads silence as zero, would then be reading a partial scan and inventing
    zeroes. Keeping the scan whole makes that impossible to get wrong.

    It is affordable precisely because the scope is small: measured at ~3,000 events and
    about 15 seconds across the 25 pairs, against the hours a chain-wide sweep would take.
  */
  const from = 0;
  state.points = {};
  state.syncsProcessed = 0;
  state.mintsSeen = 0;
  state.burnsSeen = 0;
  state.duplicates = 0;
  state.invalid = 0;
  state.eventsFetched = 0;

  const fetched = await fetchPairEvents(pairs, from, highest, deadline);
  // A partial read is discarded: snapshots built from half a range would carry a stale
  // state forward as though it were current.
  if (!fetched.complete) return persisted();

  const tally = reconstruct(fetched.events);
  state.syncsProcessed += tally.syncsApplied;
  state.mintsSeen += tally.mintsSeen;
  state.burnsSeen += tally.burnsSeen;
  state.duplicates += tally.duplicates;
  state.invalid += tally.invalid;
  state.eventsFetched += fetched.events.length;

  const snapshots = buildSnapshots(
    fetched.events,
    ranges.map((range) => ({ startTimestamp: range.startTimestamp, toBlock: range.toBlock })),
    pairs,
    // The fetch above starts at block 0, which is what makes a pair's silence an
    // observed zero rather than an unknown.
    { genesisScan: from === 0 },
  );
  const points = aggregateWethLiquidity(snapshots, (pair) => state.pairSides[pair]);

  for (const point of points) {
    state.points[String(point.startTimestamp)] = {
      startTimestamp: point.startTimestamp,
      wethReserveWei: point.wethReserve.toString(),
      liquidityWei: point.liquidityWei.toString(),
      pairsCounted: point.pairsCounted,
      complete: point.complete,
    };
  }

  // Retention follows the volume window: anything it has dropped is dropped here too.
  const keep = new Set(ranges.map((range) => String(range.startTimestamp)));
  for (const key of Object.keys(state.points)) {
    if (!keep.has(key)) delete state.points[key];
  }

  state.pairs = pairs;
  state.scannedTo = highest;
  state.updatedAt = Date.now();
  await saveState(state);

  return summarise(state);
}

/**
 * Rebuilds or refreshes the historical liquidity series.
 * Concurrent callers share one tick, and a fresh result stands briefly.
 */
/**
 * The liquidity series from persisted state, without ticking. See `readHistory` for why
 * this mirrors the tick's own fallback rather than introducing a second projection.
 */
let liquidityMemo: (() => Promise<LiquidityHistorySummary>) | null = null;

export async function readLiquidityHistory(): Promise<LiquidityHistorySummary> {
  liquidityMemo ??= memoizeSnapshotRead(async () => {
    const state = await loadState();
    return state.updatedAt === 0 ? EMPTY : summarise(state);
  }, SNAPSHOT_TTL_MS);
  return liquidityMemo();
}

export async function getLiquidityHistory(): Promise<LiquidityHistorySummary> {
  if (cached !== null && Date.now() - cached.at < REFRESH_MS) return cached.value;
  if (inFlight !== null) return inFlight;

  inFlight = runTick()
    .then((value) => {
      cached = { at: Date.now(), value };
      return value;
    })
    .catch((error: unknown) => {
      console.error("[liquidity-history] tick failed:", error instanceof Error ? error.message : error);
      return EMPTY;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

export type { LiquidityPoint };
