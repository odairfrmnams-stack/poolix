import "server-only";


import { poolixConfig } from "@/config/poolix";
import { workerLog } from "@/services/storage/log";
import { memoizeSnapshotRead, SNAPSHOT_TTL_MS } from "@/services/storage/snapshot-read";
import { analyticsStore } from "@/services/storage/storage";
import { confirmBalances } from "@/services/analytics/holders-confirm";
import {
  applyTransfers,
  candidateAddresses,
  confirmationOrder,
  countMismatches,
  isPublishable,
  mergeConfirmation,
  needsConfirmation,
  tokenTimeSlice,
  TRANSFER_TOPIC0,
  uniqueTokens,
  unionHolders,
  type TransferLogLike,
} from "@/services/analytics/holders-math";
import { fetchBlockNumber } from "@/services/chain/rpc";

/*
  Unique addresses holding a positive balance of any token in Poolix's scanned pool
  universe, at the latest block.

  Two stages, because neither alone is both cheap and true:

  1. Replay every Transfer of each token from block 0, via HyperSync. Holders are current
     state, not a rolling window — counting recipients of recent transfers would report
     people who have since sold — so the whole history is replayed, then checkpointed so
     later refreshes read only new blocks.

  2. Ask each token contract for `balanceOf` on every address that replay touched, and
     publish that. Stage 1 finds who might hold; stage 2 decides who does. The reason is
     concrete: PAIDCAT in this universe emits Transfer events backed by no state change,
     and trusting them would have reported 918 holders for a token with 30, inflating the
     chain-wide figure by about 60%.

  Measured before building: 6 tokens, ~7,000 Transfer events across all history, ~2,500
  candidate addresses. Both stages complete in seconds.

  The checkpoint lives on the filesystem, which on a serverless host such as Vercel is
  per-instance and does not survive a cold start. Losing it costs a rebuild, not accuracy:
  a fresh instance replays from block 0, and until it has finished the page shows "Data
  unavailable" rather than a partial count. A shared store would be the fix if the token
  universe ever grows past what one instance can rebuild inside a request.

  WETH is deliberately absent. The scanner records only the non-WETH side of each pool as
  its token (`DiscoveredPool.other`), so WETH is the quote asset rather than a member of
  the token universe; including it would count a token the scanner does not enumerate.
*/

const HYPERSYNC_URL = "https://4663.hypersync.xyz/query";
const HEIGHT_URL = "https://4663.hypersync.xyz/height";

const TICK_BUDGET_MS = 25_000;
/** Balances for tokens that have rotated out of the universe, kept to avoid re-scanning. */
const MAX_CACHED_TOKENS = 100;
/**
 * How long a confirmation stands before every balance is read again.
 *
 * Long because a full re-read of ten tokens is thousands of calls. New candidates do not
 * wait for it — they are confirmed as they appear — so this governs only how stale an
 * unchanged balance may get, not whether the holder list covers everyone.
 *
 * Kept short deliberately. Stretching it to fifteen minutes did buy throughput, and the
 * cost showed up immediately as accuracy: the oldest balance behind a published figure
 * drifted to roughly 25 minutes, and an independent recount taken at the current tip
 * disagreed by about 3% — real transfers in the gap, not an error, but a figure further
 * from the chain than it needs to be.
 *
 * Throughput no longer has to be bought this way. Progress is monotonic because a partial
 * pass keeps its answers, so a slow refresh delays freshness rather than preventing
 * convergence, and batching balanceOf at 25 made the re-read itself about 2.4x cheaper.
 */
const CONFIRM_TTL_MS = 5 * 60_000;
/**
 * Candidates offered to one token per tick, so one busy token cannot starve the rest.
 *
 * Sized to what a tick can actually deliver. Measured at batch 25, this endpoint answers
 * balanceOf at roughly 12-25ms per call, so a 25-second budget buys on the order of a
 * thousand. The old 3,000 needed about 115 seconds — over four times the budget — which
 * guaranteed every pass was cut short.
 *
 * Overshooting is no longer harmful now that a partial pass keeps its answers, so this is
 * a fairness device rather than a correctness one: it bounds how much of a tick a single
 * token can take before the next one is offered a turn.
 */
const MAX_CONFIRM_PER_TICK = 1_200;
/**
 * How old a confirmation may be and still be published. Blocks arrive every couple of
 * seconds, so pinning the figure to the exact current height would make it flicker in and
 * out on every render; this keeps it stable while bounding how stale it can get.
 */
