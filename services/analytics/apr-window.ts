import "server-only";

import { createPublicClient, getAddress, http, type PublicClient } from "viem";

import { poolixConfig } from "@/config/poolix";
import { workerLog } from "@/services/storage/log";
import { memoizeSnapshotRead, SNAPSHOT_TTL_MS } from "@/services/storage/snapshot-read";
import { analyticsStore } from "@/services/storage/storage";
import {
  APR_SCALE,
  formatApr,
  historicalFeeApr,
  YEAR_SECONDS,
  type LiquiditySample,
} from "@/services/analytics/apr-math";
import { BUCKET_SECONDS, HISTORY_DAYS, windowBuckets, type HistoryTimeframe } from "@/services/analytics/history-math";
import { getBucketRanges } from "@/services/analytics/history-window";
import { getLiquidityHistory, readLiquidityHistory } from "@/services/analytics/liquidity-history";
import { resolvePairSides } from "@/services/analytics/pair-sides";
import { aggregateWethVolume, SWAP_TOPIC0, tradingFeesWei, type WethSide } from "@/services/analytics/swap-math";
import type { Address } from "@/types/web3";

/*
  Historical Fee APR for Poolix's scanned pools.

  THE SCOPE PROBLEM THIS EXISTS TO SOLVE. Phase 1's historical volume is chain-wide: it
  filters Swap events by topic only, so it covers every Token/WETH pair on the chain.
  Phase 2's liquidity is filtered to the pairs Poolix has actually discovered. Measured on
  2026-09-19, dividing one by the other gave 1,812,990% over 7D and 5,430,083% over 30D —
  not a high APR, but a ratio between two different populations, which is an APR of
  nothing.

  So the fees used here are gathered over the SAME pairs the liquidity series was built
  from, using the identical rule Phase 1 uses: Uniswap v2 Swap events, WETH side only,
  token/token excluded, fee = volume x 0.003 via the same tradingFeesWei. The methodology
  is unchanged; only the population is narrowed to match the denominator. Phase 1's own
  published chain-wide volume and fees are untouched.

  The pair list is taken from the liquidity summary rather than rediscovered, so the two
  sides cannot drift apart when the pool scan shifts.

  This is a measurement of what happened, annualized. There is no APY, no compounding and
  no projection anywhere in this file.
*/

const HYPERSYNC_URL = "https://4663.hypersync.xyz/query";
const BACKOFF_MS = [1_000, 2_500, 6_000, 12_000];
const TICK_BUDGET_MS = 25_000;
const REFRESH_MS = 120_000;
const STATE_VERSION = 1;

interface StoredFeeBucket {
  startTimestamp: number;
  fromBlock: number;
  toBlock: number;
  volumeWei: string;
  swaps: number;
}

interface PersistedState {
  version: number;
  chainId: number;
  /** Scope-matched hourly volume, keyed by bucket start. */
  buckets: Record<string, StoredFeeBucket>;
  pairs: string[];
  pairSides: Record<string, WethSide>;
  swapsCounted: number;
  scannedTo: number;
  updatedAt: number;
}

export interface AprTimeframe {
  /** Formatted percentage, or null when it cannot be computed. */
  readonly display: string | null;
  readonly aprScaled: bigint | null;
  readonly feesWei: bigint;
  readonly twalWei: bigint | null;
  readonly weightedWei: bigint;
  readonly windowSeconds: number;
  readonly annualizationTimes1e6: bigint;
  /** Both series must be whole before anything is published. */
  readonly volumeComplete: boolean;
  readonly liquidityComplete: boolean;
  readonly bucketsPresent: number;
  readonly bucketsExpected: number;
  readonly reason: string;
}

export interface AprSummary {
  readonly available: boolean;
  readonly timeframes: Readonly<Record<HistoryTimeframe, AprTimeframe>>;
  readonly pairsInScope: number;
  readonly swapsCounted: number;
  readonly updatedAt: number | null;
}

const emptyFrame: AprTimeframe = {
  display: null,
  aprScaled: null,
  feesWei: 0n,
  twalWei: null,
  weightedWei: 0n,
  windowSeconds: 0,
  annualizationTimes1e6: 0n,
  volumeComplete: false,
  liquidityComplete: false,
  bucketsPresent: 0,
  bucketsExpected: 0,
  reason: "no-data",
};

const EMPTY: AprSummary = {
  available: false,
  timeframes: { "7D": emptyFrame, "30D": emptyFrame },
  pairsInScope: 0,
  swapsCounted: 0,
  updatedAt: null,
};

const token = () => process.env.ENVIO_API_TOKEN?.trim() ?? "";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- persistence

