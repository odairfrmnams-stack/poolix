import "server-only";

import { getAddress, type PublicClient } from "viem";

import { poolixConfig } from "@/config/poolix";
import { uniswapV2PairAbi } from "@/services/abis/uniswap-v2";
import type { WethSide } from "@/services/analytics/swap-math";
import type { Address } from "@/types/web3";

/*
  Which side of a pair holds WETH.

  Shared by the 24h window and the historical window so both answer this question the
  same way — the volume definition depends on it, and two implementations could drift
  into two different definitions of "ETH-side volume".

  The answer is immutable for a given pair, so callers cache it permanently and this runs
  once per pair ever.
*/

const BATCH_SIZE = 40;
const BATCH_PAUSE_MS = 120;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Classifies pairs by which side holds WETH, reading token0/token1 once per pair.
 *
 * A pair whose reads fail is left out of the result entirely rather than recorded as
 * `none`. That distinction matters: `none` means "definitely a token/token pair and
 * excluded by design", while absent means "ask again later" — recording a transient RPC
 * failure as `none` would drop a real WETH pair's volume for good.
 */
export async function resolvePairSides(
  client: PublicClient,
  pairs: readonly Address[],
): Promise<Map<string, WethSide>> {
  const weth = getAddress(poolixConfig.contracts.weth);
  const resolved = new Map<string, WethSide>();

  for (let index = 0; index < pairs.length; index += BATCH_SIZE) {
    if (index > 0) await sleep(BATCH_PAUSE_MS);
    const slice = pairs.slice(index, index + BATCH_SIZE);

    const results = await Promise.all(
      slice.map(async (pair) => {
        try {
          const [token0, token1] = await Promise.all([
            client.readContract({ address: pair, abi: uniswapV2PairAbi, functionName: "token0" }),
            client.readContract({ address: pair, abi: uniswapV2PairAbi, functionName: "token1" }),
          ]);
          if (getAddress(token0) === weth) return [pair, "token0"] as const;
          if (getAddress(token1) === weth) return [pair, "token1"] as const;
          return [pair, "none"] as const;
        } catch {
          return null;
        }
      }),
    );

    for (const entry of results) {
      if (entry !== null) resolved.set(entry[0].toLowerCase(), entry[1]);
    }
  }

  return resolved;
}
