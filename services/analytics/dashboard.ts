import "server-only";

import { formatApr } from "@/services/analytics/apr-math";
import { getActivityWindow } from "@/services/analytics/activity-window";
import { readApr } from "@/services/analytics/apr-window";
import {
  metric,
  metricFrom,
  unavailable,
  usdCentsOrNull,
  windowPublishable,
} from "@/services/analytics/dashboard-math";
import type {
  CoverageView,
  DashboardView,
  DayView,
  HeadlineMetrics,
  PoolRankingRow,
  TimeframeView,
  TokenRankingRow,
} from "@/services/analytics/dashboard-view";
import { fetchEthUsdPrice } from "@/services/analytics/eth-price";
import { BUCKET_SECONDS, HISTORY_DAYS, type HistoryTimeframe } from "@/services/analytics/history-math";
import { readHistory } from "@/services/analytics/history-window";
import { readPublishedHolders } from "@/services/analytics/holders-window";
import { readLiquidityHistory } from "@/services/analytics/liquidity-history";
import { getSwapWindow } from "@/services/analytics/swap-window";
import { tradingFeesWei } from "@/services/analytics/swap-math";
import { poolixConfig } from "@/config/poolix";
import { isUniswapV2Available } from "@/config/resolve";
import { fetchChainStatus } from "@/services/chain/status";
import { discoverPools, type PoolDiscoveryResult } from "@/services/pools/discovery";
import { readPoolHistory } from "@/services/pools/pool-history";
import { listTokens } from "@/services/tokens/listing";
import { getTokenUniverse } from "@/services/tokens/universe";

/*
  The analytics dashboard's server half.

  It aggregates and nothing else. Every figure here was produced and verified by an
  existing pipeline — Phase 1's rolling window and hourly volume, Phase 2's liquidity
  series, Phase 3's APR, Phase 4's per-pool split, plus the pool and token universes — and
  this module's whole job is to assemble them into one serialisable view.

  What it must NOT do is re-derive any of them. There is one pool universe, one token
  universe, one HyperSync ingestion and one APR formula; a dashboard that scanned the chain
  again "just for the UI" would be a second set of numbers that disagrees with the first
  under exactly the conditions nobody tests. So the services are called, not reimplemented,
  and each is called once per render.
*/

const EMPTY_DISCOVERY: PoolDiscoveryResult = {
  pools: [],
  totalPairs: 0,
  scanned: 0,
  complete: false,
};

/** Pairs the per-pool store keys its rows by, for joining against discovery. */
type PairSymbols = Map<string, { symbol0: string; symbol1: string }>;

/**
 * Symbols for each pair, taken from the pool scan.
 *
 * The scan records only the non-WETH side, so a WETH pair's other symbol comes from there
 * and WETH itself is named from config. A pair the scan has not seen keeps its addresses
 * rather than being given a guessed symbol.
 */
function pairSymbols(discovery: PoolDiscoveryResult): PairSymbols {
  const symbols: PairSymbols = new Map();
  const native = poolixConfig.chain.nativeCurrency.symbol;
  for (const pool of discovery.pools) {
    symbols.set(pool.address.toLowerCase(), {
      symbol0: `W${native}`,
      symbol1: pool.other.symbol,
    });
  }
  return symbols;
}

const short = (address: string) => `${address.slice(2, 6).toUpperCase()}`;

