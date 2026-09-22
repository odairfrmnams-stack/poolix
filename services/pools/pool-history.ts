import "server-only";


import { createPublicClient, getAddress, http, type PublicClient } from "viem";

import { poolixConfig } from "@/config/poolix";
import { workerLog } from "@/services/storage/log";
import { memoizeSnapshotRead, SNAPSHOT_TTL_MS } from "@/services/storage/snapshot-read";
import { analyticsStore } from "@/services/storage/storage";
import { uniswapV2PairAbi } from "@/services/abis/uniswap-v2";
import { BUCKET_SECONDS } from "@/services/analytics/history-math";
import { getBucketRanges } from "@/services/analytics/history-window";
import {
  fetchHyperSyncHeight,
  fetchLogsPaged,
  hasHyperSyncToken,
  hyperSyncPost,
} from "@/services/analytics/hypersync";
import { getLiquidityHistory } from "@/services/analytics/liquidity-history";
import {
  BURN_TOPIC0,
  buildSnapshots,
  MINT_TOPIC0,
  SYNC_TOPIC0,
  type PairEvent,
} from "@/services/analytics/liquidity-math";
import { aggregateWethVolume, PAIR_CREATED_TOPIC0, SWAP_TOPIC0, type WethSide } from "@/services/analytics/swap-math";
import {
  normalizeAddress,
  poolWindowStarts,
  POOL_TIMEFRAME_HOURS,
  wethSideOf,
  totalPoolWindow,
  type PoolBucket,
  type PoolCreation,
  type PoolTimeframe,
  type PoolWindowTotals,
} from "@/services/pools/pool-analytics-math";

/*
  Per-pool historical analytics.

  WHY THIS EXISTS. The Phase 1-3 stores are all pre-aggregated: every historical bucket
  holds one summed number with no pair dimension, so nothing already on disk can say what
  a single pool did. Per-pool figures therefore need their own ingestion — but not their
  own methodology.

  Everything that decides what a number MEANS is reused unchanged: aggregateWethVolume
  for ETH-side volume, tradingFeesWei for the 0.30% rate, buildSnapshots for Sync-based
  reserve reconstruction, historicalFeeApr for the APR arithmetic, and the same hourly
  grid the global windows use. Only the attribution is new, and it is a single pass over
  one fetch.

  Because the aggregate is defined as the sum of the parts here, a pool's fees cannot
  reach another pool's APR and a pool's liquidity cannot stand in for another's — those
  invariants hold by construction rather than by care.

  SCOPE. The pools are Poolix's discovered universe, taken from the liquidity series so
  the two cannot drift. A pool outside that universe does not appear.
*/

const TICK_BUDGET_MS = 25_000;
/**
 * Reserved for creation lookups, separate from the event budget.
 *
 * Sharing one deadline meant the genesis event read could spend it all and leave creation
 * with no time at all, tick after tick — a permanent "--" produced by scheduling rather
 * than by missing data. Because a creation block never changes, this is paid once per pool
 * and then never again.
 */
const CREATION_BUDGET_MS = 8_000;
const REFRESH_MS = 120_000;
const STATE_VERSION = 1;

interface StoredBucket {
  v: string;
  s: number;
  t: number;
  /** null when no reserve was ever observed at or before this hour. */
  l: string | null;
}

interface StoredPool {
  pair: string;
  token0: string;
  token1: string;
  wethSide: WethSide;
  creationBlock: number | null;
  creationTimestamp: number | null;
  creationFromPairCreated: boolean;
  buckets: Record<string, StoredBucket>;
  swaps: number;
  transactions: number;
}

interface PersistedState {
  version: number;
  chainId: number;
  pools: Record<string, StoredPool>;
  scannedTo: number;
  updatedAt: number;
}

export interface PoolTimeframeTotals extends PoolWindowTotals {
  readonly frame: PoolTimeframe;
  /** True when the window begins before the pool existed. */
  readonly partialByCreation: boolean;
}

export interface PoolSeriesPoint {
  readonly startTimestamp: number;
  readonly volumeWei: bigint;
  readonly liquidityWei: bigint | null;
  readonly swaps: number;
  readonly transactions: number;
}

export interface PoolAnalytics {
  readonly pair: string;
  readonly token0: string;
  readonly token1: string;
  readonly wethSide: WethSide;
  readonly creation: PoolCreation | null;
  readonly totals: Readonly<Record<PoolTimeframe, PoolTimeframeTotals>>;
  readonly series: Readonly<Record<PoolTimeframe, readonly PoolSeriesPoint[]>>;
  readonly swapsIndexed: number;
  readonly transactionsIndexed: number;
}

