"use client";

import { useQuery } from "@tanstack/react-query";
import { erc20Abi, getAddress, type PublicClient } from "viem";
import { usePublicClient } from "wagmi";

import { poolixConfig } from "@/config/poolix";
import { useTokenList } from "@/hooks/use-token-list";
import { uniswapV2PairAbi } from "@/services/abis/uniswap-v2";
import type { Currency } from "@/services/liquidity/types";
import { computePairAddress, sortTokens } from "@/services/liquidity/uniswap-v2/pair";
import { midPrice } from "@/services/pools/pricing";
import type { Address } from "@/types/web3";

export interface HoldingRow {
  readonly currency: Currency;
  readonly balance: bigint;
  /** Mid price in the native asset, or null when the token has no pool to price it. */
  readonly priceEth: number | null;
  /** Value of the holding in wei of the native asset, or null when unpriced. */
  readonly valueWei: bigint | null;
}

export interface Portfolio {
  readonly holdings: readonly HoldingRow[];
  /** Sum of the priced holdings only. */
  readonly totalWei: bigint;
  /** True when at least one holding could not be priced, so the total is partial. */
  readonly partial: boolean;
}

/**
 * Balances for the tokens in the user's list, priced from each token's own WETH pool.
 * Tokens with no pool stay in the list with a null price rather than being dropped or
 * counted as zero, and the total says it is partial.
 */
export function usePortfolio(owner: Address | undefined) {
  const client = usePublicClient();
  const tokens = useTokenList();
  const { weth, uniswapV2 } = poolixConfig.contracts;
  const factory = uniswapV2.factory.status === "configured" ? uniswapV2.factory.address : null;

  const key = tokens.map((token) => (token.kind === "erc20" ? token.address : "native")).join(",");

  return useQuery<Portfolio>({
    queryKey: ["portfolio", owner, key],
    enabled: client !== undefined && owner !== undefined,
    retry: 0,
    staleTime: 15_000,
    queryFn: async () => {
      if (client === undefined || owner === undefined) return { holdings: [], totalWei: 0n, partial: false };
      const publicClient = client as PublicClient;
      const wethAddress = getAddress(weth);

      const rows = await Promise.all(
        tokens.map(async (currency): Promise<HoldingRow | null> => {
          const balance =
            currency.kind === "native"
              ? await publicClient.getBalance({ address: owner })
              : await publicClient
                  .readContract({
                    address: currency.address,
                    abi: erc20Abi,
                    functionName: "balanceOf",
                    args: [owner],
                  })
                  .catch(() => 0n);

          if (balance === 0n) return null;

          // Native and WETH are already denominated in the native asset.
          const address = currency.kind === "native" ? wethAddress : getAddress(currency.address);
          if (currency.kind === "native" || address === wethAddress) {
            return { currency, balance, priceEth: 1, valueWei: balance };
          }
          if (factory === null) return { currency, balance, priceEth: null, valueWei: null };

          try {
            const pair = computePairAddress(factory, wethAddress, address);
            const [reserve0, reserve1] = await publicClient.readContract({
              address: pair,
              abi: uniswapV2PairAbi,
              functionName: "getReserves",
            });
            const [token0] = sortTokens(wethAddress, address);
            const tokenReserve = token0 === address ? reserve0 : reserve1;
            const wethReserve = token0 === address ? reserve1 : reserve0;

            const price = midPrice(tokenReserve, currency.decimals, wethReserve, 18);
            if (price === null) return { currency, balance, priceEth: null, valueWei: null };

            // Value in wei, kept in integer maths: balance * wethReserve / tokenReserve.
            const valueWei = tokenReserve === 0n ? null : (balance * wethReserve) / tokenReserve;
            return { currency, balance, priceEth: price, valueWei };
          } catch {
            return { currency, balance, priceEth: null, valueWei: null };
          }
        }),
      );

      const holdings = rows.filter((row): row is HoldingRow => row !== null);
      holdings.sort((a, b) => {
        const left = a.valueWei ?? -1n;
        const right = b.valueWei ?? -1n;
        return right > left ? 1 : right < left ? -1 : 0;
      });

      return {
        holdings,
        totalWei: holdings.reduce((total, row) => total + (row.valueWei ?? 0n), 0n),
        partial: holdings.some((row) => row.valueWei === null),
      };
    },
  });
}
