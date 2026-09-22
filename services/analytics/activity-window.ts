import "server-only";


import { poolixConfig } from "@/config/poolix";
import { workerLog } from "@/services/storage/log";
import { analyticsStore } from "@/services/storage/storage";
import {
  ACTIVITY_TOPICS,
  collectActivity,
  mergeBucket,
  summariseActivity,
  type ActivityLogLike,
  type ActivityTxLike,
  type StoredActivityBucket,
} from "@/services/analytics/activity-math";

/*
  A rolling 24h count of Uniswap v2 transactions and the accounts that originated them,
  covering Swap, Mint and Burn across every pair on the chain.

  Same bootstrap-then-incremental shape as swap-window.ts, and deliberately a separate
  module with its own state file: the volume window is working and must not be disturbed,
  and the address sets here are two orders of magnitude larger than its bucket totals.

  Measured before building: 24h is roughly 120,000 events, ~115,000 transactions and
  ~90,000 stored addresses (~3.7MB), at ~120 requests.
*/

const HYPERSYNC_URL = "https://4663.hypersync.xyz/query";
const HEIGHT_URL = "https://4663.hypersync.xyz/height";

const WINDOW_BLOCKS = 864_000; // 24h at ~0.1s per block — identical to swap-window.ts
const BUCKET_BLOCKS = 7_200; // ~12 minutes
const TICK_BUDGET_MS = 15_000;
const BOOTSTRAP_CHUNK = 60_000;

const STATE_VERSION = 1;

interface PersistedState {
  version: number;
  chainId: number;
  buckets: Record<string, StoredActivityBucket>;
  head: number | null;
  tail: number | null;
  updatedAt: number;
}

export interface ActivityWindowSummary {
  /** False when no ENVIO_API_TOKEN is configured — the UI must show `--`, not a zero. */
  readonly available: boolean;
  readonly transactions: number;
  readonly activeUsers: number;
  readonly coveredBlocks: number;
  readonly windowBlocks: number;
  readonly complete: boolean;
  readonly updatedAt: number | null;
}

const EMPTY: ActivityWindowSummary = {
  available: false,
  transactions: 0,
  activeUsers: 0,
  coveredBlocks: 0,
  windowBlocks: WINDOW_BLOCKS,
  complete: false,
  updatedAt: null,
};

const token = () => process.env.ENVIO_API_TOKEN?.trim() ?? "";

/**
 * Contracts that must never be counted as users. Transaction senders are EOAs by
 * construction, so this is a guard rather than a filter that is expected to fire.
 */
function excludedAddresses(): ReadonlySet<string> {
  const { uniswapV2 } = poolixConfig.contracts;
  const addresses = [
    uniswapV2.router.status === "configured" ? uniswapV2.router.address : null,
    uniswapV2.factory.status === "configured" ? uniswapV2.factory.address : null,
    poolixConfig.contracts.weth,
  ].filter((address): address is `0x${string}` => address !== null);
  return new Set(addresses.map((address) => address.toLowerCase()));
}

// ---------------------------------------------------------------- persistence

function emptyState(): PersistedState {
  return { version: STATE_VERSION, chainId: poolixConfig.chain.id, buckets: {}, head: null, tail: null, updatedAt: 0 };
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
  "activity-window",
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
      workerLog.warn({ dataset: "activity-window", reason: "load", error: result.detail });
    }
    return emptyState();
  }
  const state = result.value;
  return {
    ...emptyState(),
    ...state,
    buckets: state.buckets ?? {},
  };
}

async function saveState(state: PersistedState): Promise<void> {
  await store.save(state);
}

// ------------------------------------------------------------------ hypersync

async function fetchHeight(): Promise<number | null> {
  try {
    // A bounded revalidate rather than no-store, which would force the whole page to
    // render dynamically and run a tick on every visitor request.
    const res = await fetch(HEIGHT_URL, { next: { revalidate: 30 } });
    if (!res.ok) return null;
    const json: unknown = await res.json();
    const height = (json as { height?: number }).height;
    return typeof height === "number" ? height : null;
  } catch {
    return null;
  }
}

interface ActivityPage {
  readonly logs: ActivityLogLike[];
  readonly transactions: ActivityTxLike[];
  readonly nextBlock: number;
}