export interface PoolHistorySummary {
  readonly available: boolean;
  readonly pools: readonly PoolAnalytics[];
  readonly updatedAt: number | null;
}

const EMPTY: PoolHistorySummary = { available: false, pools: [], updatedAt: null };


// ---------------------------------------------------------------- persistence

function emptyState(): PersistedState {
  return { version: STATE_VERSION, chainId: poolixConfig.chain.id, pools: {}, scannedTo: 0, updatedAt: 0 };
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
  "pool-history",
  STATE_VERSION,
  poolixConfig.chain.id,
  (value: unknown): value is PersistedState =>
    typeof value === "object" && value !== null && typeof (value as PersistedState).pools === "object",
);

async function loadState(): Promise<PersistedState> {
  const result = await store.load();
  if (result.value === null) {
    // "missing" is an ordinary cold start; anything else means state was thrown away and
    // is worth saying out loud rather than silently rebuilding.
    if (result.outcome !== "missing") {
      workerLog.warn({ dataset: "pool-history", reason: "load", error: result.detail });
    }
    return emptyState();
  }
  const state = result.value;
  return {
    ...emptyState(),
    ...state,
    pools: state.pools ?? {},
  };
}

async function saveState(state: PersistedState): Promise<void> {
  await store.save(state);
}

// -------------------------------------------------------------------- fetching

interface RawLog {
  address: string;
  block_number: number;
  log_index: number;
  transaction_hash?: string;
  topic0?: string;
  topic1?: string;
  topic2?: string;
  data: string;
}

/** The address a PairCreated event names as the new pair: first word of its data. */
function pairFromCreatedData(data: string): string | null {
  if (typeof data !== "string" || data.length < 2 + 64) return null;
  const word = data.slice(2, 66);
  if (!/^[0-9a-fA-F]{64}$/.test(word)) return null;
  return `0x${word.slice(24)}`.toLowerCase();
}

/**
 * Creation block and timestamp for each pool, from the factory's own PairCreated event.
 *
 * Inference from a pool's first Swap is deliberately NOT a fallback: a pool's first trade
 * is not its creation, and reporting one as the other would be a quiet fabrication. A
 * pool whose PairCreated cannot be read reports no creation date at all.
 */
async function fetchCreations(
  pools: ReadonlyMap<string, PairTokens>,
  toBlock: number,
  deadline: number,
): Promise<Map<string, { block: number; timestamp: number }>> {
  // Only complete records: a creation is a block AND its timestamp, or it is not stored.
  const found = new Map<string, { block: number; timestamp: number }>();
  const { uniswapV2 } = poolixConfig.contracts;
  if (uniswapV2.factory.status !== "configured") return found;

  const factory = normalizeAddress(uniswapV2.factory.address);
  const asTopic = (address: string) => `0x${normalizeAddress(address).slice(2).padStart(64, "0")}`;

  /*
    One narrow lookup per pool, filtered on the indexed token0 and token1.

    Sweeping every PairCreated the factory has emitted was the first attempt and it never
    finished inside a tick — the factory holds tens of thousands of pairs. Filtering on
    the indexed arguments turns that into a single matching event per pool.
  */
  for (const [pair, tokens] of pools) {
    if (Date.now() >= deadline) break;

    const { logs, complete } = await fetchLogsPaged<RawLog>({
      fromBlock: 0,
      toBlock,
      addresses: [factory],
      topics: [[PAIR_CREATED_TOPIC0], [asTopic(tokens.token0)], [asTopic(tokens.token1)]],
      fields: ["block_number", "log_index", "address", "data"],
      deadline,
    });
    if (!complete) continue;

    // The pair address is the first word of the data, so the match is confirmed rather
    // than assumed from the token pair alone.
    const match = logs.find((log) => pairFromCreatedData(log.data) === pair);
    if (match === undefined) continue;

    /*
      Both halves or neither.

      The block is useless on its own: every creation date on the page is rendered from
      the timestamp, and storing a block whose timestamp could not be read leaves a record
      that claims to know when the pool was created and cannot say. A throttled timestamp
      read is a reason to try again next tick, not a reason to half-record the answer.
    */
    const timestamp = await fetchBlockTimestamp(match.block_number);
    if (timestamp === null) continue;
    found.set(pair, { block: match.block_number, timestamp });
  }

  return found;
}

