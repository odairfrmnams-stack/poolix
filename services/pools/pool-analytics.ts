import "server-only";

import { formatApr } from "@/services/analytics/apr-math";
import { fetchEthUsdPrice } from "@/services/analytics/eth-price";
import {
  normalizeAddress,
  POOL_TIMEFRAME_HOURS,
  type PoolTimeframe,
} from "@/services/pools/pool-analytics-math";
import type {
  EthUsdView,
  PoolAnalyticsResult,
  PoolTimeframeView,
} from "@/services/pools/pool-analytics-view";
import { getPoolHistory, type PoolAnalytics } from "@/services/pools/pool-history";

/*
  The server half of the pool page: history, and the one oracle reading it is allowed.

  Everything here is a projection of what pool-history already ingested — no figure is
  computed a second way, and nothing is fetched that the page does not display.

  Current reserves are deliberately NOT read here. The pool page already reads them live
  on the client for the position panel, and reading them twice would put two reserve
  figures of different ages on one screen. The server sends the ETH/USD answer instead, so
  the client can price those live reserves against the same verified oracle the rest of
  Poolix uses — and sends nothing at all when the feed is stale or unconfigured, which is
  what makes the price read "--" rather than fall back to a second source.
*/

function toTimeframeView(pool: PoolAnalytics, frame: PoolTimeframe): PoolTimeframeView {
  const totals = pool.totals[frame];
  return {
    frame,
    volumeWei: totals.volumeWei.toString(),
    feesWei: totals.feesWei.toString(),
    swaps: totals.swaps,
    transactions: totals.transactions,
    bucketsPresent: totals.bucketsPresent,
    bucketsExpected: totals.bucketsExpected,
    liquidityPoints: totals.liquidityPoints,
    volumeComplete: totals.volumeComplete,
    liquidityComplete: totals.liquidityComplete,
    twalWei: totals.twalWei === null ? null : totals.twalWei.toString(),
    // Formatted on the server so the client never re-derives a percentage from a scaled
    // integer — there is one APR formatter and one APR formula.
    aprDisplay: formatApr(totals.aprScaled),
    aprReason: totals.aprReason,
    partialByCreation: totals.partialByCreation,
    points: pool.series[frame].map((point) => ({
      startTimestamp: point.startTimestamp,
      volumeWei: point.volumeWei.toString(),
      liquidityWei: point.liquidityWei === null ? null : point.liquidityWei.toString(),
      swaps: point.swaps,
      transactions: point.transactions,
    })),
  };
}

/**
 * Per-pool analytics for one pair address.
 *
 * "Out of scope" and "unavailable" are kept apart on purpose. A pair Poolix has not
 * scanned is a known absence the page can explain; an indexer that has not ingested
 * anything yet is a different absence with a different remedy. Collapsing them into one
 * empty state would tell the reader the wrong thing about which is which.
 */
export async function getPoolAnalytics(address: string): Promise<PoolAnalyticsResult> {
  const [history, price] = await Promise.all([getPoolHistory(), fetchEthUsdPrice()]);

  const ethUsd: EthUsdView | null = price.available
    ? { answer: price.answer.toString(), decimals: price.decimals, description: price.description }
    : null;

  if (!history.available) return { status: "unavailable", ethUsd };

  const wanted = normalizeAddress(address);
  const pool = history.pools.find((entry) => entry.pair === wanted);
  if (pool === undefined) return { status: "out-of-scope", ethUsd };

  const timeframes = {} as Record<PoolTimeframe, PoolTimeframeView>;
  for (const frame of Object.keys(POOL_TIMEFRAME_HOURS) as PoolTimeframe[]) {
    timeframes[frame] = toTimeframeView(pool, frame);
  }

  return {
    status: "ready",
    ethUsd,
    pool: {
      pair: pool.pair,
      token0: pool.token0,
      token1: pool.token1,
      wethSide: pool.wethSide,
      creation:
        pool.creation === null
          ? null
          : {
              blockNumber: pool.creation.blockNumber,
              timestamp: pool.creation.timestamp,
              fromPairCreated: pool.creation.fromPairCreated,
            },
      timeframes,
      swapsIndexed: pool.swapsIndexed,
      transactionsIndexed: pool.transactionsIndexed,
      updatedAt: history.updatedAt,
    },
  };
}
