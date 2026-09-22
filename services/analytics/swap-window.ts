import "server-only";

import { createPublicClient, getAddress, http, type PublicClient } from "viem";

import { poolixConfig } from "@/config/poolix";
import { workerLog } from "@/services/storage/log";
import { analyticsStore } from "@/services/storage/storage";
import { resolvePairSides } from "@/services/analytics/pair-sides";
import {
  aggregateWethVolume,
  bucketOf,
  reconciliationTargets,
  SWAP_TOPIC0,
  tradingFeesWei,
  type SwapLogLike,
  type WethSide,
} from "@/services/analytics/swap-math";

/*
  A rolling 24h window of Uniswap v2 Swap volume, denominated in WETH.

  Measured on 2026-09-17: a full 24h sweep is 117,006 events over 103 requests, ~70s and
  39MB. That cannot run inside a page render — Next caps prerendering at 60s, and the
  free HyperSync tier rate-limits sustained bursts. So the window is built the other way
  round:

    bootstrap   each tick spends a bounded budget walking `tail` backwards toward -24h
    incremental once caught up, each tick only reads blocks after `head` (~1 request)

  State lives in a JSON file so a restart does not trigger another 70s bootstrap. Volume
  is bucketed by block range, which is what lets stale buckets age out of the window
  without re-reading anything.
*/

const HYPERSYNC_URL = "https://4663.hypersync.xyz/query";
const HEIGHT_URL = "https://4663.hypersync.xyz/height";

/** ~0.1s blocks on this chain. */
const WINDOW_BLOCKS = 864_000; // 24h
const BUCKET_BLOCKS = 7_200; // ~12 minutes
const TICK_BUDGET_MS = 18_000; // stays under Next's 60s prerender ceiling
const BOOTSTRAP_CHUNK = 60_000; // blocks requested per backward step
/**
 * Buckets re-read per tick to recover unattributed swaps.
 *
 * One bucket is ~7,200 blocks, a single page on this indexer, so a handful per tick repairs
 * the window within minutes without competing with the forward catch-up that keeps it
 * current. Bounded rather than exhaustive: the point is that the backlog drains steadily,
 * not that it clears in one pass.
 */
const MAX_RECONCILE_PER_TICK = 3;


const STATE_VERSION = 1;

interface Bucket {
  readonly volumeWei: string;
  readonly swaps: number;
  readonly ignoredNonWeth: number;
  readonly unresolvedSwaps: number;
}

interface PersistedState {
  version: number;
  chainId: number;
  buckets: Record<string, Bucket>;
  /** Highest block ingested; null before the first tick. */
  head: number | null;
  /** Lowest block ingested. Bootstrap walks this backwards. */
  tail: number | null;
  /** Immutable once known, so this map is never re-read. */
  pairSides: Record<string, WethSide>;
  updatedAt: number;
}

export interface SwapWindowSummary {
  /** False when no ENVIO_API_TOKEN is configured — the UI must show `--`, not a zero. */
  readonly available: boolean;
  readonly volumeWei: bigint;
  readonly feesWei: bigint;
  readonly swaps: number;
  readonly ignoredNonWeth: number;
  readonly unresolvedSwaps: number;
  readonly coveredBlocks: number;
  readonly windowBlocks: number;
  readonly complete: boolean;
  readonly knownPairs: number;
  readonly updatedAt: number | null;
}

const EMPTY: SwapWindowSummary = {
  available: false,
  volumeWei: 0n,
  feesWei: 0n,
  swaps: 0,
  ignoredNonWeth: 0,
  unresolvedSwaps: 0,
  coveredBlocks: 0,
  windowBlocks: WINDOW_BLOCKS,
  complete: false,
  knownPairs: 0,
  updatedAt: null,
};

const token = () => process.env.ENVIO_API_TOKEN?.trim() ?? "";

// ---------------------------------------------------------------- persistence

