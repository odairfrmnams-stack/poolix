"use client";

import { useQuery } from "@tanstack/react-query";
import { getAddress, isAddress, type PublicClient } from "viem";
import { usePublicClient } from "wagmi";

import { poolixConfig } from "@/config/poolix";
import type { Currency } from "@/services/liquidity/types";
import { fetchPool, fetchPoolForPair, type PoolState } from "@/services/pools/pool";
import { currencyAddress } from "@/services/tokens/currency";
import type { Address } from "@/types/web3";

function configuredFactory(): Address | null {
  const { factory } = poolixConfig.contracts.uniswapV2;
  return factory.status === "configured" ? factory.address : null;
}

/** A pool looked up by its pair address. */
export function usePool(address: string | undefined) {
  const client = usePublicClient();
  const factory = configuredFactory();
  const valid = typeof address === "string" && isAddress(address);

  return useQuery<PoolState>({
    queryKey: ["pool", valid ? getAddress(address) : null],
    enabled: client !== undefined && factory !== null && valid,
    retry: 0,
    staleTime: 10_000,
    refetchInterval: 20_000,
    queryFn: () => fetchPool(client as PublicClient, factory as Address, getAddress(address as string)),
  });
}

/** The pool for a pair of currencies, or null when it was never created. */
export function usePoolForPair(tokenA: Currency | null, tokenB: Currency | null) {
  const client = usePublicClient();
  const factory = configuredFactory();
  const weth = poolixConfig.contracts.weth;

  const addressA = tokenA ? currencyAddress(tokenA, weth) : null;
  const addressB = tokenB ? currencyAddress(tokenB, weth) : null;
  const distinct = addressA !== null && addressB !== null && addressA !== addressB;

  return useQuery<PoolState | null>({
    queryKey: ["pool-for-pair", addressA, addressB],
    enabled: client !== undefined && factory !== null && distinct,
    retry: 0,
    staleTime: 10_000,
    queryFn: () =>
      fetchPoolForPair(client as PublicClient, factory as Address, addressA as Address, addressB as Address),
  });
}
