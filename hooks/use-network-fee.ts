"use client";

import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";

import type { PreparedCall } from "@/services/liquidity/types";
import type { Address } from "@/types/web3";

/**
 * Estimated cost of a prepared call, in wei. Estimation runs the call against the
 * current state, so it only succeeds once any required approval is in place; until
 * then the fee is genuinely unknown and the caller shows `--`.
 */
export function useNetworkFee(call: PreparedCall | null, account: Address | undefined) {
  const client = usePublicClient();

  return useQuery({
    queryKey: ["network-fee", call?.to, call?.data, call?.value.toString(), account],
    enabled: client !== undefined && call !== null && account !== undefined,
    retry: 0,
    staleTime: 15_000,
    queryFn: async (): Promise<bigint | null> => {
      if (client === undefined || call === null || account === undefined) return null;

      const [gas, fees] = await Promise.all([
        client.estimateGas({ account, to: call.to, data: call.data, value: call.value }),
        client.estimateFeesPerGas(),
      ]);

      const perGas = fees.maxFeePerGas ?? fees.gasPrice;
      return perGas === undefined ? null : gas * perGas;
    },
  });
}
