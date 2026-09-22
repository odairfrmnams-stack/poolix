"use client";

import { useQuery } from "@tanstack/react-query";
import { getAddress, type PublicClient } from "viem";
import { usePublicClient } from "wagmi";

import { useTokenList } from "@/hooks/use-token-list";
import { poolixConfig } from "@/config/poolix";
import { uniswapV2PairAbi } from "@/services/abis/uniswap-v2";
import { computePairAddress } from "@/services/liquidity/uniswap-v2/pair";
import { fetchPool, readPosition, type PoolPosition, type PoolState } from "@/services/pools/pool";
import type { Address } from "@/types/web3";

export interface LpPosition {
  readonly pool: PoolState;
  readonly position: PoolPosition;
}

/**
 * LP positions the account holds in pools that pair WETH with a token from its own
 * token list. Poolix cannot enumerate every pool an address might have joined without
 * an indexer, so the list covers the tokens the user has actually added, and the page
 * says so.
 */
export function useLpPositions(owner: Address | undefined) {
  const client = usePublicClient();
  const tokens = useTokenList();
  const { weth, uniswapV2 } = poolixConfig.contracts;

  const candidates = tokens
    .filter((token) => token.kind === "erc20" && getAddress(token.address) !== getAddress(weth))
    .map((token) => (token.kind === "erc20" ? getAddress(token.address) : null))
    .filter((address): address is Address => address !== null);

  const factory = uniswapV2.factory.status === "configured" ? uniswapV2.factory.address : null;

  return useQuery<readonly LpPosition[]>({
    queryKey: ["lp-positions", owner, candidates.join(",")],
    enabled: client !== undefined && factory !== null && owner !== undefined && candidates.length > 0,
    retry: 0,
    staleTime: 15_000,
    queryFn: async () => {
      if (client === undefined || factory === null || owner === undefined) return [];
      const publicClient = client as PublicClient;

      // One balanceOf per candidate pair; the transport batches them into a request.
      const balances = await Promise.all(
        candidates.map(async (token) => {
          const pair = computePairAddress(factory, weth, token);
          try {
            const balance = await publicClient.readContract({
              address: pair,
              abi: uniswapV2PairAbi,
              functionName: "balanceOf",
              args: [owner],
            });
            return { pair, balance };
          } catch {
            // No pair deployed for this token.
            return { pair, balance: 0n };
          }
        }),
      );

      const held = balances.filter((entry) => entry.balance > 0n);
      const pools = await Promise.all(
        held.map(async (entry) => {
          try {
            const pool = await fetchPool(publicClient, factory, entry.pair);
            return { pool, position: readPosition(pool, entry.balance) };
          } catch {
            return null;
          }
        }),
      );

      return pools.filter((entry): entry is LpPosition => entry !== null);
    },
  });
}