/** The timestamp of one block, read from the indexer's block headers. */
async function fetchBlockTimestamp(block: number): Promise<number | null> {
  const json = await hyperSyncPost({
    from_block: block,
    to_block: block + 1,
    include_all_blocks: true,
    field_selection: { block: ["number", "timestamp"] },
  });
  if (json === null) return null;

  const batches = (json.data ?? []) as { blocks?: { number?: number; timestamp?: string | number }[] }[];
  const row = batches.flatMap((batch) => batch.blocks ?? []).find((entry) => entry.number === block);
  if (row?.timestamp === undefined) return null;
  try {
    const seconds = typeof row.timestamp === "string" ? Number(BigInt(row.timestamp)) : row.timestamp;
    return Number.isFinite(seconds) ? seconds : null;
  } catch {
    return null;
  }
}

// ----------------------------------------------------------------------- tick

let inFlight: Promise<PoolHistorySummary> | null = null;
let cached: { at: number; value: PoolHistorySummary } | null = null;

function summarise(state: PersistedState): PoolHistorySummary {
  const now = Math.floor(Date.now() / 1000);
  const pools: PoolAnalytics[] = [];

  for (const stored of Object.values(state.pools)) {
    const buckets = new Map<number, PoolBucket>();
    for (const [key, value] of Object.entries(stored.buckets)) {
      buckets.set(Number(key), {
        startTimestamp: Number(key),
        volumeWei: BigInt(value.v),
        swaps: value.s,
        transactions: value.t,
        liquidityWei: value.l === null ? null : BigInt(value.l),
      });
    }

    const creation: PoolCreation | null =
      stored.creationBlock !== null && stored.creationTimestamp !== null
        ? {
            blockNumber: stored.creationBlock,
            timestamp: stored.creationTimestamp,
            fromPairCreated: stored.creationFromPairCreated,
          }
        : null;

    const totals = {} as Record<PoolTimeframe, PoolTimeframeTotals>;
    const series = {} as Record<PoolTimeframe, PoolSeriesPoint[]>;

    for (const frame of Object.keys(POOL_TIMEFRAME_HOURS) as PoolTimeframe[]) {
      const starts = poolWindowStarts(now, frame);
      const windowTotals = totalPoolWindow(buckets, starts, BUCKET_SECONDS);
      const first = starts[0];
      totals[frame] = {
        ...windowTotals,
        frame,
        partialByCreation:
          creation !== null && first !== undefined && creation.timestamp > first,
      };
      series[frame] = starts.map((start) => {
        const bucket = buckets.get(start);
        return {
          startTimestamp: start,
          volumeWei: bucket?.volumeWei ?? 0n,
          liquidityWei: bucket?.liquidityWei ?? null,
          swaps: bucket?.swaps ?? 0,
          transactions: bucket?.transactions ?? 0,
        };
      });
    }

    pools.push({
      pair: stored.pair,
      token0: stored.token0,
      token1: stored.token1,
      wethSide: stored.wethSide,
      creation,
      totals,
      series,
      swapsIndexed: stored.swaps,
      transactionsIndexed: stored.transactions,
    });
  }

  return { available: true, pools, updatedAt: state.updatedAt || null };
}

