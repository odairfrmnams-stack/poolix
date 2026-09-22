import type { HistoryTimeframe } from "@/services/analytics/history-math";

/*
  The shapes the analytics dashboard's server half hands to its client half.

  No `server-only` here, because both halves need these types: the builder imports them to
  produce the view and the dashboard imports them to render it.

  Two rules run through every shape in this file.

  Amounts are decimal wei STRINGS. bigint cannot cross into a client component and a number
  would quietly lose precision, so wei stay exact as text and are re-parsed on the far side.

  `null` means "not available", and it is never a zero. Every field that can be absent is
  nullable rather than defaulted, so the dashboard renders "--" from the absence itself
  instead of from a sentinel value someone has to remember to check.
*/

/**
 * What kind of number a metric is, which is not the same question as which timeframe it
 * covers.
 *
 * A dashboard that renders every figure identically invites the reader to compare figures
 * that are not comparable: a scanned reserve read once at the tip, a sum over 720 hours,
 * and a time-weighted average are three different kinds of claim. The dashboard labels
 * them rather than flattening them.
 */
export type MetricKind =
  /** Read from the chain at the current tip. Has no history behind it. */
  | "snapshot"
  /** Summed over a historical window of hourly buckets. */
  | "historical-aggregate"
  /** Averaged over a window, weighted by how long each reading stood. */
  | "time-weighted";

export interface MetricView {
  /** Decimal wei, a plain count as a string, or null when unavailable. */
  readonly value: string | null;
  readonly kind: MetricKind;
  /** Says what the figure covers and what it excludes. Always shown. */
  readonly note: string;
  /**
   * Why the value is null, when it is. Rendered beside the "--" so an absence is
   * explained rather than left as a shrug.
   */
  readonly unavailableReason?: string;
}

export interface HeadlineMetrics {
  /** USD cents. Current scanned liquidity priced by the verified oracle. */
  readonly tvlCents: MetricView;
  /** Wei of the native asset, current scanned pools. */
  readonly scannedLiquidityWei: MetricView;
  readonly volume24hWei: MetricView;
  readonly fees24hWei: MetricView;
  readonly activeUsers: MetricView;
  readonly transactions: MetricView;
  readonly holders: MetricView;
  readonly tokensTracked: MetricView;
  readonly pools: MetricView;
  readonly pairsCreated: MetricView;
  readonly latestBlock: MetricView;
}

export interface SeriesPointView {
  readonly startTimestamp: number;
  readonly volumeWei: string;
  readonly feesWei: string;
  /** Null where no reserve was observed for that bucket. Never drawn as zero. */
  readonly liquidityWei: string | null;
  readonly swaps: number;
  /** False when any hour behind this point was never ingested. */
  readonly complete: boolean;
}

export interface TimeframeView {
  readonly frame: HistoryTimeframe;
  readonly volumeWei: string | null;
  readonly feesWei: string | null;
  readonly swaps: number;
  readonly bucketsPresent: number;
  readonly bucketsExpected: number;
  readonly complete: boolean;
  /** Latest observed ETH liquidity in the window. */
  readonly liquidityLatestWei: string | null;
  readonly liquidityMinWei: string | null;
  readonly liquidityMaxWei: string | null;
  readonly liquidityComplete: boolean;
  /** Time-weighted average liquidity: the APR denominator. */
  readonly twalWei: string | null;
  /** Already formatted by the one APR formatter. Null when it cannot be computed. */
  readonly aprDisplay: string | null;
  readonly aprReason: string;
  readonly points: readonly SeriesPointView[];
}

/** The 24-hour rolling window, which is a different measurement from the hourly grid. */
export interface DayView {
  readonly volumeWei: string | null;
  readonly feesWei: string | null;
  readonly swaps: number;
  readonly complete: boolean;
  readonly coveredBlocks: number;
  readonly windowBlocks: number;
  /** Token/token swaps, deliberately out of scope for an ETH-denominated total. */
  readonly ignoredNonWeth: number;
  /**
   * Swaps seen on a pair whose sides were not yet classified when the hour was ingested.
   *
   * They are neither counted nor excluded on purpose — they are simply not yet attributed,
   * which makes the volume a lower bound rather than a complete figure. Surfacing the
   * count is what stops that undercount from reading as a measurement.
   */
  readonly unresolvedSwaps: number;
}

export interface PoolRankingRow {
  readonly pair: string;
  readonly symbol0: string;
  readonly symbol1: string;
  readonly token0: string;
  readonly token1: string;
  /** "none" for a token/token pair, which is ranked but has no ETH-denominated figures. */
  readonly wethSide: "token0" | "token1" | "none";
  readonly liquidityWei: string | null;
  readonly volume24hWei: string | null;
  readonly fees24hWei: string | null;
  readonly transactions24h: number | null;
  readonly apr7dDisplay: string | null;
  readonly apr30dDisplay: string | null;
  readonly creationTimestamp: number | null;
}

export interface TokenRankingRow {
  readonly address: string;
  readonly symbol: string;
  readonly decimals: number;
  readonly poolCount: number;
  readonly liquidityWei: string | null;
  /** Price in wei of the native asset. Never a USD guess. */
  readonly priceEthWei: string | null;
  /** Only when a verified oracle round backed it. */
  readonly priceUsdCents: string | null;
  /** Whole-token holders, only when this token's confirmation is complete. */
  readonly holders: number | null;
  readonly tracked: boolean;
}

export interface CoverageView {
  readonly poolsScanned: number;
  readonly pairsTotal: number;
  readonly poolScanComplete: boolean;
  readonly tokensVerified: number;
  readonly tokensLimit: number;
  readonly tokenSweepComplete: boolean;
  readonly holdersComplete: boolean;
  readonly holdersTokensConfirmed: number;
  readonly holdersTokenCount: number;
  readonly holdersCandidates: number;
  readonly holdersMismatches: number;
  readonly historyBootstrapping: boolean;
  readonly liquidityBuilding: boolean;
  readonly ethUsdAvailable: boolean;
  readonly ethUsdDescription: string | null;
  /** Pools carried by the per-pool store, which is the ranking's universe. */
  readonly rankedPools: number;
  readonly latestBlock: number | null;
  readonly updatedAt: number | null;
}

export interface DashboardView {
  readonly available: boolean;
  readonly nativeSymbol: string;
  readonly chainName: string;
  readonly headline: HeadlineMetrics;
  readonly day: DayView;
  readonly timeframes: Readonly<Record<HistoryTimeframe, TimeframeView>>;
  readonly poolRows: readonly PoolRankingRow[];
  readonly tokenRows: readonly TokenRankingRow[];
  readonly coverage: CoverageView;
}
