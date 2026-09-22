"use client";

import { useQuery } from "@tanstack/react-query";
import { erc20Abi, getAddress, type PublicClient } from "viem";
import { usePublicClient } from "wagmi";

import { uniswapV2PairAbi } from "@/services/abis/uniswap-v2";
import {
  formatSharePercent,
  lpUnderlying,
  lpValueInEthWei,
  normalizeAddress,
  sharePercentScaled,
  totalValuation,
  usdCentsForEth,
  valueInEthWei,
} from "@/services/portfolio/portfolio-math";
import type {
  LpPositionView,
  PortfolioScope,
  PortfolioView,
  TokenHoldingView,
} from "@/services/portfolio/portfolio-view";
import type { Address } from "@/types/web3";

/*
  The wallet-dependent half of the portfolio.

  It reads only balances, and only for the pairs and tokens the server already fixed in the
  scope — so this hook never decides which pools exist, which is what keeps the portfolio
  and the pool pages describing the same universe.

  Reads go through the shared wagmi public client, whose transport batches calls into
  JSON-RPC requests. That is the existing client-side batching, deliberately reused rather
  than replaced: concurrency was measured on this endpoint to make throttling worse, not
  better, so the reads fan out through one batching transport instead of many parallel
  bursts.

  A failed read is counted and skipped, never turned into a zero. One token whose metadata
  or balance cannot be fetched must not take the rest of the portfolio down with it.
*/

const EMPTY: PortfolioView = {
  tokens: [],
  positions: [],
  totals: { usdCents: null, valued: 0, unvalued: 0, complete: false },
  blockNumber: null,
  failedReads: 0,
  readAt: 0,
};

interface PairRead {
  readonly lpBalance: bigint;
  readonly totalSupply: bigint;
  readonly reserve0: bigint;
  readonly reserve1: bigint;
}

