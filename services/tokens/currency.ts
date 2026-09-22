import { getAddress } from "viem";

import type { Currency } from "@/services/liquidity/types";
import type { Address } from "@/types/web3";

export const NATIVE_CURRENCY_ID = "native" as const;

export function nativeCurrency(symbol: string, decimals: number): Currency {
  return { kind: "native", symbol, decimals };
}

export function isNative(currency: Currency): boolean {
  return currency.kind === "native";
}

/**
 * The ERC-20 a currency trades as. Native ETH has no token contract, so pools and
 * routers see its wrapper instead.
 */
export function currencyAddress(currency: Currency, weth: Address): Address {
  return currency.kind === "native" ? getAddress(weth) : getAddress(currency.address);
}

/** Stable identity for react-query keys, selection state and equality checks. */
export function currencyId(currency: Currency): string {
  return currency.kind === "native" ? NATIVE_CURRENCY_ID : getAddress(currency.address);
}

export function sameCurrency(a: Currency, b: Currency): boolean {
  return currencyId(a) === currencyId(b);
}

/** True for an ETH <-> WETH pair, which is a wrap rather than a trade through a pool. */
export function isWrapPair(input: Currency, output: Currency, weth: Address): boolean {
  const wrapped = getAddress(weth);
  const inputIsNative = input.kind === "native";
  const outputIsNative = output.kind === "native";
  if (inputIsNative === outputIsNative) return false;

  const token = inputIsNative ? output : input;
  return token.kind === "erc20" && getAddress(token.address) === wrapped;
}