async function runTick(): Promise<PoolHistorySummary> {
  if (!hasHyperSyncToken()) return EMPTY;

  const state = await loadState();
  const persisted = () => (state.updatedAt === 0 ? EMPTY : summarise(state));

  // The same grid and the same pool scope the global series use.
  const ranges = await getBucketRanges();
  if (ranges.length === 0) return persisted();

  const liquidity = await getLiquidityHistory();
  const pairs = liquidity.pairs.map(normalizeAddress);
  if (pairs.length === 0) return persisted();

  const deadline = Date.now() + TICK_BUDGET_MS;
  const first = ranges[0];
  const last = ranges[ranges.length - 1];
  if (first === undefined || last === undefined) return persisted();

  /*
    One fetch for every event type, from genesis, restricted to the scoped pairs.

    Genesis rather than incremental for the same reason Phase 2 rescans: reserve state
    carried forward from a partial read would be a stale value presented as current, and
    at this scope a whole-history read is thousands of events rather than millions.
  */
  const fetched = await fetchLogsPaged<RawLog>({
    fromBlock: 0,
    toBlock: last.toBlock,
    addresses: pairs,
    topic0: [SWAP_TOPIC0, SYNC_TOPIC0, MINT_TOPIC0, BURN_TOPIC0],
    fields: ["block_number", "log_index", "address", "transaction_hash", "topic0", "data"],
    deadline,
  });
  if (!fetched.complete) return persisted();

  // Block -> bucket, by binary search over the shared grid.
  const sorted = [...ranges].sort((a, b) => a.fromBlock - b.fromBlock);
  const bucketOfBlock = (block: number): number | null => {
    let low = 0;
    let high = sorted.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const range = sorted[mid];
      if (range === undefined) return null;
      if (block < range.fromBlock) high = mid - 1;
      else if (block >= range.toBlock) low = mid + 1;
      else return range.startTimestamp;
    }
    return null;
  };

  // Read from the pair contracts, never assumed. A pool whose tokens cannot be read is
  // left unclassified, so its volume is reported as unresolved rather than as zero.
  const pairTokens = await fetchPairTokens(pairs);
  const sides = new Map<string, WethSide>();
  for (const [pair, tokens] of pairTokens) sides.set(pair, tokens.wethSide);

  // ---- attribute every event to its pool and hour ----
  interface Accum {
    volumeWei: bigint;
    swaps: number;
    txs: Set<string>;
  }
  const perPool = new Map<string, Map<number, Accum>>();
  const syncEvents: PairEvent[] = [];

  for (const log of fetched.logs) {
    const pair = normalizeAddress(log.address);
    if (!pairs.includes(pair)) continue;
    const topic = normalizeAddress(log.topic0 ?? "");

    if (topic === SYNC_TOPIC0) {
      syncEvents.push({
        pair,
        blockNumber: log.block_number,
        logIndex: log.log_index,
        topic0: topic,
        data: log.data,
      });
      continue;
    }

    const bucketStart = bucketOfBlock(log.block_number);
    if (bucketStart === null) continue;

    let byBucket = perPool.get(pair);
    if (byBucket === undefined) {
      byBucket = new Map();
      perPool.set(pair, byBucket);
    }
    let accum = byBucket.get(bucketStart);
    if (accum === undefined) {
      accum = { volumeWei: 0n, swaps: 0, txs: new Set() };
      byBucket.set(bucketStart, accum);
    }

    // A transaction emitting several qualifying events counts once, which is the same
    // rule the global transaction metric uses.
    if (log.transaction_hash !== undefined) accum.txs.add(log.transaction_hash.toLowerCase());

    if (topic === SWAP_TOPIC0) {
      const result = aggregateWethVolume([{ address: pair, data: log.data }], (p) => sides.get(p));
      accum.volumeWei += result.volumeWei;
      accum.swaps += result.counted;
    }
  }

  // ---- per-pool reserve snapshots on the same grid ----
  const snapshots = buildSnapshots(
    syncEvents,
    ranges.map((range) => ({ startTimestamp: range.startTimestamp, toBlock: range.toBlock })),
    pairs,
    { genesisScan: true },
  );

  /*
    Only the pools whose creation is still unknown. A creation block is immutable, so
    re-reading one already on disk would spend the budget confirming a settled fact while
    a pool that has never resolved keeps reporting nothing.
  */
  const unresolved = new Map<string, PairTokens>();
  for (const [pair, tokens] of pairTokens) {
    const existing = state.pools[pair];
    if (existing?.creationBlock == null || existing.creationTimestamp == null) {
      unresolved.set(pair, tokens);
    }
  }
  /*
    Creation is looked up against the chain head, not the grid.

    The grid ends at the last CLOSED hour, which lags the head by up to an hour, and a pool
    created inside that gap had its PairCreated emitted beyond the grid's last block. Bounding
    the search by the grid reported those pools as having no creation date at all — which is
    exactly backwards, since the newest pools are the ones a creation date matters most for.
    A window bound belongs on windowed metrics; a creation block is not one.
  */
  const head = await fetchHyperSyncHeight();
  const creations = await fetchCreations(
    unresolved,
    Math.max(head ?? 0, last.toBlock),
    Date.now() + CREATION_BUDGET_MS,
  );

  // ---- persist ----
  const next: Record<string, StoredPool> = {};
  for (const pair of pairs) {
    const byBucket = perPool.get(pair) ?? new Map<number, Accum>();
    const buckets: Record<string, StoredBucket> = {};
    let swaps = 0;
    let transactions = 0;

    for (const snapshot of snapshots) {
      const accum = byBucket.get(snapshot.startTimestamp);
      const reserves = snapshot.perPair.get(pair);
      const side = sides.get(pair) ?? "none";
      const liquidityWei =
        reserves === undefined || side === "none"
          ? null
          : (side === "token0" ? reserves.reserve0 : reserves.reserve1) * 2n;

      swaps += accum?.swaps ?? 0;
      transactions += accum?.txs.size ?? 0;

      buckets[String(snapshot.startTimestamp)] = {
        v: (accum?.volumeWei ?? 0n).toString(),
        s: accum?.swaps ?? 0,
        t: accum?.txs.size ?? 0,
        l: liquidityWei === null ? null : liquidityWei.toString(),
      };
    }

    const existing = state.pools[pair];
    const tokens = pairTokens.get(pair);

    /*
      A creation is a block and its timestamp together, or it is nothing.

      Carried-forward state is re-checked rather than trusted: an earlier version stored a
      block whose timestamp read had been throttled, and a half-record claims to know when
      a pool was created while being unable to say. Discarding it here lets the lookup run
      again on a later tick instead of preserving the gap for the life of the cache.
    */
    const carried =
      existing?.creationBlock != null && existing.creationTimestamp != null
        ? { block: existing.creationBlock, timestamp: existing.creationTimestamp }
        : undefined;
    const creation = creations.get(pair) ?? carried;

    next[pair] = {
      pair,
      token0: tokens?.token0 ?? existing?.token0 ?? "",
      token1: tokens?.token1 ?? existing?.token1 ?? "",
      wethSide: sides.get(pair) ?? "none",
      creationBlock: creation?.block ?? null,
      creationTimestamp: creation?.timestamp ?? null,
      // Nothing infers creation from a first swap, so anything stored came from the event.
      creationFromPairCreated: creation !== undefined,
      buckets,
      swaps,
      transactions,
    };
  }

  state.pools = next;
  state.scannedTo = last.toBlock;
  state.updatedAt = Date.now();
  await saveState(state);

  return summarise(state);
}

