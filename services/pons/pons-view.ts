import "server-only";

import { PONS_DISCOVERY_CONFIG, PONS_POOL_FEE, ponsContracts } from "@/services/pons/pons-config";
import { readPonsIndex, type PonsIndexSummary } from "@/services/pons/pons-indexer";
import { qualify, type DisqualificationReason } from "@/services/pons/pons-math";
import { VOLUME_WINDOW_BLOCKS } from "@/services/pons/pons-volume";
import { memoizeSnapshotRead, SNAPSHOT_TTL_MS } from "@/services/storage/snapshot-read";

/*
  The Pons view: a pure projection of persisted state onto rows the UI can render.

  IT DOES NO NETWORK WORK. Every price, market cap and volume figure was computed by the
  indexer tick and written to the dataset. The first version of this file priced pools and
  summed a swap window during the render, which took static generation from 30 seconds to
  115 and pulled the indexer's `revalidate: 30` fetch into /explore, quietly cutting that
  route's cache window from two minutes. This is the Phase 7 split — a worker advances, a
  render reads — applied to Pons.

  Qualification is evaluated here rather than persisted, because it is a pure function of
  two stored numbers and the configured thresholds. Persisting it would mean a stale
  verdict survives a threshold change.
*/

export type PonsStatus = "new" | "active" | "graduated";

/**
 * Whether Poolix can trade this token.
 *
 * The actionable fact about a Pons launch, and the one the Explore table leads with. It is
 * decided solely by the Uniswap v2 factory:
 *
 *   available     — `getPair(token, WETH)` returned a real pair. The existing Poolix v2
 *                   swap, LP and analytics flows apply, unchanged.
 *   unavailable   — the factory returned the zero address. The token is discovery-only.
 *                   Poolix does not offer a trade and does not send the user to v3 as a
 *                   substitute.
 *   unknown       — the factory has not been asked yet. Deliberately distinct from
 *                   "unavailable", because a read that has not happened is not a no.
 */
export type V2Availability = "available" | "unavailable" | "unknown";

export interface PonsTokenRow {
  readonly tokenAddress: string;
  readonly creatorAddress: string;
  readonly symbol: string | null;
  readonly name: string | null;
  readonly decimals: number | null;
  readonly totalSupply: string | null;
  readonly launchBlock: number;
  readonly launchTxHash: string;
  /** The Pons launch pool on Uniswap v3. Reference data; never an execution route. */
  readonly poolAddress: string;
  readonly positionTokenId: string;
  readonly poolVerified: boolean;
  /** Whether Poolix's Uniswap v2 core can trade this token. */
  readonly v2Availability: V2Availability;
  /** The Uniswap v2 pair, when one exists. */
  readonly v2PairAddress: string | null;
  readonly source: "pons";
  readonly priceInQuoteE18: string | null;
  readonly marketCapUsdCents: string | null;
  readonly volume24hUsdCents: string | null;
  readonly volume24hSwaps: number | null;
  readonly pricedAt: number | null;
  readonly qualified: boolean;
  readonly disqualificationReason: DisqualificationReason | null;
  readonly status: PonsStatus;
}

/**
 * Rows sent to the browser.
 *
 * Rendering the whole dataset produced 8,187 table rows and **16.4 MB of HTML** on a page
 * every visitor loads. The index keeps thousands of launches; the page shows the newest
 * slice of them and says so. `index.indexedTokenCount` remains the real figure and is what
 * the coverage line reports.
 */
const MAX_DISPLAY_ROWS = 100;

export interface PonsView {
  readonly available: boolean;
  /** A bounded slice: every qualified launch, plus the newest others up to the cap. */
  readonly rows: readonly PonsTokenRow[];
  /** How many rows the slice holds, against the full indexed count. */
  readonly displayedCount: number;
  readonly index: PonsIndexSummary;
  readonly pricedPools: number;
  readonly volumeWindowComplete: boolean;
  readonly volumeFromBlock: number;
  readonly volumeToBlock: number;
  readonly ethUsdAvailable: boolean;
  readonly qualifiedCount: number;
  /** Indexed launches that Poolix's v2 core can trade. */
  readonly v2AvailableCount: number;
  readonly thresholds: typeof PONS_DISCOVERY_CONFIG;
  readonly generatedAt: number;
}

/**
 * Launch status, derived only from what the chain proved.
 *
 * The audit found **no separate graduation event**: a Pons pool exists from the launch
 * transaction itself and its position is locked immediately. So "graduated" means the one
 * verifiable thing — the V3 factory independently confirmed the pool — and "active" adds
 * that it traded inside the measured window. No bonding-curve stage is modelled, because
 * none was observed.
 */
function statusOf(poolVerified: boolean, swaps: number | null): PonsStatus {
  if (!poolVerified) return "new";
  return swaps !== null && swaps > 0 ? "active" : "graduated";
}