function emptyState(): PersistedState {
  return {
    version: STATE_VERSION,
    chainId: poolixConfig.chain.id,
    buckets: {},
    head: null,
    tail: null,
    pairSides: {},
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
  "swap-window",
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
      workerLog.warn({ dataset: "swap-window", reason: "load", error: result.detail });
    }
    return emptyState();
  }
  const state = result.value;
  return {
    ...emptyState(),
    ...state,
    buckets: state.buckets ?? {},
    pairSides: state.pairSides ?? {},
  };
}

async function saveState(state: PersistedState): Promise<void> {
  await store.save(state);
}

// ------------------------------------------------------------------ hypersync

/** A Swap log carrying the block it landed in, which is what drives bucketing. */
interface IndexedSwapLog extends SwapLogLike {
  readonly block_number: number;
}

interface HyperSyncPage {
  readonly logs: IndexedSwapLog[];
  readonly nextBlock: number;
}

async function fetchHeight(): Promise<number | null> {
  try {
    /*
      A bounded revalidate rather than `cache: "no-store"`. no-store opts the whole page
      out of static rendering, which would run an 18s tick on every visitor request
      instead of once per revalidation in the background.
    */
    const res = await fetch(HEIGHT_URL, { next: { revalidate: 30 } });
    if (!res.ok) return null;
    const json: unknown = await res.json();
    const height = (json as { height?: number }).height;
    return typeof height === "number" ? height : null;
  } catch {
    return null;
  }
}

/**
 * One HyperSync page. The response nests logs inside `data[].logs`, so counting
 * `data.length` would count batches rather than events.
 */