const CONFIRM_MAX_AGE_MS = 30 * 60_000;

// Bumped whenever TokenState gains a field, so an older file is rebuilt rather than read
// with the new field missing — which would type as a number and arrive as undefined.
const STATE_VERSION = 6;

interface TokenState {
  /** Exclusive upper bound of the blocks already replayed. */
  syncedTo: number;
  /** Replayed balances for every address ever seen, including zero and negative ones. */
  replayed: Record<string, string>;
  transfers: number;
  lastSeen: number;
  /** Addresses the contract reports a positive balance for. Empty until confirmed. */
  holders: string[];
  /**
   * How many candidates that holder list was built from.
   *
   * This is what ties a confirmation to the replay it belongs to. Without it a token
   * confirmed while its sweep had found nothing keeps an empty holder list after the
   * sweep fills in, and the page publishes zero holders for a token that has them.
   * A changed candidate count means addresses appeared that the confirmation never
   * asked about, so it is no longer an answer to the current question.
   */
  confirmedCandidates: number;
  /**
   * Candidates the replay has found since the last confirmation, awaiting a first
   * balance read.
   *
   * An actively traded token gains an address every few seconds. Voiding its whole
   * confirmation each time would mean it could never be published at all, so the new
   * arrivals are confirmed on their own and merged in — which keeps the holder list
   * covering every current candidate without re-reading thousands of unchanged ones.
   */
  pendingConfirm: string[];
  /** True while a queued full refresh is still draining. */
  refreshQueued: boolean;
  /** When the holder list last covered every candidate. Governs publishability. */
  confirmedAt: number;
  /** When every balance was last actually re-read. Governs the refresh timer. */
  fullConfirmAt: number;
  confirmedBlock: number | null;
  /** Replayed balances the contract disagreed with, at that confirmation. */
  mismatches: number;
}

/**
 * What the last tick actually published, recorded so the figure on the page can be
 * checked rather than guessed at.
 *
 * The token universe shifts between runs — the pool scan covers a moving window and
 * shrinks when the endpoint throttles — so a verifier that discovers its own universe
 * would be comparing two different questions. Writing the universe down makes the
 * comparison exact instead of approximate.
 */
interface PublishedSnapshot {
  universe: string[];
  holders: number;
  tokenCount: number;
  tokensConfirmed: number;
  complete: boolean;
  latestBlock: number;
  confirmedBlock: number | null;
  at: number;
}

interface PersistedState {
  version: number;
  chainId: number;
  tokens: Record<string, TokenState>;
  latestBlock: number | null;
  updatedAt: number;
  published: PublishedSnapshot | null;
}

export interface HoldersSummary {
  readonly available: boolean;
  /** Unique addresses confirmed by `balanceOf` to hold at least one scanned token. */
  readonly holders: number;
  /** Tokens in the current scanned universe. */
  readonly tokenCount: number;
  /** How many of those are replayed and confirmed against the contract. */
  readonly tokensConfirmed: number;
  readonly transfersProcessed: number;
  /** Candidate addresses the contracts were asked about. */
  readonly candidates: number;
  /**
   * Candidates whose replayed balance the contract disagreed with. Two causes, not
   * distinguished here: blocks landing between the sweep and the read, and tokens whose
   * Transfer events do not describe their balances.
   */
  readonly mismatches: number;
  /**
   * HyperSync's height. This is the indexing reference — the block the Transfer sweep
   * covered to, and therefore what the candidate set is complete as of. It is NOT the
   * block the balances come from.
   */
  readonly latestBlock: number | null;
  /**
   * The chain tip when the balance reads began. The reads themselves use the `latest`
   * tag, because this endpoint makes no archive guarantee, so the balances are current
   * chain state sampled around this block rather than a pinned snapshot of it.
   */
  readonly confirmedBlock: number | null;
  readonly complete: boolean;
  readonly updatedAt: number | null;
}

const EMPTY: HoldersSummary = {
  available: false,
  holders: 0,
  tokenCount: 0,
  tokensConfirmed: 0,
  transfersProcessed: 0,
  candidates: 0,
  mismatches: 0,
  latestBlock: null,
  confirmedBlock: null,
  complete: false,
  updatedAt: null,
};

const token = () => process.env.ENVIO_API_TOKEN?.trim() ?? "";

// ---------------------------------------------------------------- persistence