export interface PairTokens {
  readonly token0: string;
  readonly token1: string;
  readonly wethSide: WethSide;
}

/**
 * token0, token1 and the WETH side for each pool, read from the pair contracts.
 *
 * Read rather than inferred. The ordering of a v2 pair is fixed by address, so WETH sits
 * on either side depending on the other token, and deciding that from anything other than
 * the contract's own answer is how a pool ends up reporting the wrong reserve as its ETH
 * liquidity. Two calls per pool, and the pool set is small.
 */
async function fetchPairTokens(pairs: readonly string[]): Promise<Map<string, PairTokens>> {
  const weth = normalizeAddress(poolixConfig.contracts.weth);
  const rpcUrl = process.env.RPC_URL?.trim() || poolixConfig.rpcUrl;
  const client = createPublicClient({ transport: http(rpcUrl, { batch: { wait: 16 } }) }) as PublicClient;

  const entries = await Promise.all(
    pairs.map(async (pair) => {
      try {
        const [token0, token1] = await Promise.all([
          client.readContract({ address: getAddress(pair), abi: uniswapV2PairAbi, functionName: "token0" }),
          client.readContract({ address: getAddress(pair), abi: uniswapV2PairAbi, functionName: "token1" }),
        ]);
        const a = normalizeAddress(token0);
        const b = normalizeAddress(token1);
        return [pair, { token0: a, token1: b, wethSide: wethSideOf(a, b, weth) }] as const;
      } catch {
        // Unreadable now means unclassified, never "none": marking a real WETH pair as
        // token/token would drop its volume and liquidity for good.
        return null;
      }
    }),
  );

  const resolved = new Map<string, PairTokens>();
  for (const entry of entries) {
    if (entry !== null) resolved.set(entry[0], entry[1]);
  }
  return resolved;
}

/** Per-pool historical analytics. Concurrent callers share one tick. */
/**
 * Per-pool history from persisted state, without ticking. The most expensive tick in the
 * dashboard path — measured cold between 7 and 14 seconds — and a page render has no need
 * to pay it to display the series the last tick already produced.
 */
let poolHistoryMemo: (() => Promise<PoolHistorySummary>) | null = null;

export async function readPoolHistory(): Promise<PoolHistorySummary> {
  poolHistoryMemo ??= memoizeSnapshotRead(async () => {
    const state = await loadState();
    return state.updatedAt === 0 ? EMPTY : summarise(state);
  }, SNAPSHOT_TTL_MS);
  return poolHistoryMemo();
}

export async function getPoolHistory(): Promise<PoolHistorySummary> {
  if (cached !== null && Date.now() - cached.at < REFRESH_MS) return cached.value;
  if (inFlight !== null) return inFlight;

  inFlight = runTick()
    .then((value) => {
      cached = { at: Date.now(), value };
      return value;
    })
    .catch((error: unknown) => {
      console.error("[pool-history] tick failed:", error instanceof Error ? error.message : error);
      return EMPTY;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}
