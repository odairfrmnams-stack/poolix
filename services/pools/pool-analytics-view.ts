import type { PoolTimeframe } from "@/services/pools/pool-analytics-math";

/*
  The shapes the pool page's server half hands to its client half.

  They live in their own module, free of `server-only`, because both halves need them:
  the builder imports them to produce the view and the panel imports them to render it.
  Types are erased at build time, but a client component reaching into a `server-only`
  module for one is a failure waiting for the first person who turns that import into a
  value import — so the boundary is drawn here instead of relying on that.

  Every amount is a decimal wei STRING. bigint cannot cross into a client component, and
  a number would quietly lose precision on the way, so wei stay exact as text and are
  re-parsed as bigint on the other side.
*/

export interface PoolSeriesPointView {
  readonly startTimestamp: number;
  readonly volumeWei: string;
  /** Null when no reserve was ever observed at or before this hour. Never rendered as zero. */
  readonly liquidityWei: string | null;
  readonly swaps: number;
  readonly transactions: number;
}

export interface PoolTimeframeView {
  readonly frame: PoolTimeframe;
  readonly volumeWei: string;
  readonly feesWei: string;
  readonly swaps: number;
  readonly transactions: number;
  readonly bucketsPresent: number;
  readonly bucketsExpected: number;
  readonly liquidityPoints: number;
  readonly volumeComplete: boolean;
  readonly liquidityComplete: boolean;
  readonly twalWei: string | null;
  /** Already formatted by the one APR formatter, or null when it cannot be computed. */
  readonly aprDisplay: string | null;
  readonly aprReason: string;
  /** True when the window starts before the pool existed. */
  readonly partialByCreation: boolean;
  readonly points: readonly PoolSeriesPointView[];
}

export interface PoolCreationView {
  readonly blockNumber: number;
  readonly timestamp: number;
  /** False would mean inferred; nothing currently infers, so this is a guard not a mode. */
  readonly fromPairCreated: boolean;
}

export interface EthUsdView {
  readonly answer: string;
  readonly decimals: number;
  readonly description: string;
}

export interface PoolAnalyticsView {
  readonly pair: string;
  readonly token0: string;
  readonly token1: string;
  readonly wethSide: "token0" | "token1" | "none";
  readonly creation: PoolCreationView | null;
  readonly timeframes: Readonly<Record<PoolTimeframe, PoolTimeframeView>>;
  readonly swapsIndexed: number;
  readonly transactionsIndexed: number;
  readonly updatedAt: number | null;
}

export type PoolAnalyticsResult =
  | { readonly status: "ready"; readonly pool: PoolAnalyticsView; readonly ethUsd: EthUsdView | null }
  /** The indexer answered, but this pair is outside Poolix's scanned universe. */
  | { readonly status: "out-of-scope"; readonly ethUsd: EthUsdView | null }
  /** No indexer, or its history is not ingested yet. Nothing is shown rather than guessed. */
  | { readonly status: "unavailable"; readonly ethUsd: EthUsdView | null };
