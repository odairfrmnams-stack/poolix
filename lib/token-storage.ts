import { getAddress, isAddress } from "viem";

import type { Currency } from "@/services/liquidity/types";
import { poolixConfig } from "@/config/poolix";

const STORAGE_KEY = `poolix.tokens.${poolixConfig.chain.id}.v1`;

/*
  Poolix ships no curated token list: there is no published list for this chain that
  could be verified, and inventing one would put unverified addresses in front of
  users. Only the native currency and WETH — both constants checked onchain — are
  built in. Everything else is a token the user added by address, read from its own
  contract and kept in this browser.
*/
export const DEFAULT_TOKENS: readonly Currency[] = [
  {
    kind: "native",
    symbol: poolixConfig.chain.nativeCurrency.symbol,
    decimals: poolixConfig.chain.nativeCurrency.decimals,
  },
  {
    kind: "erc20",
    address: poolixConfig.contracts.weth,
    // symbol(), name() and decimals() as reported by the deployed contract.
    symbol: "WETH",
    name: "WETH",
    decimals: 18,
  },
];

type Listener = () => void;

const listeners = new Set<Listener>();
const EMPTY: readonly Currency[] = [];
let cache: readonly Currency[] | null = null;

function isStoredToken(value: unknown): value is Currency {
  if (typeof value !== "object" || value === null) return false;
  const token = value as Record<string, unknown>;
  return (
    token.kind === "erc20" &&
    typeof token.address === "string" &&
    isAddress(token.address) &&
    typeof token.symbol === "string" &&
    typeof token.name === "string" &&
    typeof token.decimals === "number" &&
    Number.isInteger(token.decimals) &&
    token.decimals >= 0 &&
    token.decimals <= 255
  );
}

function read(): readonly Currency[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return EMPTY;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return EMPTY;
    return parsed.filter(isStoredToken);
  } catch {
    // Private mode, blocked storage, or corrupted JSON: start empty rather than throw.
    return EMPTY;
  }
}

function commit(next: readonly Currency[]): void {
  cache = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage may be unavailable; the list still works for this session.
  }
  for (const listener of listeners) listener();
}

export function subscribeToTokens(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getStoredTokens(): readonly Currency[] {
  cache ??= read();
  return cache;
}

/** Nothing is stored server-side, so SSR always renders the built-in tokens only. */
export function getServerTokens(): readonly Currency[] {
  return EMPTY;
}

export function addStoredToken(token: Currency): void {
  if (token.kind !== "erc20") return;
  const address = getAddress(token.address);
  const existing = getStoredTokens();
  if (existing.some((item) => item.kind === "erc20" && getAddress(item.address) === address)) return;
  commit([...existing, { ...token, address }]);
}

export function removeStoredToken(address: string): void {
  const target = getAddress(address);
  commit(getStoredTokens().filter((item) => item.kind !== "erc20" || getAddress(item.address) !== target));
}

export function isDefaultToken(token: Currency): boolean {
  if (token.kind === "native") return true;
  return DEFAULT_TOKENS.some(
    (item) => item.kind === "erc20" && getAddress(item.address) === getAddress(token.address),
  );
}
