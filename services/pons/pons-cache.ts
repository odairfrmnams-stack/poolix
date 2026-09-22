import "server-only";

import { poolixConfig } from "@/config/poolix";
import { PONS_FACTORY_START_BLOCK, PONS_LAST_OBSERVED_LAUNCH_BLOCK } from "@/services/pons/pons-config";
import { workerLog } from "@/services/storage/log";
import { analyticsStore } from "@/services/storage/storage";

/*
  Persistence for the Pons index.

  Uses the Phase 7 storage layer unchanged: schema version and chain id stamped, atomic
  temp-and-rename writes, corrupt or mismatched state discarded and rebuilt rather than
  repaired, and a newer version never migrated downward. This is a NEW dataset — no
  existing dataset is read, written or otherwise touched by anything in this file.

  DURABILITY, stated plainly because it has not changed: local filesystem persistence is
  development-safe but not multi-instance durable production storage. Two instances
  indexing at once will not corrupt a file, but the later write wins and neither can detect
  it happened. This is a single-instance index; it is not distributed indexing and must not
  be described as such.
*/

/**
 * Version 2: the checkpoint changed direction.
 *
 * Version 1 scanned forward from the factory's start block and stored every launch it
 * saw. Version 2 scans backwards from the last observed launch and keeps a bounded recent
 * window, so the semantics of the checkpoint are different and a v1 file cannot be
 * reinterpreted as v2. Bumping the version discards it and rebuilds — which is cheap here,
 * because the window that matters is the newest one and it re-indexes in minutes.
 */
const STATE_VERSION = 2;

/**
 * The most launches held at once.
 *
 * A hard cap, not a target. At roughly 680 bytes per record this keeps the dataset near
 * 7 MB — comparable to the existing analytics caches — where the unbounded version reached
 * 82 MB before it was a third done.
 */
export const PONS_MAX_RECORDS = 10_000;

export interface PonsLaunchRecord {
  /** Lower-cased. */
  readonly tokenAddress: string;
  readonly creatorAddress: string;
  readonly launchBlock: number;
  readonly launchTxHash: string;
  readonly poolAddress: string;
  readonly positionTokenId: string;
  /** Null until read, and left null when it cannot be read completely. */
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  /** Raw `totalSupply()` as a decimal string, so bigint survives JSON. */
  totalSupply: string | null;
  /**
   * True only when the V3 factory independently confirmed the event's pool.
   *
   * This pool is REFERENCE DATA. It is how Poolix knows the token is a Pons launch and
   * where its launch liquidity sits. It is never an execution route — Poolix trades
   * through Uniswap v2 and only through Uniswap v2.
   */
  poolVerified: boolean;
  /** Which side of the Pons pool holds WETH. Null until that pool is verified. */
  quoteIsToken1: boolean | null;

  /*
    Whether this token can actually be traded on Poolix.

    Read from the Uniswap v2 factory, independently of anything Pons published: a token is
    tradeable here when `getPair(token, WETH)` returns a real pair, and not otherwise. A
    Pons token with no v2 pair is a discovery-only listing — it is never routed to v3 as a
    substitute, and no v2 pair is ever inferred from the existence of a v3 one.
  */
  /** The Uniswap v2 pair, or null when the factory returned the zero address. */
  v2PairAddress: string | null;
  /** When the v2 factory was last asked. Null means never asked, which is not "no pair". */
  v2CheckedAt: number | null;
  readonly source: "pons";
  readonly indexedAt: number;
  readonly indexedBlock: number;

  /*
    Figures computed by the WORKER and persisted, never computed during a render.

    The same split Phase 7 established for holders, and for the same reason: pricing 120
    pools and summing a 24-hour swap window inside a page render took static generation
    from 30 seconds to 115, and dragged the indexer's `revalidate: 30` fetch into
    /explore, silently lowering that route's cache window from two minutes. A render now
    reads these fields and does no network work at all.

    All null until a pricing pass reaches the record. Null means "not priced", never zero.
  */
  /** Token price in WETH, scaled 1e18, as a decimal string. */
  priceInQuoteE18: string | null;
  marketCapUsdCents: string | null;
  volume24hUsdCents: string | null;
  volume24hSwaps: number | null;
  /** When the figures above were computed, so the UI can state their age. */
  pricedAt: number | null;
}

