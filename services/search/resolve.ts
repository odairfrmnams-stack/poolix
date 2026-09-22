import { erc20Abi, getAddress, isAddress, type PublicClient } from "viem";

import { sanitizeSymbol } from "@/lib/token-text";
import { uniswapV2PairAbi } from "@/services/abis/uniswap-v2";
import type { Address } from "@/types/web3";

export type SearchResult =
  | { readonly kind: "pool"; readonly address: Address }
  | { readonly kind: "token"; readonly address: Address; readonly symbol: string }
  | { readonly kind: "contract"; readonly address: Address }
  | { readonly kind: "account"; readonly address: Address }
  | { readonly kind: "transaction"; readonly hash: `0x${string}` };

const TX_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;

/**
 * Works out what an address actually is by asking the chain, rather than guessing from
 * its shape. Pools are only reported as pools when the contract names the configured
 * factory as its creator, so a lookalike cannot pass itself off as one.
 */
export async function resolveSearch(
  client: PublicClient,
  factory: Address | null,
  query: string,
): Promise<SearchResult | null> {
  const trimmed = query.trim();

  if (TX_HASH_PATTERN.test(trimmed)) {
    return { kind: "transaction", hash: trimmed as `0x${string}` };
  }
  if (!isAddress(trimmed)) return null;

  const address = getAddress(trimmed);
  const code = await client.getCode({ address });
  if (code === undefined || code === "0x") return { kind: "account", address };

  if (factory !== null) {
    try {
      const pairFactory = await client.readContract({
        address,
        abi: uniswapV2PairAbi,
        functionName: "factory",
      });
      if (getAddress(pairFactory) === getAddress(factory)) return { kind: "pool", address };
    } catch {
      // Not a pair; fall through to the token check.
    }
  }

  try {
    const [symbol] = await Promise.all([
      client.readContract({ address, abi: erc20Abi, functionName: "symbol" }),
      // decimals() is what makes a token usable, so require it too.
      client.readContract({ address, abi: erc20Abi, functionName: "decimals" }),
    ]);
    // Contract-supplied, so it is sanitised before it reaches a search result row.
    return { kind: "token", address, symbol: sanitizeSymbol(symbol) ?? "Token" };
  } catch {
    return { kind: "contract", address };
  }
}