function emptyState(): PersistedState {
  return {
    version: STATE_VERSION,
    chainId: poolixConfig.chain.id,
    buckets: {},
    pairs: [],
    pairSides: {},
    swapsCounted: 0,
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
  "apr",
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
      workerLog.warn({ dataset: "apr", reason: "load", error: result.detail });
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

interface RawSwap {
  address: string;
  block_number: number;
  data: string;
}

/**
 * Scope-matched Swap volume for one block range, bucketed by the caller's grid.
 *
 * Address-filtered, which is what makes a whole-history sweep affordable here where the
 * chain-wide equivalent took hours.
 */
async function collectScopedVolume(
  state: PersistedState,
  client: PublicClient,
  pairs: readonly string[],
  ranges: readonly { startTimestamp: number; fromBlock: number; toBlock: number }[],
  deadline: number,
): Promise<{ byBucket: Map<number, { volumeWei: bigint; swaps: number }>; complete: boolean }> {
  const byBucket = new Map<number, { volumeWei: bigint; swaps: number }>();
  if (ranges.length === 0) return { byBucket, complete: true };

  const first = ranges[0];
  const last = ranges[ranges.length - 1];
  if (first === undefined || last === undefined) return { byBucket, complete: true };

  // Block -> bucket, resolved by walking the sorted ranges alongside the events.
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

  let cursor = first.fromBlock;
  const end = last.toBlock;

  while (cursor < end) {
    if (Date.now() >= deadline) return { byBucket, complete: false };

    const json = await post({
      from_block: cursor,
      to_block: end,
      logs: [{ address: [...pairs], topics: [[SWAP_TOPIC0]] }],
      field_selection: { log: ["block_number", "address", "data"] },
    });
    if (json === null) return { byBucket, complete: false };

    const batches = (json.data ?? []) as { logs?: RawSwap[] }[];
    const logs = batches.flatMap((batch) => batch.logs ?? []);

    // Classify anything unseen before aggregating, so no swap is silently dropped.
    const unknown = [...new Set(logs.map((log) => log.address.toLowerCase()))].filter(
      (pair) => state.pairSides[pair] === undefined,
    );
    if (unknown.length > 0) {
      const resolved = await resolvePairSides(client, unknown.map((p) => getAddress(p) as Address));
      for (const [pair, side] of resolved) state.pairSides[pair] = side;
    }

    const grouped = new Map<number, RawSwap[]>();
    for (const log of logs) {
      const bucket = bucketOfBlock(log.block_number);
      if (bucket === null) continue;
      const list = grouped.get(bucket);
      if (list) list.push(log);
      else grouped.set(bucket, [log]);
    }

    for (const [bucket, group] of grouped) {
      // The identical aggregation Phase 1 uses: WETH side only, token/token excluded.
      const result = aggregateWethVolume(group, (pair) => state.pairSides[pair]);
      const current = byBucket.get(bucket) ?? { volumeWei: 0n, swaps: 0 };
      current.volumeWei += result.volumeWei;
      current.swaps += result.counted;
      byBucket.set(bucket, current);
    }

    const next = (json.next_block as number | undefined) ?? end;
    if (next <= cursor) return { byBucket, complete: false };
    cursor = Math.min(next, end);
  }

  return { byBucket, complete: true };
}

// ----------------------------------------------------------------------- tick

let inFlight: Promise<AprSummary> | null = null;
let cached: { at: number; value: AprSummary } | null = null;

async function runTick(): Promise<AprSummary> {
  if (token() === "") return EMPTY;

  const state = await loadState();
  const persisted = () => (state.updatedAt === 0 ? EMPTY : summarise(state, null));

  const liquidity = await getLiquidityHistory();
  if (!liquidity.available || liquidity.pairs.length === 0) return persisted();

  const ranges = await getBucketRanges();
  if (ranges.length === 0) return persisted();

  const pairs = [...liquidity.pairs];
  const deadline = Date.now() + TICK_BUDGET_MS;
  const rpcUrl = process.env.RPC_URL?.trim() || poolixConfig.rpcUrl;
  const client = createPublicClient({ transport: http(rpcUrl, { batch: { wait: 16 } }) }) as PublicClient;

  /*
    Rebuilt whole each tick, like the liquidity series and for the same reason: a
    partial fetch merged into old buckets would mix a fee window with a different pool
    set, and the resulting APR would silently describe neither.
  */
  const collected = await collectScopedVolume(state, client, pairs, ranges, deadline);
  if (!collected.complete) return persisted();

  state.buckets = {};
  state.swapsCounted = 0;
  for (const range of ranges) {
    const totals = collected.byBucket.get(range.startTimestamp) ?? { volumeWei: 0n, swaps: 0 };
    state.buckets[String(range.startTimestamp)] = {
      startTimestamp: range.startTimestamp,
      fromBlock: range.fromBlock,
      toBlock: range.toBlock,
      volumeWei: totals.volumeWei.toString(),
      swaps: totals.swaps,
    };
    state.swapsCounted += totals.swaps;
  }

  state.pairs = pairs;
  state.scannedTo = ranges[ranges.length - 1]?.toBlock ?? 0;
  state.updatedAt = Date.now();
  await saveState(state);

  return summarise(state, liquidity);
}

type LiquiditySummary = Awaited<ReturnType<typeof getLiquidityHistory>>;

function summarise(state: PersistedState, liquidity: LiquiditySummary | null): AprSummary {
  const nowTimestamp = Math.floor(Date.now() / 1000);
  const timeframes = {} as Record<HistoryTimeframe, AprTimeframe>;

  for (const frame of Object.keys(HISTORY_DAYS) as HistoryTimeframe[]) {
    const days = HISTORY_DAYS[frame];
    const wanted = windowBuckets(nowTimestamp, days);
    const liquidityTotals = liquidity?.totals[frame];

    // Fees and liquidity must be keyed to the same hours, so the liquidity points are
    // indexed and read back by the very bucket starts the fee window asks for.
    const liquidityByStart = new Map(
      (liquidityTotals?.points ?? []).map((point) => [point.startTimestamp, point]),
    );

    let feesWei = 0n;
    let present = 0;
    const samples: LiquiditySample[] = [];
    let liquidityComplete = liquidityTotals?.complete ?? false;

    for (const start of wanted) {
      const bucket = state.buckets[String(start)];
      if (bucket === undefined) continue;
      present++;
      feesWei += tradingFeesWei(BigInt(bucket.volumeWei));

      const point = liquidityByStart.get(start);
      if (point === undefined) {
        liquidityComplete = false;
        continue;
      }
      samples.push({
        startTimestamp: start,
        // Real duration from the grid rather than an assumed hour.
        durationSeconds: BUCKET_SECONDS,
        liquidityWei: point.liquidityWei,
      });
    }

    const volumeComplete = present === wanted.length && wanted.length > 0;
    const windowSeconds = wanted.length * BUCKET_SECONDS;
    const result = historicalFeeApr({ feesWei, samples, windowSeconds });

    // Published only when BOTH series cover the whole window. A partial window produces
    // a real number that answers a different question than the one on screen.
    const publishable = volumeComplete && liquidityComplete && result.reason === "ok";

    timeframes[frame] = {
      display: publishable ? formatApr(result.aprScaled) : null,
      aprScaled: publishable ? result.aprScaled : null,
      feesWei,
      twalWei: result.twalWei,
      weightedWei: result.weightedWei,
      windowSeconds,
      annualizationTimes1e6:
        windowSeconds > 0 ? (BigInt(YEAR_SECONDS) * 1_000_000n) / BigInt(windowSeconds) : 0n,
      volumeComplete,
      liquidityComplete,
      bucketsPresent: present,
      bucketsExpected: wanted.length,
      reason: publishable
        ? "ok"
        : !volumeComplete
          ? "volume-incomplete"
          : !liquidityComplete
            ? "liquidity-incomplete"
            : result.reason,
    };
  }

  return {
    available: true,
    timeframes,
    pairsInScope: state.pairs.length,
    swapsCounted: state.swapsCounted,
    updatedAt: state.updatedAt || null,
  };
}

/** Historical Fee APR for the 7D and 30D windows. Concurrent callers share a tick. */
/**
 * APR from persisted state, without ticking.
 *
 * Passes the persisted liquidity series rather than null, so the denominator is the same
 * time-weighted figure the tick would use. The APR formula, the 0.30% rate and the
 * coverage rules are untouched — this changes only where the inputs come from.
 */
let aprMemo: (() => Promise<AprSummary>) | null = null;

export async function readApr(): Promise<AprSummary> {
  aprMemo ??= memoizeSnapshotRead(async () => {
    const [state, liquidity] = await Promise.all([loadState(), readLiquidityHistory()]);
    return state.updatedAt === 0 ? EMPTY : summarise(state, liquidity);
  }, SNAPSHOT_TTL_MS);
  return aprMemo();
}

export async function getApr(): Promise<AprSummary> {
  if (cached !== null && Date.now() - cached.at < REFRESH_MS) return cached.value;
  if (inFlight !== null) return inFlight;

  inFlight = runTick()
    .then((value) => {
      cached = { at: Date.now(), value };
      return value;
    })
    .catch((error: unknown) => {
      console.error("[apr] tick failed:", error instanceof Error ? error.message : error);
      return EMPTY;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

export { APR_SCALE };
