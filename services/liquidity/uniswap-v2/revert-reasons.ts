import type { RevertReasonMatcher } from "@/lib/errors";

// Revert strings from the canonical UniswapV2Router02 and UniswapV2Library sources.
export const uniswapV2RevertReasons: readonly RevertReasonMatcher[] = [
  { pattern: "UniswapV2Router: EXPIRED", kind: "deadlineExpired" },
  { pattern: "UniswapV2Router: INSUFFICIENT_OUTPUT_AMOUNT", kind: "slippageExceeded" },
  { pattern: "UniswapV2Router: EXCESSIVE_INPUT_AMOUNT", kind: "slippageExceeded" },
  { pattern: "UniswapV2Router: INSUFFICIENT_A_AMOUNT", kind: "slippageExceeded" },
  { pattern: "UniswapV2Router: INSUFFICIENT_B_AMOUNT", kind: "slippageExceeded" },
  { pattern: "UniswapV2Library: INSUFFICIENT_LIQUIDITY", kind: "insufficientLiquidity" },
];