/** One HyperSync page. Logs and transactions are nested per batch under `data`. */
async function fetchActivityPage(fromBlock: number, toBlock: number): Promise<ActivityPage | null> {
  try {
    const res = await fetch(HYPERSYNC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token()}` },
      body: JSON.stringify({
        from_block: fromBlock,
        to_block: toBlock,
        logs: [{ topics: [[...ACTIVITY_TOPICS]] }],
        field_selection: {
          log: ["block_number", "transaction_hash"],
          transaction: ["hash", "from", "block_number"],
        },
      }),
    });
    if (!res.ok) return null;

    const json = (await res.json()) as {
      data?: { logs?: ActivityLogLike[]; transactions?: ActivityTxLike[] }[];
      next_block?: number;
    };
    const batches = json.data ?? [];
    return {
      logs: batches.flatMap((batch) => batch.logs ?? []),
      transactions: batches.flatMap((batch) => batch.transactions ?? []),
      nextBlock: json.next_block ?? toBlock,
    };
  } catch {
    return null;
  }
}

// ----------------------------------------------------------------- ingestion

interface CollectResult {
  readonly buckets: Map<number, { txHashes: Set<string>; senders: Set<string> }>;
  readonly complete: boolean;
  readonly reached: number;
}

/**
 * Reads a block range into standalone bucket sets without touching persisted state, so a
 * partial read can be discarded. Transaction counts are additive on merge, which makes
 * re-reading a range a double count — discarding is what keeps that from happening.
 */
async function collectRange(fromBlock: number, toBlock: number, deadline: number): Promise<CollectResult> {
  const buckets = new Map<number, { txHashes: Set<string>; senders: Set<string> }>();
  const exclude = excludedAddresses();
  let cursor = fromBlock;

  while (cursor < toBlock) {
    if (Date.now() >= deadline) return { buckets, complete: false, reached: cursor };

    const page = await fetchActivityPage(cursor, toBlock);
    if (page === null) return { buckets, complete: false, reached: cursor };

    for (const [key, activity] of collectActivity(page.logs, page.transactions, BUCKET_BLOCKS, exclude)) {
      const existing = buckets.get(key);
      if (existing) {
        for (const hash of activity.txHashes) existing.txHashes.add(hash);
        for (const sender of activity.senders) existing.senders.add(sender);
      } else {
        buckets.set(key, activity);
      }
    }

    if (page.nextBlock <= cursor) return { buckets, complete: false, reached: cursor };
    cursor = Math.min(page.nextBlock, toBlock);
  }

  return { buckets, complete: true, reached: cursor };
}

function mergeCollected(
  state: PersistedState,
  collected: ReadonlyMap<number, { txHashes: Set<string>; senders: Set<string> }>,
): void {
  for (const [bucketStart, activity] of collected) {
    const key = String(bucketStart);
    state.buckets[key] = mergeBucket(state.buckets[key], activity);
  }
}

// ----------------------------------------------------------------------- tick

let inFlight: Promise<ActivityWindowSummary> | null = null;

function summarise(state: PersistedState, height: number): ActivityWindowSummary {
  const windowStart = height - WINDOW_BLOCKS;
  const { transactions, activeUsers } = summariseActivity(state.buckets, windowStart);

  const tail = state.tail ?? height;
  const head = state.head ?? height;

  return {
    available: true,
    transactions,
    activeUsers,
    coveredBlocks: Math.max(0, head - Math.max(tail, windowStart)),
    windowBlocks: WINDOW_BLOCKS,
    complete: tail <= windowStart,
    updatedAt: state.updatedAt || null,
  };
}

async function runTick(): Promise<ActivityWindowSummary> {
  if (token() === "") return EMPTY;

  const height = await fetchHeight();
  if (height === null) {
    const state = await loadState();
    return state.head === null ? EMPTY : summarise(state, state.head);
  }

  const state = await loadState();
  const deadline = Date.now() + TICK_BUDGET_MS;
  const windowStart = height - WINDOW_BLOCKS;

  if (state.head === null || state.tail === null) {
    state.head = height;
    state.tail = height;
  }

  // Forward: contiguous with what came before, so a partial read is safe to keep.
  if (state.head < height) {
    const forward = await collectRange(state.head, height, deadline);
    mergeCollected(state, forward.buckets);
    state.head = forward.complete ? height : Math.max(state.head, forward.reached);
  }

  // Backward: only whole chunks are merged, because the tail pointer cannot describe a
  // hole and a re-read would double count transactions.
  while (state.tail > windowStart && Date.now() < deadline) {
    const from = Math.max(windowStart, state.tail - BOOTSTRAP_CHUNK);
    const backward = await collectRange(from, state.tail, deadline);
    if (!backward.complete) break;
    mergeCollected(state, backward.buckets);
    state.tail = from;
  }

  for (const key of Object.keys(state.buckets)) {
    if (Number(key) < windowStart - BUCKET_BLOCKS) delete state.buckets[key];
  }

  state.updatedAt = Date.now();
  await saveState(state);
  return summarise(state, height);
}

/**
 * Advances the activity window by one bounded tick and returns the current 24h totals.
 * Concurrent callers share a single tick so page renders cannot stack sweeps onto a
 * rate-limited endpoint.
 */
export async function getActivityWindow(): Promise<ActivityWindowSummary> {
  if (inFlight !== null) return inFlight;
  inFlight = runTick()
    .catch(() => EMPTY)
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

export { BUCKET_BLOCKS as ACTIVITY_BUCKET_BLOCKS, WINDOW_BLOCKS as ACTIVITY_WINDOW_BLOCKS };
