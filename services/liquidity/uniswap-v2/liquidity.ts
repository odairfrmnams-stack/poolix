import { encodeFunctionData, getAddress } from "viem";

import { uniswapV2RouterAbi } from "@/services/abis/uniswap-v2";
import type { Currency, PreparedCall } from "@/services/liquidity/types";
import { applySlippage } from "@/services/liquidity/uniswap-v2/math";
import type { Address } from "@/types/web3";

export interface AddLiquidityParams {
  readonly router: Address;
  readonly currencyA: Currency;
  readonly currencyB: Currency;
  readonly amountA: bigint;
  readonly amountB: bigint;
  readonly slippageBps: number;
  readonly recipient: Address;
  readonly deadline: bigint;
}

export interface RemoveLiquidityParams {
  readonly router: Address;
  readonly currencyA: Currency;
  readonly currencyB: Currency;
  readonly liquidity: bigint;
  /** Expected underlying amounts before slippage, in the same order as the currencies. */
  readonly amountA: bigint;
  readonly amountB: bigint;
  readonly slippageBps: number;
  readonly recipient: Address;
  readonly deadline: bigint;
}

export class UnsupportedPairError extends Error {
  override readonly name = "UnsupportedPairError";
}

function tokenAddress(currency: Currency): Address {
  if (currency.kind !== "erc20") {
    throw new UnsupportedPairError("Expected an ERC-20 token, received the native currency.");
  }
  return getAddress(currency.address);
}

/**
 * Builds an add-liquidity call. A pair with one native side uses addLiquidityETH and
 * carries the ETH as call value; the router wraps it. Two native sides are impossible,
 * so that combination is rejected rather than silently mishandled.
 */
export function buildAddLiquidity({
  router,
  currencyA,
  currencyB,
  amountA,
  amountB,
  slippageBps,
  recipient,
  deadline,
}: AddLiquidityParams): PreparedCall {
  const aIsNative = currencyA.kind === "native";
  const bIsNative = currencyB.kind === "native";

  if (aIsNative && bIsNative) {
    throw new UnsupportedPairError("A pool needs two different assets.");
  }

  const minA = applySlippage(amountA, slippageBps);
  const minB = applySlippage(amountB, slippageBps);

  if (aIsNative || bIsNative) {
    const token = tokenAddress(aIsNative ? currencyB : currencyA);
    const amountToken = aIsNative ? amountB : amountA;
    const amountTokenMin = aIsNative ? minB : minA;
    const amountEth = aIsNative ? amountA : amountB;
    const amountEthMin = aIsNative ? minA : minB;

    return {
      to: router,
      data: encodeFunctionData({
        abi: uniswapV2RouterAbi,
        functionName: "addLiquidityETH",
        args: [token, amountToken, amountTokenMin, amountEthMin, recipient, deadline],
      }),
      value: amountEth,
    };
  }

  return {
    to: router,
    data: encodeFunctionData({
      abi: uniswapV2RouterAbi,
      functionName: "addLiquidity",
      args: [
        tokenAddress(currencyA),
        tokenAddress(currencyB),
        amountA,
        amountB,
        minA,
        minB,
        recipient,
        deadline,
      ],
    }),
    value: 0n,
  };
}

/** Builds a remove-liquidity call, unwrapping to ETH when one side is native. */
export function buildRemoveLiquidity({
  router,
  currencyA,
  currencyB,
  liquidity,
  amountA,
  amountB,
  slippageBps,
  recipient,
  deadline,
}: RemoveLiquidityParams): PreparedCall {
  const aIsNative = currencyA.kind === "native";
  const bIsNative = currencyB.kind === "native";

  if (aIsNative && bIsNative) {
    throw new UnsupportedPairError("A pool needs two different assets.");
  }

  const minA = applySlippage(amountA, slippageBps);
  const minB = applySlippage(amountB, slippageBps);

  if (aIsNative || bIsNative) {
    const token = tokenAddress(aIsNative ? currencyB : currencyA);
    const amountTokenMin = aIsNative ? minB : minA;
    const amountEthMin = aIsNative ? minA : minB;

    return {
      to: router,
      data: encodeFunctionData({
        abi: uniswapV2RouterAbi,
        functionName: "removeLiquidityETH",
        args: [token, liquidity, amountTokenMin, amountEthMin, recipient, deadline],
      }),
      value: 0n,
    };
  }

  return {
    to: router,
    data: encodeFunctionData({
      abi: uniswapV2RouterAbi,
      functionName: "removeLiquidity",
      args: [tokenAddress(currencyA), tokenAddress(currencyB), liquidity, minA, minB, recipient, deadline],
    }),
    value: 0n,
  };
}
