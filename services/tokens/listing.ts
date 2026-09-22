import { getAddress } from "viem";

import type { PoolDiscoveryResult } from "@/services/pools/discovery";
import { midPrice, poolValueInQuote } from "@/services/pools/pricing";
import type { Address } from "@/types/web3";

export interface TokenListing {
  readonly address: Address;
  readonly symbol: string;
  readonly decimals: number;
  /** Mid price in the chain's native asset, from the deepest pool. Never in USD. */
  readonly priceEth: number | null;
  /** Combined value of the token's pools, in wei of the native asset. */
  readonly ethLiquidity: bigint;
  readonly poolCount: number;
  readonly deepestPool: Address;
}

/**
 * Collapses discovered pools into one row per token. A token can have several pools
 * against WETH; liquidity is summed across them and the price comes from the deepest,
 * which is the one a trade would actually route through.
 */
export function listTokens(result: PoolDiscoveryResult): readonly TokenListing[] {
  const byToken = new Map<Address, { listing: TokenListing; deepestReserve: bigint }>();

  for (const pool of result.pools) {
    const address = getAddress(pool.other.address);
    const wethReserve = BigInt(pool.wethReserve);
    const otherReserve = BigInt(pool.otherReserve);
    const existing = byToken.get(address);

    const liquidity = poolValueInQuote(wethReserve);
    const isDeepest = existing === undefined || wethReserve > existing.deepestReserve;

    const price = isDeepest
      ? midPrice(otherReserve, pool.other.decimals, wethReserve, 18)
      : existing.listing.priceEth;

    byToken.set(address, {
      deepestReserve: isDeepest ? wethReserve : existing.deepestReserve,
      listing: {
        address,
        symbol: pool.other.symbol,
        decimals: pool.other.decimals,
        priceEth: price,
        ethLiquidity: (existing?.listing.ethLiquidity ?? 0n) + liquidity,
        poolCount: (existing?.listing.poolCount ?? 0) + 1,
        deepestPool: isDeepest ? getAddress(pool.address) : existing.listing.deepestPool,
      },
    });
  }

  return [...byToken.values()]
    .map((entry) => entry.listing)
    .sort((a, b) => (b.ethLiquidity > a.ethLiquidity ? 1 : b.ethLiquidity < a.ethLiquidity ? -1 : 0));
}