export async function getDashboard(): Promise<DashboardView> {
  const available = isUniswapV2Available(poolixConfig);

  const [discovery, status, swaps, activity, ethUsd, tokenUniverse] = await Promise.all([
    available ? discoverPools() : Promise.resolve(EMPTY_DISCOVERY),
    fetchChainStatus(),
    getSwapWindow(),
    getActivityWindow(),
    fetchEthUsdPrice(),
    getTokenUniverse(),
  ]);

  /*
    Holders is READ, never computed, during a render.

    The count is produced by the holder worker's tick, which is allowed to spend its whole
    budget confirming balances against the token contracts. Doing that inside a page render
    made every visit pay for the backlog: with a token holding tens of thousands of
    candidates the prerender was measured finishing at 61s against Next's 60s ceiling, so
    the page could fail for a reason that has nothing to do with the page.

    Reading the published snapshot keeps the figure identical — same universe, same
    publication rule, same "--" while incomplete — and makes rendering independent of how
    much confirmation work is outstanding.

    THE SAME NOW APPLIES TO THE OTHER FOUR. History, liquidity, APR and per-pool history
    were each ticking during the render: measured cold at 1.5, 7.0, 4.1 and 14.1 seconds,
    and every one of them a network scan the page did not need to perform in order to show
    the series the last tick already produced. They are now read from persisted state, and
    /analytics advances them in `after()` once the response is sent.

    No figure changes. Each `read*` runs the same `summarise` the tick itself falls back to
    when the chain is unreachable — the same windows, the same coverage rules, the same
    withholding of an incomplete window. What changes is only whether a visitor waits for
    a scan to finish before seeing the page.
  */
  /*
    Independent reads, started together.

    These were five sequential awaits, and the cost was additive: measured cold at 0.11 +
    1.12 + 3.42 + 2.50 + 6.93 = 14.1 seconds, where the slowest alone is 6.9. Nothing here
    depends on anything else here — each service owns its own dataset and its own
    checkpoint — so the serialisation bought nothing.

    `getApr` reads the history and liquidity series internally, but every service in this
    list holds a single-flight guard, so a concurrent caller joins the in-flight promise
    rather than starting a second scan. Running them together is therefore not only safe,
    it is what stops the same scan being started twice.

    No methodology changes: the same functions return the same figures, in the same order,
    to the same fields.
  */
  const [holders, history, liquidityHistory, apr, poolHistory] = await Promise.all([
    readPublishedHolders(),
    readHistory(),
    readLiquidityHistory(),
    readApr(),
    readPoolHistory(),
  ]);

  const oracle = ethUsd.available ? { answer: ethUsd.answer, decimals: ethUsd.decimals } : null;
  const native = poolixConfig.chain.nativeCurrency.symbol;

  /*
    Scanned liquidity, and the USD figure derived from exactly it.

    The two are computed from the same sum so they can never disagree, and the wording
    everywhere is "scanned" — this covers the pools Poolix has discovered, which is not the
    same as every pool on the chain and must never be labelled as chain-wide TVL.
  */
  const scannedLiquidity = discovery.pools.reduce(
    (total, pool) => total + BigInt(pool.wethReserve) * 2n,
    0n,
  );
  const tvlCents = usdCentsOrNull(scannedLiquidity, oracle);

  const headline: HeadlineMetrics = {
    tvlCents:
      tvlCents === null
        ? unavailable(
            "snapshot",
            `Scanned ${native}/W${native} liquidity priced by the verified ETH/USD feed`,
            ethUsd.available ? "No liquidity scanned yet" : "ETH/USD feed unavailable or stale",
          )
        : metric(
            tvlCents.toString(),
            "snapshot",
            `Scanned ${native}/W${native} liquidity × ${ethUsd.available ? ethUsd.description : "ETH/USD"}`,
          ),
    scannedLiquidityWei: metric(
      scannedLiquidity.toString(),
      "snapshot",
      `Across ${discovery.pools.length} scanned pools, read at the current tip`,
    ),
    volume24hWei: metricFrom(
      swaps.available,
      () => swaps.volumeWei.toString(),
      "snapshot",
      // When swaps are still unattributed the total is a floor, and says so rather than
      // presenting itself as the complete figure.
      swaps.unresolvedSwaps > 0
        ? `At least this much: ${swaps.unresolvedSwaps.toLocaleString("en-US")} swaps are not yet attributed to a pair`
        : `Uniswap v2 Swap events over a rolling 24h block window, ${native} side only`,
      "Needs swap history",
    ),
    fees24hWei: metricFrom(
      swaps.available,
      () => swaps.feesWei.toString(),
      "snapshot",
      "0.30% of the same 24h swap volume",
      "Needs swap history",
    ),
    activeUsers: metricFrom(
      activity.available,
      () => String(activity.activeUsers),
      "snapshot",
      "Distinct sending accounts in the 24h activity window, across every frontend",
      "Needs a transaction index",
    ),
    transactions: metricFrom(
      activity.available,
      () => String(activity.transactions),
      "snapshot",
      "Distinct transaction hashes emitting Swap, Mint or Burn in the 24h window",
      "Needs a transaction index",
    ),
    holders: metricFrom(
      holders.available && holders.complete,
      () => String(holders.holders),
      "snapshot",
      `Confirmed by balanceOf across the ${holders.tokenCount} tracked tokens`,
      holders.available
        ? `Rebuilding: ${holders.tokensConfirmed} of ${holders.tokenCount} tokens confirmed`
        : "Needs ERC-20 transfer history",
    ),
    tokensTracked: metricFrom(
      tokenUniverse.available,
      () => String(tokenUniverse.verified),
      "snapshot",
      `Unique non-W${native} tokens from the scanned pools, up to ${tokenUniverse.limit} tracked`,
      "Needs the scanned pool universe",
    ),
    pools: metric(
      String(discovery.pools.length),
      "snapshot",
      `Scanned ${discovery.scanned.toLocaleString("en-US")} of ${discovery.totalPairs.toLocaleString("en-US")} pairs`,
    ),
    pairsCreated: metricFrom(
      discovery.totalPairs > 0,
      () => String(discovery.totalPairs),
      "snapshot",
      "factory.allPairsLength(), every pair the factory has ever created",
      "Factory not readable",
    ),
    latestBlock: metricFrom(
      status.blockNumber !== null,
      () => String(status.blockNumber),
      "snapshot",
      status.chainId === null ? "Chain id unavailable" : `Chain ${status.chainId}`,
      "Endpoint unreachable",
    ),
  };

  const day: DayView = {
    volumeWei: swaps.available ? swaps.volumeWei.toString() : null,
    feesWei: swaps.available ? swaps.feesWei.toString() : null,
    swaps: swaps.swaps,
    complete: swaps.complete,
    coveredBlocks: swaps.coveredBlocks,
    windowBlocks: swaps.windowBlocks,
    ignoredNonWeth: swaps.ignoredNonWeth,
    unresolvedSwaps: swaps.unresolvedSwaps,
  };

  const timeframes = {} as Record<HistoryTimeframe, TimeframeView>;
  for (const frame of Object.keys(HISTORY_DAYS) as HistoryTimeframe[]) {
    const totals = history.totals[frame];
    const liq = liquidityHistory.totals[frame];
    const rate = apr.timeframes[frame];
    const publishable = windowPublishable(totals.bucketsPresent, totals.bucketsExpected);

    timeframes[frame] = {
      frame,
      volumeWei: publishable ? totals.volumeWei.toString() : null,
      feesWei: publishable ? totals.feesWei.toString() : null,
      swaps: totals.swaps,
      bucketsPresent: totals.bucketsPresent,
      bucketsExpected: totals.bucketsExpected,
      complete: totals.complete,
      liquidityLatestWei: liq.complete ? liq.latestWei.toString() : null,
      liquidityMinWei: liq.complete ? liq.minWei.toString() : null,
      liquidityMaxWei: liq.complete ? liq.maxWei.toString() : null,
      liquidityComplete: liq.complete,
      twalWei: rate.twalWei === null ? null : rate.twalWei.toString(),
      // The APR the verified Phase 3 window already produced. Never recomputed here.
      aprDisplay: rate.display,
      aprReason: rate.reason,
      points: history.series[frame].map((point) => {
        const liquidityPoint = liq.points.find((p) => p.startTimestamp === point.startTimestamp);
        return {
          startTimestamp: point.startTimestamp,
          volumeWei: point.volumeWei.toString(),
          feesWei: point.feesWei.toString(),
          liquidityWei:
            liquidityPoint === undefined || !liquidityPoint.complete
              ? null
              : liquidityPoint.liquidityWei.toString(),
          swaps: point.swaps,
          complete: point.complete,
        };
      }),
    };
  }

  // ------------------------------------------------------------ pool rankings
  /*
    Rows come from the per-pool store, which is Phase 4's universe. A pair whose WETH side
    is "none" is included: it simply carries null where an ETH-denominated figure would go.
    Filtering those out would be reading "cannot be priced in ETH" as "not a real pool".
  */
  const symbols = pairSymbols(discovery);
  const poolRows: PoolRankingRow[] = poolHistory.pools.map((pool) => {
    const day24 = pool.totals["24H"];
    const known = symbols.get(pool.pair);
    const hasEth = pool.wethSide !== "none";
    // The most recent hour that actually holds a reading. A null is a hole, not a zero.
    const latestLiquidity =
      [...pool.series["24H"]].reverse().find((point) => point.liquidityWei !== null)
        ?.liquidityWei ?? null;

    return {
      pair: pool.pair,
      symbol0: known?.symbol0 ?? short(pool.token0),
      symbol1: known?.symbol1 ?? short(pool.token1),
      token0: pool.token0,
      token1: pool.token1,
      wethSide: pool.wethSide,
      liquidityWei: hasEth && latestLiquidity !== null ? latestLiquidity.toString() : null,
      volume24hWei: hasEth && day24.volumeComplete ? day24.volumeWei.toString() : null,
      fees24hWei: hasEth && day24.volumeComplete ? day24.feesWei.toString() : null,
      // A transaction count does not need the pool to be priceable, so it is reported for
      // a token/token pair too.
      transactions24h: day24.volumeComplete ? day24.transactions : null,
      apr7dDisplay: formatApr(pool.totals["7D"].aprScaled),
      apr30dDisplay: formatApr(pool.totals["30D"].aprScaled),
      creationTimestamp: pool.creation?.timestamp ?? null,
    };
  });

  // ----------------------------------------------------------- token rankings
  const tracked = new Set(tokenUniverse.tokens.map((token) => token.toLowerCase()));
  const tokenRows: TokenRankingRow[] = listTokens(discovery).map((token) => {
    const address = token.address.toLowerCase();
    const priceEthWei =
      token.priceEth === null
        ? null
        : BigInt(Math.round(token.priceEth * 1e18)).toString();

    return {
      address,
      symbol: token.symbol,
      decimals: token.decimals,
      poolCount: token.poolCount,
      liquidityWei: token.ethLiquidity.toString(),
      priceEthWei,
      /*
        USD only from the verified oracle, and only for a token that has an ETH price to
        convert. No cross-rate, no cached round, no inference from a token/token pool.
      */
      priceUsdCents:
        priceEthWei === null
          ? null
          : (usdCentsOrNull(BigInt(priceEthWei), oracle)?.toString() ?? null),
      /*
        Holders is a chain-wide figure over the whole tracked universe, not a per-token
        one, so attributing it to a single row would be inventing a breakdown the pipeline
        never produced.
      */
      holders: null,
      tracked: tracked.has(address),
    };
  });

  const coverage: CoverageView = {
    poolsScanned: discovery.pools.length,
    pairsTotal: discovery.totalPairs,
    poolScanComplete: discovery.complete,
    tokensVerified: tokenUniverse.verified,
    tokensLimit: tokenUniverse.limit,
    tokenSweepComplete: tokenUniverse.sweepComplete,
    holdersComplete: holders.complete,
    holdersTokensConfirmed: holders.tokensConfirmed,
    holdersTokenCount: holders.tokenCount,
    holdersCandidates: holders.candidates,
    holdersMismatches: holders.mismatches,
    historyBootstrapping: history.bootstrapping,
    liquidityBuilding: liquidityHistory.building,
    ethUsdAvailable: ethUsd.available,
    ethUsdDescription: ethUsd.available ? ethUsd.description : null,
    rankedPools: poolHistory.pools.length,
    latestBlock: status.blockNumber,
    updatedAt: history.updatedAt,
  };

  return {
    available: true,
    nativeSymbol: native,
    chainName: poolixConfig.chain.name,
    headline,
    day,
    timeframes,
    poolRows,
    tokenRows,
    coverage,
  };
}

/** Re-exported so the verifier can check the dashboard's fee rule is the shared one. */
export { tradingFeesWei, BUCKET_SECONDS };
