import type { Address, Hex } from "@/types/web3";

/** Extend this union when a new liquidity source adapter is implemented. */
export type LiquiditySourceId = "uniswap-v2";

export type Currency =
  | { readonly kind: "native"; readonly symbol: string; readonly decimals: number }
  | {
      readonly kind: "erc20";
      readonly address: Address;
      readonly symbol: string;
      readonly name: string;
      readonly decimals: number;
    };

export interface ExactInSwapRequest {
  readonly currencyIn: Currency;
  readonly currencyOut: Currency;
  readonly amountIn: bigint;
  readonly slippageBps: number;
}

export interface SwapQuote {
  readonly source: LiquiditySourceId;
  readonly request: ExactInSwapRequest;
  readonly amountOut: bigint;
  readonly minimumAmountOut: bigint;
  readonly priceImpactBps: number;
  readonly route: readonly Address[];
  /** Contract that needs an ERC-20 allowance; null when the input is native ETH. */
  readonly approvalSpender: Address | null;
  readonly quotedAtBlock: bigint;
}

export interface SwapExecutionParams {
  readonly quote: SwapQuote;
  readonly recipient: Address;
  readonly deadline: bigint;
}

export interface PreparedCall {
  readonly to: Address;
  readonly data: Hex;
  readonly value: bigint;
}

export type SourceAvailability =
  | { readonly available: true }
  | { readonly available: false; readonly reason: "contractNotConfigured" | "contractInvalid" };

/**
 * Swap surface shared by every liquidity source. Liquidity management stays
 * source-specific: v2 LP tokens, v3/v4 ranged positions, and v4 pool IDs differ too much to unify.
 */
export interface LiquiditySource {
  readonly id: LiquiditySourceId;
  getAvailability(): SourceAvailability;
  /** Resolves to null when this source has no route for the pair. */
  quoteExactIn(request: ExactInSwapRequest, signal?: AbortSignal): Promise<SwapQuote | null>;
  buildSwap(params: SwapExecutionParams): PreparedCall;
}
