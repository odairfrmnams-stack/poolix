import "server-only";

import { createPublicClient, getAddress, http, type PublicClient } from "viem";

import { poolixConfig } from "@/config/poolix";
import { workerLog } from "@/services/storage/log";
import { memoizeSnapshotRead, SNAPSHOT_TTL_MS } from "@/services/storage/snapshot-read";
import { analyticsStore } from "@/services/storage/storage";
import {
  BUCKET_SECONDS,
  bucketStartFor,
  estimateBlockAt,
  HISTORY_DAYS,
  retainedStarts,
  toSeries,
  totalWindow,
  windowBuckets,
  type HistoryBucket,
  type HistoryTimeframe,
  type SeriesPoint,
  type WindowTotals,
} from "@/services/analytics/history-math";
import { resolvePairSides } from "@/services/analytics/pair-sides";
import { aggregateWethVolume, SWAP_TOPIC0, type WethSide } from "@/services/analytics/swap-math";
import type { Address } from "@/types/web3";

/*
  Historical Uniswap v2 swap volume, in hourly buckets, for the 7D and 30D timeframes.

  This is an extension, not a replacement. The 24h figure keeps running on
  services/analytics/swap-window.ts exactly as before, with its own state file and its own
  block-based window; nothing here changes what that number means. The two share one pair
  classifier so "ETH-side volume" cannot come to mean two different things.

  Measured before building, on 2026-09-18:

    block time      0.1006-0.1013s, stable across 1h / 24h / 7D / 30D spans
    1h at head      ~10 requests, ~10,000 swaps, 3.5MB, ~9s
    1h at -7D       ~11 requests, ~11,500 swaps, 4.0MB, ~7s
    1h at -30D      ~3 requests,  ~3,200 swaps,  1.1MB, ~3s

  Extrapolated, a full 30-day sweep is on the order of 5,000 requests, ~5M swaps and over
  a gigabyte. That is a background job measured in tens of minutes, not a page render, so
  the same bounded-tick pattern the 24h window uses applies here: each tick fills as many
  buckets as its budget allows, newest first, and the work resumes across restarts.

  Newest-first matters. It means 7D completes long before 30D, so the shorter timeframe
  becomes available while the longer one is still filling, rather than both arriving at
  the end.

  Asking HyperSync for each log's timestamp was measured at 53% extra payload. Instead
  each hour's boundary is resolved to a block once — the answer never changes — and swaps
  are filed by block number into those ranges. The window is therefore defined in real
  time while the ingestion stays as cheap as the 24h path.
*/

const HYPERSYNC_URL = "https://4663.hypersync.xyz/query";
const HEIGHT_URL = "https://4663.hypersync.xyz/height";

/** Measured on this chain; only ever a seed for boundary search, never a source of truth. */
const NOMINAL_BLOCK_SECONDS = 0.1007;
const MAX_DAYS = 30;
/** Block headers fetched around an estimate when pinning an hour boundary. */
const BOUNDARY_PROBE_BLOCKS = 900;
const BOUNDARY_MAX_ATTEMPTS = 6;
const TICK_BUDGET_MS = 20_000;

const STATE_VERSION = 1;

interface StoredBucket {
  startTimestamp: number;
  endTimestamp: number;
  fromBlock: number;
  toBlock: number;
  volumeWei: string;
  swaps: number;
  ignoredNonWeth: number;
  unresolvedSwaps: number;
}

interface PersistedState {
  version: number;
  chainId: number;
  /** Completed hourly buckets, keyed by start timestamp. */
  buckets: Record<string, StoredBucket>;
  /** Hour start -> first block at or after it. Immutable once resolved. */
  boundaries: Record<string, number>;
  pairSides: Record<string, WethSide>;
  /** Totals across the life of the store, for reporting. */
  swapsProcessed: number;
  bucketsIngested: number;
  updatedAt: number;
}

export interface HistorySummary {
  readonly available: boolean;
  /** Per-timeframe totals, each reporting its own coverage. */
  readonly totals: Readonly<Record<HistoryTimeframe, WindowTotals>>;
  readonly series: Readonly<Record<HistoryTimeframe, readonly SeriesPoint[]>>;
  readonly bucketsStored: number;
  readonly swapsProcessed: number;
  readonly latestBlock: number | null;
  readonly updatedAt: number | null;
  /** True while buckets are still being filled in. */
  readonly bootstrapping: boolean;
}