export interface PonsState {
  /** Keyed by lower-cased token address: one launch per token, deduplicated on write. */
  byToken: Record<string, PonsLaunchRecord>;
  /**
   * The lowest block scanned so far.
   *
   * Indexing walks BACKWARDS from the factory's last observed launch, so this descends
   * towards the factory's start block and the covered range is
   * `[scannedFrom, PONS_LAST_OBSERVED_LAUNCH_BLOCK]`.
   *
   * Backwards because the feature is recent launches and the dataset has to stay bounded:
   * a forward scan reached 82 MB at a third of the factory's range — five times the
   * largest existing dataset — and filled the list with the oldest launches, which is the
   * opposite of what a discovery surface wants.
   */
  scannedFrom: number;
  /**
   * Which phase the next tick runs.
   *
   * A tick does exactly one of these. Running all three in one tick made a tick take
   * twenty seconds on its own and sixty under contention with the holder worker, which
   * pushed both /explore and /analytics past their prerender budget. One phase per tick
   * is bounded and predictable; indexing is incremental either way.
   */
  phase: "index" | "enrich" | "price";
  updatedAt: number | null;
  /** The 24-hour volume window the persisted figures describe. */
  volumeFromBlock: number;
  volumeToBlock: number;
  /** False when that window was not read completely; every volume figure is then unusable. */
  volumeWindowComplete: boolean;
  /** Whether the ETH/USD feed was available when the figures were computed. */
  quoteUsdAvailable: boolean;
}

/*
  The store stamps `version` and `chainId` on write and checks them on read, so the type
  parameter is the state itself rather than the stamped shape.
*/
const store = analyticsStore<PonsState>(
  "pons",
  STATE_VERSION,
  poolixConfig.chain.id,
  (value: unknown): value is PonsState =>
    typeof value === "object" &&
    value !== null &&
    typeof (value as PonsState).byToken === "object" &&
    (value as PonsState).byToken !== null,
);

function emptyState(): PonsState {
  return {
    byToken: {},
    // Starts at the top of the working range and descends.
    scannedFrom: PONS_LAST_OBSERVED_LAUNCH_BLOCK,
    phase: "index",
    updatedAt: null,
    volumeFromBlock: 0,
    volumeToBlock: 0,
    volumeWindowComplete: false,
    quoteUsdAvailable: false,
  };
}

export async function loadPonsState(): Promise<PonsState> {
  const result = await store.load();
  if (result.value === null) {
    if (result.outcome !== "missing") {
      workerLog.warn({ dataset: "pons", reason: "load", error: result.detail });
    }
    return emptyState();
  }
  const state = result.value;
  const byToken = state.byToken ?? {};

  /*
    Records written before a field existed carry `undefined`, not `null`.

    Every reader tests for null, so an absent field would slip past that check and reach
    `BigInt(undefined)`. Normalising once here means the "null or a value, never absent"
    invariant is true everywhere downstream, and no reader has to remember it. This is
    cheaper and safer than a version bump, which would discard a dataset that is otherwise
    perfectly good and cost hours of re-indexing.
  */
  for (const record of Object.values(byToken)) {
    record.name ??= null;
    record.symbol ??= null;
    record.decimals ??= null;
    record.totalSupply ??= null;
    record.quoteIsToken1 ??= null;
    record.poolVerified ??= false;
    record.v2PairAddress ??= null;
    record.v2CheckedAt ??= null;
    record.priceInQuoteE18 ??= null;
    record.marketCapUsdCents ??= null;
    record.volume24hUsdCents ??= null;
    record.volume24hSwaps ??= null;
    record.pricedAt ??= null;
  }

  return {
    ...emptyState(),
    ...state,
    byToken,
    // The checkpoint can never sit below the factory's first block or above its last
    // observed launch; outside that range there is nothing to read.
    scannedFrom: Math.min(
      Math.max(state.scannedFrom ?? PONS_LAST_OBSERVED_LAUNCH_BLOCK, PONS_FACTORY_START_BLOCK),
      PONS_LAST_OBSERVED_LAUNCH_BLOCK,
    ),
    phase: state.phase ?? "index",
    volumeFromBlock: state.volumeFromBlock ?? 0,
    volumeToBlock: state.volumeToBlock ?? 0,
    volumeWindowComplete: state.volumeWindowComplete ?? false,
    quoteUsdAvailable: state.quoteUsdAvailable ?? false,
  };
}

export async function savePonsState(state: PonsState): Promise<void> {
  await store.save(state);
}
