"use client";

import { useQuery } from "@tanstack/react-query";

import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useLiquiditySource } from "@/hooks/use-liquidity-source";
import type { Currency, SwapQuote } from "@/services/liquidity/types";
import { currencyId, sameCurrency } from "@/services/tokens/currency";

const QUOTE_DEBOUNCE_MS = 300;

export interface SwapQuoteInput {
  readonly currencyIn: Currency | null;
  readonly currencyOut: Currency | null;
  readonly amountIn: bigint | null;
  readonly slippageBps: number;
}

export interface SwapQuoteResult {
  readonly quote: SwapQuote | null;
  /** True while a quote is being fetched, including the debounce window. */
  readonly isPending: boolean;
  readonly isError: boolean;
  readonly error: unknown;
  /** True when a route exists but produced no quote, rather than no input at all. */
  readonly hasNoRoute: boolean;
  readonly refetch: () => void;
}

/**
 * Quotes an exact-input swap. The amount is debounced so typing does not fan out into
 * one RPC round trip per keystroke, and react-query's AbortSignal cancels a quote that
 * a newer one has superseded.
 */
export function useSwapQuote({
  currencyIn,
  currencyOut,
  amountIn,
  slippageBps,
}: SwapQuoteInput): SwapQuoteResult {
  const source = useLiquiditySource();
  const debouncedAmount = useDebouncedValue(amountIn, QUOTE_DEBOUNCE_MS);

  const pairIsValid =
    currencyIn !== null && currencyOut !== null && !sameCurrency(currencyIn, currencyOut);
  const enabled =
    source !== null && pairIsValid && debouncedAmount !== null && debouncedAmount > 0n;

  const query = useQuery({
    queryKey: [
      "swap-quote",
      currencyIn ? currencyId(currencyIn) : null,
      currencyOut ? currencyId(currencyOut) : null,
      debouncedAmount?.toString() ?? null,
      slippageBps,
    ],
    enabled,
    retry: 0,
    staleTime: 10_000,
    refetchInterval: 20_000,
    queryFn: async ({ signal }) => {
      if (source === null || currencyIn === null || currencyOut === null || debouncedAmount === null) {
        return null;
      }
      return source.quoteExactIn(
        { currencyIn, currencyOut, amountIn: debouncedAmount, slippageBps },
        signal,
      );
    },
  });

  // While the debounce is still catching up, the displayed quote does not match the
  // typed amount, so it counts as pending rather than settled.
  const isDebouncing = amountIn !== debouncedAmount;
  const quote = isDebouncing ? null : (query.data ?? null);

  return {
    quote,
    isPending: enabled ? query.isPending || query.isFetching || isDebouncing : isDebouncing,
    isError: query.isError,
    error: query.error,
    hasNoRoute: enabled && !isDebouncing && !query.isFetching && query.data === null,
    refetch: () => void query.refetch(),
  };
}