const emptyTotals: WindowTotals = {
  volumeWei: 0n,
  feesWei: 0n,
  swaps: 0,
  ignoredNonWeth: 0,
  unresolvedSwaps: 0,
  bucketsPresent: 0,
  bucketsExpected: 0,
  missing: [],
  complete: false,
};

const EMPTY: HistorySummary = {
  available: false,
  totals: { "7D": emptyTotals, "30D": emptyTotals },
  series: { "7D": [], "30D": [] },
  bucketsStored: 0,
  swapsProcessed: 0,
  latestBlock: null,
  updatedAt: null,
  bootstrapping: false,
};

const token = () => process.env.ENVIO_API_TOKEN?.trim() ?? "";

// ---------------------------------------------------------------- persistence

function emptyState(): PersistedState {
  return {
    version: STATE_VERSION,
    chainId: poolixConfig.chain.id,
    buckets: {},
    boundaries: {},
    pairSides: {},
    swapsProcessed: 0,
    bucketsIngested: 0,
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
  "history",
  STATE_VERSION,
  poolixConfig.chain.id,
  (value: unknown): value is PersistedState =>
    typeof value === "object" && value !== null && typeof (value as PersistedState).buckets === "object",
);

async function loadState(): Promise<PersistedState> {
  const result = await store.load();
  if (result.value === null) {
    // "missing" is an ordinary cold start; anything else means state was thrown away and
    // is worth saying out loud rather than silently rebuilding.
    if (result.outcome !== "missing") {
      workerLog.warn({ dataset: "history", reason: "load", error: result.detail });
    }
    return emptyState();
  }
  const state = result.value;
  return {
    ...emptyState(),
    ...state,
    buckets: state.buckets ?? {},
    boundaries: state.boundaries ?? {},
    pairSides: state.pairSides ?? {},
  };
}

async function saveState(state: PersistedState): Promise<void> {
  await store.save(state);
}

// ------------------------------------------------------------------ hypersync

interface BlockRow {
  number?: number;
  timestamp?: string | number;
}

const asSeconds = (value: string | number | undefined): number | null => {
  if (value === undefined) return null;
  try {
    const n = typeof value === "string" ? Number(BigInt(value)) : value;
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
};

/** Rate-limit backoff, doubling. A refused burst is normal on the free tier. */
const BACKOFF_MS = [1_000, 2_500, 6_000, 12_000];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One HyperSync request, with backoff on rate limiting.
 *
 * A 429 is waited out rather than treated as a failure, because failing here would end
 * the tick and the next one would arrive just as fast — hammering the endpoint that just
 * asked us to slow down. Every other error returns null, which the callers treat as "this
 * range is not complete", so nothing partial is ever persisted and the next tick resumes
 * from whatever is already on disk rather than restarting the sweep.
 */
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
        rateLimitHits++;
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

/** Counted across the process so a caller can report how hard it was throttled. */
let rateLimitHits = 0;

export function rateLimitCount(): number {
  return rateLimitHits;
}

async function fetchHeight(): Promise<number | null> {
  try {
    const res = await fetch(HEIGHT_URL, { next: { revalidate: 30 } });
    if (!res.ok) return null;
    const json = (await res.json()) as { height?: number };
    return typeof json.height === "number" ? json.height : null;
  } catch {
    return null;
  }
}

/** Block headers in a range, used only for pinning hour boundaries. */
async function fetchBlocks(fromBlock: number, toBlock: number): Promise<BlockRow[]> {
  const json = await post({
    from_block: Math.max(0, fromBlock),
    to_block: toBlock,
    include_all_blocks: true,
    field_selection: { block: ["number", "timestamp"] },
  });
  if (json === null) return [];
  const batches = (json.data ?? []) as { blocks?: BlockRow[] }[];
  return batches.flatMap((batch) => batch.blocks ?? []);
}

/**
 * The first block at or after a timestamp.
 *
 * Estimates from the measured block rate, then reads real headers around the estimate and
 * walks toward the answer. The estimate is never trusted on its own: a boundary that is a
 * few hundred blocks out would misfile roughly a minute of swaps into the neighbouring
 * hour, which is exactly the drift this design exists to avoid.
 */
async function resolveBoundary(
  targetTimestamp: number,
  referenceBlock: number,
  referenceTimestamp: number,
): Promise<number | null> {
  let guess = estimateBlockAt(targetTimestamp, referenceBlock, referenceTimestamp, NOMINAL_BLOCK_SECONDS);

  for (let attempt = 0; attempt < BOUNDARY_MAX_ATTEMPTS; attempt++) {
    const from = Math.max(0, guess - Math.floor(BOUNDARY_PROBE_BLOCKS / 2));
    const rows = await fetchBlocks(from, from + BOUNDARY_PROBE_BLOCKS);
    if (rows.length === 0) return null;

    const points = rows
      .map((row) => ({ number: row.number ?? -1, timestamp: asSeconds(row.timestamp) }))
      .filter((point): point is { number: number; timestamp: number } =>
        point.number >= 0 && point.timestamp !== null,
      )
      .sort((a, b) => a.number - b.number);

    const first = points[0];
    const last = points[points.length - 1];
    if (first === undefined || last === undefined) return null;

    // The window brackets the target: the answer is inside it.
    if (first.timestamp <= targetTimestamp && last.timestamp >= targetTimestamp) {
      const hit = points.find((point) => point.timestamp >= targetTimestamp);
      return hit?.number ?? null;
    }

    // Otherwise step toward the target using the rate this window actually showed.
    const span = last.number - first.number;
    const elapsed = last.timestamp - first.timestamp;
    const rate = span > 0 && elapsed > 0 ? elapsed / span : NOMINAL_BLOCK_SECONDS;
    guess = estimateBlockAt(targetTimestamp, last.number, last.timestamp, rate);
  }

  return null;
}

// ----------------------------------------------------------------- ingestion

interface RangeResult {
  readonly volumeWei: bigint;
  readonly swaps: number;
  readonly ignoredNonWeth: number;
  readonly unresolvedSwaps: number;
  readonly complete: boolean;
}

/**
 * Reads one block range and aggregates it.
 *
 * The range is half-open, so consecutive buckets share a boundary block without either
 * counting it twice — which is what keeps the chunk seams free of both duplicates and
 * holes. A partial read returns `complete: false` and the caller discards it rather than
 * persisting a bucket built from part of its hour.
 */
async function collectRange(
  state: PersistedState,
  client: PublicClient,
  fromBlock: number,
  toBlock: number,
  deadline: number,
): Promise<RangeResult> {
  let volumeWei = 0n;
  let swaps = 0;
  let ignoredNonWeth = 0;
  let unresolvedSwaps = 0;
  let cursor = fromBlock;

  while (cursor < toBlock) {
    if (Date.now() >= deadline) {
      return { volumeWei, swaps, ignoredNonWeth, unresolvedSwaps, complete: false };
    }

    const json = await post({
      from_block: cursor,
      to_block: toBlock,
      logs: [{ topics: [[SWAP_TOPIC0]] }],
      field_selection: { log: ["block_number", "address", "data"] },
    });
    if (json === null) return { volumeWei, swaps, ignoredNonWeth, unresolvedSwaps, complete: false };

    const batches = (json.data ?? []) as { logs?: { address: string; data: string }[] }[];
    const logs = batches.flatMap((batch) => batch.logs ?? []);

    // Classify unseen pairs before aggregating, so no swap is silently skipped.
    const unknown = [...new Set(logs.map((log) => log.address.toLowerCase()))].filter(
      (pair) => state.pairSides[pair] === undefined,
    );
    if (unknown.length > 0) {
      const resolved = await resolvePairSides(client, unknown.map((pair) => getAddress(pair) as Address));
      for (const [pair, side] of resolved) state.pairSides[pair] = side;
    }

    const result = aggregateWethVolume(logs, (pair) => state.pairSides[pair]);
    volumeWei += result.volumeWei;
    swaps += result.counted;
    ignoredNonWeth += result.ignoredNonWeth;
    unresolvedSwaps += result.unresolvedPairs + result.undecodable;

    const next = (json.next_block as number | undefined) ?? toBlock;
    if (next <= cursor) return { volumeWei, swaps, ignoredNonWeth, unresolvedSwaps, complete: false };
    cursor = Math.min(next, toBlock);
  }

  return { volumeWei, swaps, ignoredNonWeth, unresolvedSwaps, complete: true };
}

// ----------------------------------------------------------------------- tick

let inFlight: Promise<HistorySummary> | null = null;

function storedToBucket(stored: StoredBucket): HistoryBucket {
  return {
    startTimestamp: stored.startTimestamp,
    endTimestamp: stored.endTimestamp,
    fromBlock: stored.fromBlock,
    toBlock: stored.toBlock,
    volumeWei: BigInt(stored.volumeWei),
    swaps: stored.swaps,
    ignoredNonWeth: stored.ignoredNonWeth,
    unresolvedSwaps: stored.unresolvedSwaps,
  };
}

function summarise(state: PersistedState, nowTimestamp: number, height: number | null): HistorySummary {
  const buckets = new Map<number, HistoryBucket>();
  for (const stored of Object.values(state.buckets)) {
    buckets.set(stored.startTimestamp, storedToBucket(stored));
  }

  const starts7 = windowBuckets(nowTimestamp, HISTORY_DAYS["7D"]);
  const starts30 = windowBuckets(nowTimestamp, HISTORY_DAYS["30D"]);

  const totals7 = totalWindow(buckets, starts7);
  const totals30 = totalWindow(buckets, starts30);

  return {
    available: true,
    totals: { "7D": totals7, "30D": totals30 },
    series: {
      // 7 days at hourly resolution; 30 days grouped into days from the same store.
      "7D": toSeries(buckets, starts7, BUCKET_SECONDS),
      "30D": toSeries(buckets, starts30, 86_400),
    },
    bucketsStored: buckets.size,
    swapsProcessed: state.swapsProcessed,
    latestBlock: height,
    updatedAt: state.updatedAt || null,
    bootstrapping: !totals30.complete,
  };
}

async function runTick(): Promise<HistorySummary> {
  if (token() === "") return EMPTY;

  /*
    Everything already ingested is reported even when this tick cannot reach the indexer.

    Returning EMPTY on a transient failure would blank a window that is sitting complete
    on disk — the free tier rate-limits bursts, so a refused head read is an ordinary
    event, not a reason to claim there is no data.
  */
  const state = await loadState();
  const persisted = () =>
    state.updatedAt === 0 ? EMPTY : summarise(state, Math.floor(Date.now() / 1000), null);

  const height = await fetchHeight();
  if (height === null) return persisted();

  // The chain's own clock, not the server's, so boundaries line up with block timestamps.
  const headRows = await fetchBlocks(height - 3, height);
  const headPoint = headRows
    .map((row) => ({ number: row.number ?? -1, timestamp: asSeconds(row.timestamp) }))
    .filter((p): p is { number: number; timestamp: number } => p.number >= 0 && p.timestamp !== null)
    .sort((a, b) => b.number - a.number)[0];
  if (headPoint === undefined) return persisted();

  const deadline = Date.now() + TICK_BUDGET_MS;
  const nowTimestamp = headPoint.timestamp;

  const rpcUrl = process.env.RPC_URL?.trim() || poolixConfig.rpcUrl;
  const client = createPublicClient({ transport: http(rpcUrl, { batch: { wait: 16 } }) }) as PublicClient;

  /*
    Newest first. The most recent missing hour is filled before older ones, so 7D reaches
    completeness while 30D is still filling, and a freshly elapsed hour is never left
    behind older backfill work.
  */
  const wanted = windowBuckets(nowTimestamp, MAX_DAYS);
  const pending = wanted.filter((start) => state.buckets[String(start)] === undefined).reverse();

  for (const start of pending) {
    if (Date.now() >= deadline) break;

    const end = start + BUCKET_SECONDS;
    const fromBlock = await boundaryFor(state, start, headPoint);
    if (fromBlock === null) continue;
    const toBlock = await boundaryFor(state, end, headPoint);
    if (toBlock === null || toBlock <= fromBlock) continue;

    const result = await collectRange(state, client, fromBlock, toBlock, deadline);
    // Only a fully read hour is persisted; a partial one would be indistinguishable from
    // a quiet hour once stored.
    if (!result.complete) break;

    state.buckets[String(start)] = {
      startTimestamp: start,
      endTimestamp: end,
      fromBlock,
      toBlock,
      volumeWei: result.volumeWei.toString(),
      swaps: result.swaps,
      ignoredNonWeth: result.ignoredNonWeth,
      unresolvedSwaps: result.unresolvedSwaps,
    };
    state.swapsProcessed += result.swaps;
    state.bucketsIngested += 1;
  }

  // Retention: 30 days plus a small buffer, so the store cannot grow without bound.
  const cutoff = retainedStarts(nowTimestamp, MAX_DAYS);
  for (const key of Object.keys(state.buckets)) {
    if (Number(key) < cutoff) delete state.buckets[key];
  }
  for (const key of Object.keys(state.boundaries)) {
    if (Number(key) < cutoff) delete state.boundaries[key];
  }

  state.updatedAt = Date.now();
  await saveState(state);
  return summarise(state, nowTimestamp, height);
}

/** Resolves and caches an hour boundary. The block for a given hour never changes. */
async function boundaryFor(
  state: PersistedState,
  timestamp: number,
  head: { number: number; timestamp: number },
): Promise<number | null> {
  const key = String(timestamp);
  const cached = state.boundaries[key];
  if (cached !== undefined) return cached;

  const block = await resolveBoundary(timestamp, head.number, head.timestamp);
  if (block === null) return null;
  state.boundaries[key] = block;
  return block;
}

/**
 * Advances the historical window by one bounded tick and returns the 7D and 30D totals.
 * Concurrent callers share a tick, so page renders cannot stack sweeps.
 */
/**
 * The history series from persisted state, without ticking.
 *
 * The same projection `runTick` falls back to when the chain cannot be reached — so this
 * is not a new code path with new semantics, it is the existing one made callable. A page
 * render uses it; the worker still calls `getHistory` to advance the series.
 *
 * `latestBlock` is null because no height was read. That is honest: the caller asked for
 * what is on disk, and the page renders "--" rather than a block number nobody fetched.
 */
let historyMemo: (() => Promise<HistorySummary>) | null = null;

export async function readHistory(): Promise<HistorySummary> {
  historyMemo ??= memoizeSnapshotRead(async () => {
    const state = await loadState();
    return state.updatedAt === 0 ? EMPTY : summarise(state, Math.floor(Date.now() / 1000), null);
  }, SNAPSHOT_TTL_MS);
  return historyMemo();
}

export async function getHistory(): Promise<HistorySummary> {
  if (inFlight !== null) return inFlight;
  inFlight = runTick()
    .catch((error: unknown) => {
      // Reported rather than swallowed. A tick that fails silently looks exactly like a
      // tick that found nothing, which makes an ingestion fault invisible for as long as
      // it lasts — the figure just never appears and nothing says why.
      console.error("[history] tick failed:", error instanceof Error ? error.message : error);
      return EMPTY;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/** Current hour boundary, exported so the verifier can align with the same grid. */
export function currentBucketStart(nowTimestamp: number): number {
  return bucketStartFor(nowTimestamp);
}

export interface BucketBlockRange {
  readonly startTimestamp: number;
  readonly fromBlock: number;
  /** Exclusive. The first block of the following hour. */
  readonly toBlock: number;
}

/**
 * The hour-to-block grid this window has already resolved, oldest first.
 *
 * Exported so historical liquidity snapshots land on exactly the same boundaries as the
 * volume buckets. Re-deriving them there would mean two grids that agree only by
 * coincidence, and a liquidity point could then describe a different hour than the volume
 * bar drawn beside it.
 */
export async function getBucketRanges(): Promise<BucketBlockRange[]> {
  const state = await loadState();
  return Object.values(state.buckets)
    .map((bucket) => ({
      startTimestamp: bucket.startTimestamp,
      fromBlock: bucket.fromBlock,
      toBlock: bucket.toBlock,
    }))
    .sort((a, b) => a.startTimestamp - b.startTimestamp);
}
