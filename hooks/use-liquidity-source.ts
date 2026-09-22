"use client";

import { useMemo } from "react";
import type { PublicClient } from "viem";
import { usePublicClient } from "wagmi";

import { poolixConfig } from "@/config/poolix";
import type { LiquiditySource } from "@/services/liquidity/types";
import { createUniswapV2Source } from "@/services/liquidity/uniswap-v2/adapter";

/**
 * The liquidity source Poolix quotes against. Today that is always Uniswap v2; when
 * further adapters land this is where routing between them belongs, and no calling
 * component has to change.
 */
export function useLiquiditySource(): LiquiditySource | null {
  const client = usePublicClient();
  return useMemo(
    () => (client ? createUniswapV2Source(client as PublicClient, poolixConfig) : null),
    [client],
  );
}
