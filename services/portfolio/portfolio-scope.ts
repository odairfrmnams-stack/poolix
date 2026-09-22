import "server-only";

import { getAddress } from "viem";

import { poolixConfig } from "@/config/poolix";
import { isUniswapV2Available } from "@/config/resolve";
import { fetchEthUsdPrice } from "@/services/analytics/eth-price";
import { sortTokens } from "@/services/liquidity/uniswap-v2/pair";
import { discoverPools } from "@/services/pools/discovery";
import { getPoolHistory } from "@/services/pools/pool-history";
import { normalizeAddress, wethSideOf } from "@/services/portfolio/portfolio-math";
import type { PortfolioScope, ScopedPair, ScopedToken } from "@/services/portfolio/portfolio-view";
import { getTokenUniverse } from "@/services/tokens/universe";

/*
  The wallet-independent half of the portfolio.

  A portfolio is per-wallet and a wallet only exists in the browser, so balances cannot be
  read on the server. What CAN be settled here is the question "which pools and tokens is
  it worth asking about", and that question already has an answer: Poolix's discovered pool
  universe. Reusing it is the point — a portfolio that scanned for pools on its own would
  be a second universe, and a position could then appear here while the pool page insisted
  it did not exist.

  So this assembles the scope from `discoverPools()` (the same scan the analytics and pools
  pages use), the tracked token universe, Phase 4's creation dates, and the one validated
  ETH/USD round. The client then reads only wallet balances against that fixed list.

  The bound is stated rather than hidden: the scan covers a window of the pair space, so
  the page says how many pools it looked at and does not claim to have found every LP
  position an address might hold.
*/

const EMPTY: PortfolioScope = {
  available: false,
  chainId: poolixConfig.chain.id,
  nativeSymbol: poolixConfig.chain.nativeCurrency.symbol,
  weth: normalizeAddress(poolixConfig.contracts.weth),
  pairs: [],
  tokens: [],
  ethUsd: null,
  poolsScanned: 0,
  pairsTotal: 0,
  scanComplete: false,
};

export async function getPortfolioScope(): Promise<PortfolioScope> {
  if (!isUniswapV2Available(poolixConfig)) return EMPTY;

  const [discovery, ethUsd, universe] = await Promise.all([
    discoverPools(),
    fetchEthUsdPrice(),
    getTokenUniverse(),
  ]);

  // Creation dates come from Phase 4's PairCreated lookup rather than being inferred here.
  // A pool outside that universe simply has no date, which the row renders as "--".
  const history = await getPoolHistory().catch(() => null);
  const createdAt = new Map<string, number>();
  for (const pool of history?.pools ?? []) {
    if (pool.creation !== null) createdAt.set(pool.pair, pool.creation.timestamp);
  }

  const weth = normalizeAddress(poolixConfig.contracts.weth);
  const nativeSymbol = poolixConfig.chain.nativeCurrency.symbol;
  const tracked = new Set(universe.tokens.map(normalizeAddress));

  const pairs: ScopedPair[] = [];
  const tokens = new Map<string, ScopedToken>();

  for (const pool of discovery.pools) {
    const other = normalizeAddress(pool.other.address);
    // The scan records only the non-WETH side, so the pair's ordering is derived rather
    // than assumed: token0/token1 are fixed by address, not by which side was scanned.
    const [token0, token1] = sortTokens(getAddress(weth), getAddress(other));
    const lower0 = normalizeAddress(token0);
    const lower1 = normalizeAddress(token1);
    const wethIsToken0 = lower0 === weth;

    pairs.push({
      pair: normalizeAddress(pool.address),
      token0: lower0,
      token1: lower1,
      symbol0: wethIsToken0 ? `W${nativeSymbol}` : pool.other.symbol,
      symbol1: wethIsToken0 ? pool.other.symbol : `W${nativeSymbol}`,
      decimals0: wethIsToken0 ? 18 : pool.other.decimals,
      decimals1: wethIsToken0 ? pool.other.decimals : 18,
      wethSide: wethSideOf(lower0, lower1, weth),
      createdAt: createdAt.get(normalizeAddress(pool.address)) ?? null,
    });

    /*
      One row per token, kept against its DEEPEST pool.

      A token can sit in several pools and the deepest is the one a trade would route
      through, so it is the honest rate to value a holding at — the same rule the token
      listing already uses.
    */
    const wethReserve = BigInt(pool.wethReserve);
    const existing = tokens.get(other);
    if (existing === undefined || BigInt(existing.wethReserveWei) < wethReserve) {
      tokens.set(other, {
        address: other,
        symbol: pool.other.symbol,
        decimals: pool.other.decimals,
        tokenReserveWei: pool.otherReserve,
        wethReserveWei: pool.wethReserve,
        tracked: tracked.has(other),
      });
    }
  }

  return {
    available: true,
    chainId: poolixConfig.chain.id,
    nativeSymbol,
    weth,
    pairs,
    tokens: [...tokens.values()],
    ethUsd: ethUsd.available
      ? {
          answer: ethUsd.answer.toString(),
          decimals: ethUsd.decimals,
          description: ethUsd.description,
        }
      : null,
    poolsScanned: discovery.pools.length,
    pairsTotal: discovery.totalPairs,
    scanComplete: discovery.complete,
  };
}