function emptyState(): PersistedState {
  return {
    version: STATE_VERSION,
    chainId: poolixConfig.chain.id,
    tokens: {},
    latestBlock: null,
    updatedAt: 0,
    published: null,
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
  "holders",
  STATE_VERSION,
  poolixConfig.chain.id,
  (value: unknown): value is PersistedState =>
    typeof value === "object" && value !== null && typeof (value as PersistedState).tokens === "object",
);

async function loadState(): Promise<PersistedState> {
  const result = await store.load();
  if (result.value === null) {
    // "missing" is an ordinary cold start; anything else means state was thrown away and
    // is worth saying out loud rather than silently rebuilding.
    if (result.outcome !== "missing") {
      workerLog.warn({ dataset: "holders", reason: "load", error: result.detail });
    }
    return emptyState();
  }
  const state = result.value;
  return {
    ...emptyState(),
    ...state,
    tokens: state.tokens ?? {},
  };
}

async function saveState(state: PersistedState): Promise<void> {
  await store.save(state);
}

// ------------------------------------------------------------------ hypersync

async function fetchHeight(): Promise<number | null> {
  try {
    const res = await fetch(HEIGHT_URL, { next: { revalidate: 30 } });
    if (!res.ok) return null;
    const json: unknown = await res.json();
    const height = (json as { height?: number }).height;
    return typeof height === "number" ? height : null;
  } catch {
    return null;
  }
}

interface TransferSweep {
  readonly logs: TransferLogLike[];
  readonly complete: boolean;
}

/**
 * Reads every Transfer emitted by one token between two blocks. A partial sweep is
 * reported as such so the caller can leave the checkpoint where it was and retry, rather
 * than recording a balance built from half the history.
 */
async function sweepTransfers(
  tokenAddress: string,
  fromBlock: number,
  toBlock: number,
  deadline: number,
): Promise<TransferSweep> {
  const logs: TransferLogLike[] = [];
  let cursor = fromBlock;

  while (cursor < toBlock) {
    if (Date.now() >= deadline) return { logs, complete: false };

    try {
      const res = await fetch(HYPERSYNC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token()}` },
        body: JSON.stringify({
          from_block: cursor,
          to_block: toBlock,
          logs: [{ address: [tokenAddress], topics: [[TRANSFER_TOPIC0]] }],
          field_selection: { log: ["topic1", "topic2", "data"] },
        }),
      });
      if (!res.ok) return { logs, complete: false };

      const json = (await res.json()) as {
        data?: { logs?: TransferLogLike[] }[];
        next_block?: number;
      };
      for (const batch of json.data ?? []) logs.push(...(batch.logs ?? []));

      const next = json.next_block ?? toBlock;
      if (next <= cursor) return { logs, complete: false };
      cursor = Math.min(next, toBlock);
    } catch {
      return { logs, complete: false };
    }
  }

  return { logs, complete: true };
}

// ----------------------------------------------------------------------- tick

/** Stage 1: bring one token's replayed balances up to `height`. */
async function replayToken(
  state: PersistedState,
  tokenAddress: string,
  height: number,
  deadline: number,
  now: number,
): Promise<void> {
  const existing = state.tokens[tokenAddress];
  const from = existing?.syncedTo ?? 0;
  if (from >= height) return;

  const sweep = await sweepTransfers(tokenAddress, from, height, deadline);
  if (!sweep.complete) return; // Leave the checkpoint alone and retry next tick.

  const previousBalances = Object.entries(existing?.replayed ?? {});
  const previous = new Map<string, bigint>(previousBalances.map(([address, value]) => [address, BigInt(value)]));
  const known = new Set(previous.keys());
  const sheet = applyTransfers(sweep.logs, previous);

  // Addresses this sweep introduced. They have never had a balance read, so they are
  // queued rather than silently treated as absent.
  const pending = new Set(existing?.pendingConfirm ?? []);
  for (const address of sheet.balances.keys()) {
    if (!known.has(address)) pending.add(address);
  }

  state.tokens[tokenAddress] = {
    syncedTo: height,
    replayed: Object.fromEntries([...sheet.balances].map(([address, value]) => [address, value.toString()])),
    transfers: (existing?.transfers ?? 0) + sheet.applied,
    lastSeen: now,
    holders: existing?.holders ?? [],
    confirmedCandidates: existing?.confirmedCandidates ?? -1,
    pendingConfirm: [...pending],
    refreshQueued: existing?.refreshQueued ?? false,
    confirmedAt: existing?.confirmedAt ?? 0,
    fullConfirmAt: existing?.fullConfirmAt ?? 0,
    confirmedBlock: existing?.confirmedBlock ?? null,
    mismatches: existing?.mismatches ?? 0,
  };
}

/**
 * Stage 2: replace one token's holder list with what the contract reports.
 *
 * `atBlock` is the chain tip when the pass started, which is what the balances are read
 * at — not the HyperSync height the candidates came from. The two are usually seconds
 * apart, and recording the one the reads actually used is the only honest label.
 */
async function confirmToken(
  state: PersistedState,
  tokenAddress: string,
  height: number,
  atBlock: number,
  deadline: number,
  now: number,
): Promise<void> {
  const entry = state.tokens[tokenAddress];
  if (!entry || entry.syncedTo < height) return;

  const replayed = new Map<string, bigint>(
    Object.entries(entry.replayed).map(([address, value]) => [address, BigInt(value)]),
  );
  /*
    Every candidate is asked about, however many there are.

    A cap here used to skip large tokens outright, which meant the universe could never be
    fully confirmed while one was in it and the holder count was never published at all.
    A token is now bounded by how many ticks it takes, not by whether it is attempted:
    the queue drains a slice per tick and keeps what it reads.
  */
  const candidates = candidateAddresses(replayed);

  const needed = needsConfirmation(
    {
      candidates: candidates.length,
      confirmedCandidates: entry.confirmedCandidates,
      confirmedBlock: entry.confirmedBlock,
      // The refresh timer runs off the last complete re-read, not off the last time the
      // list happened to cover everyone.
      ageMs: now - entry.fullConfirmAt,
    },
    CONFIRM_TTL_MS,
  );
  if (!needed) return;

  /*
    A full re-read when the whole picture is due; otherwise just the new arrivals.

    The distinction matters for liveness. On an actively traded token the candidate set
    grows every tick, and re-reading nine hundred balances each time would never finish
    inside the budget, so the token would stay unpublishable forever. Reading only the
    arrivals costs a handful of calls and still leaves the holder list covering every
    current candidate.
  */
  /*
    Everything is a queue drain, including a full refresh.

    Reading thousands of balances in one go fails on this endpoint and, because a partial
    read is discarded rather than published, failing means never finishing. So a refresh
    queues every candidate and the queue is worked off a bounded piece at a time, keeping
    the progress it makes. The token stays unpublishable until the queue empties, so a
    half-drained queue is never mistaken for a complete answer.
  */
  const known = new Set(candidates);
  let pending = entry.pendingConfirm.filter((address) => known.has(address));

  const dueForRefresh = entry.fullConfirmAt === 0 || now - entry.fullConfirmAt >= CONFIRM_TTL_MS;
  if (dueForRefresh && !entry.refreshQueued) {
    pending = [...candidates];
    entry.refreshQueued = true;
    entry.mismatches = 0; // Recounted over the pass that is starting.
  }

  if (pending.length === 0) {
    entry.confirmedCandidates = candidates.length;
    entry.pendingConfirm = [];
    return;
  }

  const subject = pending.slice(0, MAX_CONFIRM_PER_TICK);
  const confirmed = await confirmBalances(tokenAddress, subject, deadline);

  /*
    Whatever answered is kept, even when the pass was cut short.

    Discarding a partial pass was the bug that stopped this converging. A slice that cannot
    be read inside one tick returns `complete: false` every time, so the old code threw
    away every balance it had just read and returned — and a token too large for one tick
    made exactly zero progress no matter how many ticks it got. It was not slow; it was
    stationary.

    Keeping the answers is safe because publishability is governed by the QUEUE, not by
    this pass: an unanswered address stays in `pendingConfirm` rather than being recorded
    as a zero balance, and `confirmedCandidates` is only set once that queue is empty. So
    progress accumulates while a half-finished token stays unpublishable.
  */
  const merged = mergeConfirmation({
    holders: entry.holders,
    queue: pending,
    answered: confirmed.balances,
  });

  entry.holders = merged.holders;
  entry.mismatches += countMismatches(replayed, confirmed.balances);
  entry.pendingConfirm = merged.pending;
  // Only a pass that actually read something can date the holder list.
  if (confirmed.balances.size > 0) entry.confirmedBlock = atBlock;

  if (merged.complete) {
    entry.confirmedCandidates = candidates.length;
    entry.confirmedAt = now;
    if (entry.refreshQueued) {
      entry.fullConfirmAt = now;
      entry.refreshQueued = false;
    }
  }
}

let inFlight: Promise<HoldersSummary> | null = null;

async function runTick(tracked: readonly string[]): Promise<HoldersSummary> {
  if (token() === "") return EMPTY;

  const height = await fetchHeight();
  if (height === null) return EMPTY;

  /*
    Exactly the tokens the page reports as tracked — passed in rather than rediscovered,
    so "N tokens tracked" and "holders across those tokens" can never describe different
    sets. uniqueTokens is still applied because it is the normalising step that makes a
    token found through two pools one token.
  */
  const universe = uniqueTokens(tracked);
  if (universe.length === 0) return { ...EMPTY, available: true, latestBlock: height };

  const state = await loadState();
  const deadline = Date.now() + TICK_BUDGET_MS;
  const now = Date.now();

  for (const tokenAddress of universe) {
    const existing = state.tokens[tokenAddress];
    if (existing) existing.lastSeen = now;
    if (Date.now() >= deadline) break;
    await replayToken(state, tokenAddress, height, deadline, now);
  }

  // The tip the balances are read at. Without it there is no honest way to say which
  // block the published figure describes, so nothing is confirmed this tick.
  const tip = await fetchBlockNumber();
  if (tip !== null) {
    /*
      Never-confirmed tokens first, cheapest of those first, then refreshes by staleness.
      Confirming in universe order instead lets the first few tokens eat the budget every
      tick and the last ones never get confirmed at all.
    */
    const order = confirmationOrder(
      universe.map((token) => {
        const entry = state.tokens[token];
        return {
          token,
          confirmedAt: entry?.confirmedAt ?? 0,
          // What is actually left to read. A token yet to be swept reports its whole
          // candidate set, so it is not mistaken for a cheap one.
          outstanding:
            entry === undefined
              ? Number.MAX_SAFE_INTEGER
              : entry.pendingConfirm.length > 0
                ? entry.pendingConfirm.length
                : Object.keys(entry.replayed).length,
        };
      }),
    );

    for (const [index, tokenAddress] of order.entries()) {
      if (Date.now() >= deadline) break;
      // Each token gets a share of what is left, so one enormous token cannot spend the
      // whole tick and starve the rest. Unused time falls through to the tokens behind it.
      const slice = tokenTimeSlice(Date.now(), deadline, order.length - index);
      await confirmToken(state, tokenAddress, height, tip, Math.min(deadline, Date.now() + slice), now);
    }
  }

  // Evict balances for tokens that rotated out of the universe long ago.
  const cached = Object.entries(state.tokens);
  if (cached.length > MAX_CACHED_TOKENS) {
    cached
      .sort((a, b) => (b[1].lastSeen ?? 0) - (a[1].lastSeen ?? 0))
      .slice(MAX_CACHED_TOKENS)
      .forEach(([address]) => delete state.tokens[address]);
  }

  // Count only tokens in the current universe, replayed to this height and confirmed
  // against their contract recently enough to still be worth publishing.
  let tokensConfirmed = 0;
  let transfersProcessed = 0;
  let candidates = 0;
  let mismatches = 0;
  let confirmedBlock: number | null = null;
  const perToken: Set<string>[] = [];

  for (const tokenAddress of universe) {
    const entry = state.tokens[tokenAddress];
    if (!entry || entry.syncedTo < height) continue;

    /*
      A token with no Transfer history at all has not been indexed yet, rather than
      having no holders. The pool scan reads the chain at `latest` while the sweep runs
      to HyperSync's height, which trails it, so a pair created in that gap is discovered
      before any of its transfers are visible. Its pool holds liquidity, which can only
      have arrived by transfer, so zero here is a missing reading and publishing it as a
      count would understate the total while claiming to be complete.
    */
    if (entry.transfers === 0) continue;

    const tokenCandidates = Object.keys(entry.replayed).length;
    const publishable = isPublishable(
      {
        candidates: tokenCandidates,
        confirmedCandidates: entry.confirmedCandidates,
        confirmedBlock: entry.confirmedBlock,
        ageMs: now - entry.confirmedAt,
      },
      CONFIRM_MAX_AGE_MS,
    );
    if (!publishable || entry.confirmedBlock === null) continue;

    confirmedBlock = confirmedBlock === null ? entry.confirmedBlock : Math.min(confirmedBlock, entry.confirmedBlock);
    tokensConfirmed++;
    transfersProcessed += entry.transfers;
    candidates += tokenCandidates;
    mismatches += entry.mismatches;
    perToken.push(new Set(entry.holders));
  }

  const summary: HoldersSummary = {
    available: true,
    holders: unionHolders(perToken).size,
    tokenCount: universe.length,
    tokensConfirmed,
    transfersProcessed,
    candidates,
    mismatches,
    latestBlock: height,
    confirmedBlock,
    complete: tokensConfirmed === universe.length,
    updatedAt: now,
  };

  // Written after the summary, not before, so the file records what was actually
  // published rather than what was merely collected. npm run verify:holders reads this
  // to check the rendered figure against an independent recount of the same universe.
  state.latestBlock = height;
  state.updatedAt = now;
  state.published = {
    universe,
    holders: summary.holders,
    tokenCount: summary.tokenCount,
    tokensConfirmed: summary.tokensConfirmed,
    complete: summary.complete,
    latestBlock: height,
    confirmedBlock,
    at: now,
  };
  await saveState(state);

  return summary;
}

/**
 * The last published holder figure, read from disk without doing any work.
 *
 * WHY THIS EXISTS. `getHolders` runs a tick, and a tick is allowed to spend its whole
 * budget confirming balances — which is correct for the worker and wrong for a page
 * render. A token with tens of thousands of candidates makes every render pay 25 seconds,
 * and /analytics was observed finishing its prerender at 61s against Next's 60s ceiling.
 * A page should not be able to fail because a background backlog is large.
 *
 * So rendering reads the snapshot the worker already published, and nothing else. No
 * network, no confirmation, no balanceOf.
 *
 * Nothing about the figure changes. This returns exactly what the last completed tick
 * decided to publish under exactly the same rules: a count appears only when every token
 * in the universe was fully confirmed, an unanswered candidate is still not a zero, and an
 * incomplete universe still reports `complete: false` for the page to render as "--".
 * Staleness is visible through `updatedAt` and `latestBlock` rather than hidden.
 */
let holdersMemo: (() => Promise<HoldersSummary>) | null = null;

export async function readPublishedHolders(): Promise<HoldersSummary> {
  holdersMemo ??= memoizeSnapshotRead(readPublishedHoldersUncached, SNAPSHOT_TTL_MS);
  return holdersMemo();
}

/*
  The read itself. Memoised above because the holders file is 16 MB: parsing it per caller
  made five concurrent requests cost 4.3x one request, all to re-read bytes that cannot
  have changed between the tick that wrote them and the next.
*/
async function readPublishedHoldersUncached(): Promise<HoldersSummary> {
  const state = await loadState();
  const published = state.published;
  if (published === null) return EMPTY;

  /*
    Counts recomputed from the same persisted token records the snapshot was published
    from. This is an in-memory pass over data already on disk — it reads no chain state and
    can reach no different conclusion than the tick that wrote it.
  */
  let transfersProcessed = 0;
  let candidates = 0;
  let mismatches = 0;
  for (const tokenAddress of published.universe) {
    const entry = state.tokens[tokenAddress];
    if (entry === undefined) continue;
    transfersProcessed += entry.transfers;
    candidates += Object.keys(entry.replayed).length;
    mismatches += entry.mismatches;
  }

  return {
    available: true,
    holders: published.holders,
    tokenCount: published.tokenCount,
    tokensConfirmed: published.tokensConfirmed,
    transfersProcessed,
    candidates,
    mismatches,
    latestBlock: published.latestBlock,
    confirmedBlock: published.confirmedBlock,
    complete: published.complete,
    updatedAt: published.at || null,
  };
}

/**
 * Rebuilds or refreshes holder balances and returns the current unique holder count.
 * Concurrent callers share one tick so page renders cannot stack sweeps.
 *
 * This is the WORKER path: it is allowed to spend a full tick budget. A page render should
 * call `readPublishedHolders` instead, which never waits for confirmation.
 *
 * `tracked` is the token universe the page is reporting, which the caller owns so the two
 * figures are guaranteed to describe the same set.
 */
export async function getHolders(tracked: readonly string[]): Promise<HoldersSummary> {
  if (inFlight !== null) return inFlight;
  inFlight = runTick(tracked)
    .catch(() => EMPTY)
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}
