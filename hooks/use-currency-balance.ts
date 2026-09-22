"use client";

import { erc20Abi } from "viem";
import { useBalance, useReadContract } from "wagmi";

import type { Currency } from "@/services/liquidity/types";
import type { Address } from "@/types/web3";

export interface CurrencyBalance {
  readonly value: bigint | undefined;
  readonly isLoading: boolean;
  readonly isError: boolean;
  readonly refetch: () => void;
}

/**
 * Balance of a currency for an account. Native ETH comes from eth_getBalance and
 * ERC-20s from balanceOf; both hooks are always called, and only the relevant one
 * is enabled.
 */
export function useCurrencyBalance(
  currency: Currency | null,
  owner: Address | undefined,
): CurrencyBalance {
  const isNative = currency?.kind === "native";
  const tokenAddress = currency?.kind === "erc20" ? currency.address : undefined;

  const native = useBalance({
    address: owner,
    query: { enabled: Boolean(owner) && isNative },
  });

  const token = useReadContract({
    address: tokenAddress,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: owner ? [owner] : undefined,
    query: { enabled: Boolean(owner) && Boolean(tokenAddress) },
  });

  if (isNative) {
    return {
      value: native.data?.value,
      isLoading: native.isLoading,
      isError: native.isError,
      refetch: () => void native.refetch(),
    };
  }

  return {
    value: token.data,
    isLoading: token.isLoading,
    isError: token.isError,
    refetch: () => void token.refetch(),
  };
}

/** Allowance granted to a spender. Native currencies never need one. */
export function useAllowance(
  currency: Currency | null,
  owner: Address | undefined,
  spender: Address | null,
) {
  const tokenAddress = currency?.kind === "erc20" ? currency.address : undefined;
  const enabled = Boolean(owner) && Boolean(tokenAddress) && Boolean(spender);

  return useReadContract({
    address: tokenAddress,
    abi: erc20Abi,
    functionName: "allowance",
    args: owner && spender ? [owner, spender] : undefined,
    query: { enabled },
  });
}