export function usePortfolioView(scope: PortfolioScope, owner: Address | undefined) {
  const client = usePublicClient();

  return useQuery<PortfolioView>({
    queryKey: ["portfolio-view", scope.chainId, owner, scope.pairs.length, scope.tokens.length],
    enabled: client !== undefined && owner !== undefined && scope.available,
    // Balances are read on demand rather than polled: a portfolio that refetches every
    // second hammers the endpoint for a number that rarely changes.
    refetchOnWindowFocus: false,
    staleTime: 30_000,
    retry: 0,
    queryFn: async () => {
      if (client === undefined || owner === undefined) return EMPTY;
      const publicClient = client as PublicClient;
      let failedReads = 0;

      /*
        The block the reads happen around, captured first.

        It is a reference point, not a snapshot: the calls below land over a short span and
        the chain advances underneath them, so the page says "read around block N" rather
        than claiming one atomic state.
      */
      const blockNumber = await publicClient
        .getBlockNumber()
        .then((value) => Number(value))
        .catch(() => {
          failedReads++;
          return null;
        });

      const oracle =
        scope.ethUsd === null
          ? null
          : { answer: BigInt(scope.ethUsd.answer), decimals: scope.ethUsd.decimals };

      // ---------------------------------------------------------- native balance
      const nativeBalance = await publicClient.getBalance({ address: owner }).catch(() => {
        failedReads++;
        return null;
      });

      const tokens: TokenHoldingView[] = [];
      if (nativeBalance !== null && nativeBalance > 0n) {
        tokens.push({
          address: "native",
          symbol: scope.nativeSymbol,
          decimals: 18,
          balanceWei: nativeBalance.toString(),
          // The native asset is already denominated in itself.
          valueEthWei: nativeBalance.toString(),
          valueUsdCents: usdCentsForEth(nativeBalance, oracle)?.toString() ?? null,
          metadataMissing: false,
          isNative: true,
          tracked: false,
        });
      }

      // ------------------------------------------------------------ ERC-20 balances
      const balances = await Promise.all(
        scope.tokens.map(async (token) => {
          try {
            const balance = await publicClient.readContract({
              address: getAddress(token.address),
              abi: erc20Abi,
              functionName: "balanceOf",
              args: [owner],
            });
            return { token, balance };
          } catch {
            failedReads++;
            return null;
          }
        }),
      );

      for (const entry of balances) {
        if (entry === null) continue;
        const { token, balance } = entry;
        if (balance <= 0n) continue; // A zero balance is not a holding.

        const isWeth = normalizeAddress(token.address) === scope.weth;
        // WETH is one-for-one with the native asset; anything else is valued through the
        // deepest pool holding it, which is the rate a trade would actually get.
        const valueEthWei = isWeth
          ? balance
          : valueInEthWei(balance, BigInt(token.tokenReserveWei), BigInt(token.wethReserveWei));

        tokens.push({
          address: normalizeAddress(token.address),
          symbol: token.symbol,
          decimals: token.decimals,
          balanceWei: balance.toString(),
          valueEthWei: valueEthWei?.toString() ?? null,
          valueUsdCents: usdCentsForEth(valueEthWei, oracle)?.toString() ?? null,
          metadataMissing: token.symbol.trim() === "",
          isNative: false,
          tracked: token.tracked,
        });
      }

      // --------------------------------------------------------------- LP positions
      const pairReads = await Promise.all(
        scope.pairs.map(async (pair) => {
          try {
            const address = getAddress(pair.pair);
            const [lpBalance, totalSupply, reserves] = await Promise.all([
              publicClient.readContract({
                address,
                abi: uniswapV2PairAbi,
                functionName: "balanceOf",
                args: [owner],
              }),
              publicClient.readContract({
                address,
                abi: uniswapV2PairAbi,
                functionName: "totalSupply",
              }),
              publicClient.readContract({
                address,
                abi: uniswapV2PairAbi,
                functionName: "getReserves",
              }),
            ]);
            const read: PairRead = {
              lpBalance,
              totalSupply,
              reserve0: reserves[0],
              reserve1: reserves[1],
            };
            return { pair, read };
          } catch {
            failedReads++;
            return null;
          }
        }),
      );

      const positions: LpPositionView[] = [];
      for (const entry of pairReads) {
        if (entry === null) continue;
        const { pair, read } = entry;
        if (read.lpBalance <= 0n) continue; // Not a position.

        const underlying = lpUnderlying(
          read.lpBalance,
          read.totalSupply,
          read.reserve0,
          read.reserve1,
        );
        if (underlying === null) continue;

        const valueEth = lpValueInEthWei(underlying, pair.wethSide);

        positions.push({
          pairAddress: pair.pair,
          token0Address: pair.token0,
          token1Address: pair.token1,
          token0Symbol: pair.symbol0,
          token1Symbol: pair.symbol1,
          token0Decimals: pair.decimals0,
          token1Decimals: pair.decimals1,
          userLpBalance: read.lpBalance.toString(),
          totalSupply: read.totalSupply.toString(),
          share: formatSharePercent(sharePercentScaled(read.lpBalance, read.totalSupply)),
          reserve0: read.reserve0.toString(),
          reserve1: read.reserve1.toString(),
          userToken0Amount: underlying.amount0.toString(),
          userToken1Amount: underlying.amount1.toString(),
          poolLiquidityEth: valueEth?.toString() ?? null,
          valueUsdCents: usdCentsForEth(valueEth, oracle)?.toString() ?? null,
          poolCreatedAt: pair.createdAt,
          poolLink: `/pools/${pair.pair}`,
          wethSide: pair.wethSide,
        });
      }

      /*
        The total covers every holding, priced or not.

        Unpriced rows are counted rather than summed, so the page can say "partial
        valuation" instead of quietly reporting a smaller portfolio than the wallet holds.
      */
      const totals = totalValuation([
        ...tokens.map((row) => (row.valueUsdCents === null ? null : BigInt(row.valueUsdCents))),
        ...positions.map((row) => (row.valueUsdCents === null ? null : BigInt(row.valueUsdCents))),
      ]);

      // Largest first, with unpriced rows after priced ones rather than mixed among them.
      const byValue = (a: string | null, b: string | null) => {
        if (a === null && b === null) return 0;
        if (a === null) return 1;
        if (b === null) return -1;
        return BigInt(b) > BigInt(a) ? 1 : BigInt(b) < BigInt(a) ? -1 : 0;
      };
      tokens.sort((a, b) => byValue(a.valueUsdCents ?? a.valueEthWei, b.valueUsdCents ?? b.valueEthWei));
      positions.sort((a, b) => byValue(a.poolLiquidityEth, b.poolLiquidityEth));

      return {
        tokens,
        positions,
        totals: {
          usdCents: totals.cents?.toString() ?? null,
          valued: totals.valued,
          unvalued: totals.unvalued,
          complete: totals.complete,
        },
        blockNumber,
        failedReads,
        readAt: Date.now(),
      };
    },
  });
}