/*
  Memoised because the Pons dataset is 3.6 MB and this read has no network work to hide
  behind: five concurrent requests measured 5.1x the cost of one, which is five parses of
  an unchanged file. The projection below is pure, so a shared result is identical to five
  separate ones.
*/
let ponsViewMemo: (() => Promise<PonsView>) | null = null;

export async function getPonsView(): Promise<PonsView> {
  ponsViewMemo ??= memoizeSnapshotRead(getPonsViewUncached, SNAPSHOT_TTL_MS);
  return ponsViewMemo();
}

async function getPonsViewUncached(): Promise<PonsView> {
  const index = await readPonsIndex();
  const generatedAt = Date.now();

  const empty: PonsView = {
    available: false,
    rows: [],
    displayedCount: 0,
    index,
    pricedPools: 0,
    volumeWindowComplete: false,
    volumeFromBlock: 0,
    volumeToBlock: 0,
    ethUsdAvailable: false,
    qualifiedCount: 0,
    v2AvailableCount: 0,
    thresholds: PONS_DISCOVERY_CONFIG,
    generatedAt,
  };

  if (!index.available || index.records.length === 0) return empty;

  // Newest first: a launchpad list is read from the most recent launch backwards.
  const ordered = [...index.records].sort((a, b) =>
    b.launchBlock - a.launchBlock !== 0
      ? b.launchBlock - a.launchBlock
      : a.tokenAddress.localeCompare(b.tokenAddress),
  );

  const rows: PonsTokenRow[] = ordered.map((record) => {
    const cap = record.marketCapUsdCents === null ? null : BigInt(record.marketCapUsdCents);
    const volume = record.volume24hUsdCents === null ? null : BigInt(record.volume24hUsdCents);
    const { qualified, reason } = qualify({ marketCapUsdCents: cap, volume24hUsdCents: volume });

    return {
      tokenAddress: record.tokenAddress,
      creatorAddress: record.creatorAddress,
      symbol: record.symbol,
      name: record.name,
      decimals: record.decimals,
      totalSupply: record.totalSupply,
      launchBlock: record.launchBlock,
      launchTxHash: record.launchTxHash,
      poolAddress: record.poolAddress,
      positionTokenId: record.positionTokenId,
      poolVerified: record.poolVerified,
      v2Availability:
        record.v2CheckedAt === null ? "unknown" : record.v2PairAddress === null ? "unavailable" : "available",
      v2PairAddress: record.v2PairAddress,
      source: "pons",
      priceInQuoteE18: record.priceInQuoteE18,
      marketCapUsdCents: record.marketCapUsdCents,
      volume24hUsdCents: record.volume24hUsdCents,
      volume24hSwaps: record.volume24hSwaps,
      pricedAt: record.pricedAt,
      qualified,
      disqualificationReason: reason,
      status: statusOf(record.poolVerified, record.volume24hSwaps),
    };
  });

  /*
    Every actionable launch first, then the newest others until the cap is reached.

    Actionable means qualified OR tradeable on Poolix's v2 core. Neither is ever truncated
    away: a filter that shows only a sample of its matches is not a filter, and a token
    Poolix can actually trade is the most useful row on the page. Both sets are small by
    construction — most Pons tokens have no v2 pair at all — so including them in full
    costs almost nothing.
  */
  const priority = rows.filter((row) => row.qualified || row.v2Availability === "available");
  const rest = rows.filter((row) => !(row.qualified || row.v2Availability === "available"));
  const displayed = [
    ...priority,
    ...rest.slice(0, Math.max(MAX_DISPLAY_ROWS - priority.length, 0)),
  ].sort((a, b) =>
    b.launchBlock - a.launchBlock !== 0
      ? b.launchBlock - a.launchBlock
      : a.tokenAddress.localeCompare(b.tokenAddress),
  );

  return {
    available: true,
    rows: displayed,
    displayedCount: displayed.length,
    index,
    pricedPools: rows.filter((row) => row.priceInQuoteE18 !== null).length,
    volumeWindowComplete: index.volumeWindowComplete,
    volumeFromBlock: index.volumeFromBlock,
    volumeToBlock: index.volumeToBlock,
    ethUsdAvailable: index.quoteUsdAvailable,
    qualifiedCount: rows.filter((row) => row.qualified).length,
    v2AvailableCount: index.v2AvailableCount,
    thresholds: PONS_DISCOVERY_CONFIG,
    generatedAt,
  };
}

/** Constants the UI states rather than restates. */
export const ponsReference = {
  factory: ponsContracts.factory,
  v3Factory: ponsContracts.v3Factory,
  locker: ponsContracts.locker,
  feeTier: PONS_POOL_FEE,
  volumeWindowBlocks: VOLUME_WINDOW_BLOCKS,
} as const;
