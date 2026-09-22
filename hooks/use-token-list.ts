"use client";

import { useMemo, useSyncExternalStore } from "react";

import {
  DEFAULT_TOKENS,
  getServerTokens,
  getStoredTokens,
  subscribeToTokens,
} from "@/lib/token-storage";
import type { Currency } from "@/services/liquidity/types";

/**
 * The tokens offered in the selector: the verified built-ins, plus whatever the user
 * has imported by address in this browser.
 */
export function useTokenList(): readonly Currency[] {
  const stored = useSyncExternalStore(subscribeToTokens, getStoredTokens, getServerTokens);
  return useMemo(() => [...DEFAULT_TOKENS, ...stored], [stored]);
}