async function fetchSwapPage(fromBlock: number, toBlock: number): Promise<HyperSyncPage | null> {
  try {
    const res = await fetch(HYPERSYNC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token()}` },
      body: JSON.stringify({
        from_block: fromBlock,
        to_block: toBlock,
        logs: [{ topics: [[SWAP_TOPIC0]] }],
        field_selection: { log: ["block_number", "address", "data"] },
      }),
      // POST is not cached by Next, so no cache directive is needed and adding one
      // would force the page to render dynamically.
    });
    if (!res.ok) return null;

    const json = (await res.json()) as {
      data?: { logs?: { address: string; data: string; block_number: number }[] }[];
      next_block?: number;
    };
    const logs = (json.data ?? []).flatMap((batch) => batch.logs ?? []);
    return { logs, nextBlock: json.next_block ?? toBlock };
  } catch {
    return null;
  }
}

// ------------------------------------------------------------ pair resolution

// Pair classification moved to services/analytics/pair-sides.ts so the historical window
// uses the identical rule; the behaviour here is unchanged, which verify:swaps confirms.

// ----------------------------------------------------------------- ingestion

interface BucketTotals {
  volumeWei: bigint;
  swaps: number;
  ignoredNonWeth: number;
  unresolvedSwaps: number;
}

interface CollectResult {
  readonly buckets: Map<number, BucketTotals>;
  /** True when the whole range was read before the deadline. */
  readonly complete: boolean;
  /** How far the read actually got; only meaningful when `complete` is false. */
  readonly reached: number;
}

/**
 * Reads a block range into a standalone set of bucket totals, without touching the
 * persisted state.
 *
 * Keeping the result separate is what makes a partial read safe to discard: a caller
 * extending the window backwards can only advance its pointer when the whole range was
 * read, because a pointer cannot describe a hole in the middle of a range.
 */
async function collectRange(
  state: PersistedState,
  client: PublicClient,
  fromBlock: number,
  toBlock: number,
  deadline: number,
): Promise<CollectResult> {
  const buckets = new Map<number, BucketTotals>();
  let cursor = fromBlock;

  const add = (block: number, volumeWei: bigint, swaps: number, ignored: number, unresolved: number) => {
    const key = bucketOf(block, BUCKET_BLOCKS);
    const current = buckets.get(key) ?? { volumeWei: 0n, swaps: 0, ignoredNonWeth: 0, unresolvedSwaps: 0 };
    current.volumeWei += volumeWei;
    current.swaps += swaps;
    current.ignoredNonWeth += ignored;
    current.unresolvedSwaps += unresolved;
    buckets.set(key, current);
  };

  while (cursor < toBlock) {
    if (Date.now() >= deadline) return { buckets, complete: false, reached: cursor };

    const page = await fetchSwapPage(cursor, toBlock);
    if (page === null) return { buckets, complete: false, reached: cursor };

    // Classify any pair seen for the first time before aggregating, so a swap is never
    // silently dropped from the total.
    const unknown = [...new Set(page.logs.map((log) => log.address.toLowerCase()))].filter(
      (pair) => state.pairSides[pair] === undefined,
    );
    if (unknown.length > 0) {
      const resolved = await resolvePairSides(client, unknown.map((pair) => getAddress(pair)));
      for (const [pair, side] of resolved) state.pairSides[pair] = side;
    }

    // Group by bucket so ageing works on real block ranges.
    const byBucket = new Map<number, IndexedSwapLog[]>();
    for (const log of page.logs) {
      const key = bucketOf(log.block_number, BUCKET_BLOCKS);
      const list = byBucket.get(key);
      if (list) list.push(log);
      else byBucket.set(key, [log]);
    }

    for (const [bucketStart, logs] of byBucket) {
      const result = aggregateWethVolume(logs, (pair) => state.pairSides[pair]);
      add(
        bucketStart,
        result.volumeWei,
        result.counted,
        result.ignoredNonWeth,
        result.unresolvedPairs + result.undecodable,
      );
    }

    if (page.nextBlock <= cursor) return { buckets, complete: false, reached: cursor };
    cursor = Math.min(page.nextBlock, toBlock);
  }

  return { buckets, complete: true, reached: cursor };
}

function mergeBuckets(state: PersistedState, buckets: ReadonlyMap<number, BucketTotals>): void {
  for (const [bucketStart, totals] of buckets) {
    const key = String(bucketStart);
    const current = state.buckets[key];
    const previousVolume = current ? BigInt(current.volumeWei) : 0n;
    state.buckets[key] = {
      volumeWei: (previousVolume + totals.volumeWei).toString(),
      swaps: (current?.swaps ?? 0) + totals.swaps,
      ignoredNonWeth: (current?.ignoredNonWeth ?? 0) + totals.ignoredNonWeth,
      unresolvedSwaps: (current?.unresolvedSwaps ?? 0) + totals.unresolvedSwaps,
    };
  }
}

// ----------------------------------------------------------------------- tick

let inFlight: Promise<SwapWindowSummary> | null = null;

function summarise(state: PersistedState, height: number): SwapWindowSummary {
  const windowStart = height - WINDOW_BLOCKS;

  let volumeWei = 0n;
  let swaps = 0;
  let ignoredNonWeth = 0;
  let unresolvedSwaps = 0;

  for (const [key, bucket] of Object.entries(state.buckets)) {
    if (Number(key) < windowStart) continue;
    volumeWei += BigInt(bucket.volumeWei);
    swaps += bucket.swaps;
    ignoredNonWeth += bucket.ignoredNonWeth;
    unresolvedSwaps += bucket.unresolvedSwaps;
  }

  const tail = state.tail ?? height;
  const head = state.head ?? height;
  const coveredBlocks = Math.max(0, head - Math.max(tail, windowStart));

  return {
    available: true,
    volumeWei,
    feesWei: tradingFeesWei(volumeWei),
    swaps,
    ignoredNonWeth,
    unresolvedSwaps,
    coveredBlocks,
    windowBlocks: WINDOW_BLOCKS,
    complete: tail <= windowStart,
    knownPairs: Object.keys(state.pairSides).length,
    updatedAt: state.updatedAt || null,
  };
}

async function runTick(): Promise<SwapWindowSummary> {
  if (token() === "") return EMPTY;

  const height = await fetchHeight();
  if (height === null) {
    // Cannot reach the indexer: report whatever is already on disk rather than zero.
    const state = await loadState();
    return state.head === null ? EMPTY : summarise(state, state.head);
  }

  const state = await loadState();
  const deadline = Date.now() + TICK_BUDGET_MS;
  const windowStart = height - WINDOW_BLOCKS;

  const rpcUrl = process.env.RPC_URL?.trim() || poolixConfig.rpcUrl;
  const client = createPublicClient({ transport: http(rpcUrl, { batch: { wait: 16 } }) }) as PublicClient;

  if (state.head === null || state.tail === null) {
    state.head = height;
    state.tail = height;
  }

  /*
    1. Catch the head up to now. Cheap once bootstrapped: roughly one request.
       A partial read is safe to keep here, because reading forwards means everything
       up to `reached` is contiguous with what came before.
  */
  if (state.head < height) {
    const forward = await collectRange(state, client, state.head, height, deadline);
    mergeBuckets(state, forward.buckets);
    state.head = forward.complete ? height : Math.max(state.head, forward.reached);
  }

  /*
    2. Spend whatever budget is left walking the tail backwards toward -24h.
       A partial read is discarded rather than merged: the tail pointer can only say
       "everything from here up is covered", so keeping half a chunk would leave a hole
       that later ticks would never revisit, silently under-reporting volume.
  */
  while (state.tail > windowStart && Date.now() < deadline) {
    const from = Math.max(windowStart, state.tail - BOOTSTRAP_CHUNK);
    const backward = await collectRange(state, client, from, state.tail, deadline);
    if (!backward.complete) break;
    mergeBuckets(state, backward.buckets);
    state.tail = from;
  }

  /*
    3. Repair buckets that hold swaps nobody could attribute at the time.

       A pair whose classification read was refused leaves its swaps recorded as
       unresolved, and the bucket's total is then a floor. The pair is almost always
       classified moments later by another page, but nothing ever came back for those
       swaps — so the undercount survived until the bucket aged out, which is what
       verify:swaps kept catching.

       The bucket is re-read and its totals REPLACED, never merged. Totals are a pure
       function of the range's logs and the classification map, so a replacement is
       idempotent and cannot double-count; a correction delta would instead depend on the
       stored value being right, which is the very thing in doubt.

       Bounded and oldest-first, so this cannot starve the forward catch-up and two runs
       over the same state do the same work.
  */
  if (state.tail !== null && state.head !== null) {
    const pending = new Map<number, { unresolvedSwaps: number }>();
    for (const [key, bucket] of Object.entries(state.buckets)) {
      pending.set(Number(key), { unresolvedSwaps: bucket.unresolvedSwaps });
    }

    const targets = reconciliationTargets(
      pending,
      BUCKET_BLOCKS,
      state.tail,
      state.head,
      MAX_RECONCILE_PER_TICK,
    );

    for (const bucketStart of targets) {
      if (Date.now() >= deadline) break;

      const reread = await collectRange(
        state,
        client,
        bucketStart,
        bucketStart + BUCKET_BLOCKS,
        deadline,
      );
      // A partial re-read describes part of the range; replacing with it would swap one
      // undercount for another, so the bucket keeps what it has and waits for a later tick.
      if (!reread.complete) break;

      const totals = reread.buckets.get(bucketStart) ?? {
        volumeWei: 0n,
        swaps: 0,
        ignoredNonWeth: 0,
        unresolvedSwaps: 0,
      };
      state.buckets[String(bucketStart)] = {
        volumeWei: totals.volumeWei.toString(),
        swaps: totals.swaps,
        ignoredNonWeth: totals.ignoredNonWeth,
        unresolvedSwaps: totals.unresolvedSwaps,
      };
    }
  }

  // 4. Drop buckets that have aged out of the window.
  for (const key of Object.keys(state.buckets)) {
    if (Number(key) < windowStart - BUCKET_BLOCKS) delete state.buckets[key];
  }

  state.updatedAt = Date.now();
  await saveState(state);
  return summarise(state, height);
}

/**
 * Advances the window by one bounded tick and returns the current 24h totals.
 *
 * Concurrent callers share a single tick, so several page renders cannot stack
 * overlapping sweeps onto a rate-limited endpoint.
 */
export async function getSwapWindow(): Promise<SwapWindowSummary> {
  if (inFlight !== null) return inFlight;
  inFlight = runTick()
    .catch(() => EMPTY)
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}
