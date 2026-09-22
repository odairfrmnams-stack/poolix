import { defineChain } from "viem";
import { cookieStorage, createConfig, createStorage, http } from "wagmi";
import { injected } from "wagmi/connectors";

import { poolixConfig } from "@/config/poolix";

/**
 * The Robinhood Chain network Poolix targets, built from the verified constants in
 * config/chains.ts so viem and wagmi cannot drift from the rest of the app.
 *
 * `contracts.multicall3` is intentionally absent, but not for the reason an earlier
 * comment here gave. Multicall3 IS deployed on this chain and `aggregate3` works (Phase 6
 * verified it at 0xcA11bde05977b3631167028862bE2a173976CA11). It is left out of the wagmi
 * chain definition because the browser's read pattern — a handful of calls per component —
 * is already collapsed by the transport's HTTP batching below, so routing it through a
 * contract would add a hop without removing a round trip. The server-side holder
 * confirmation, which issues tens of thousands of calls, does use it.
 */
export const poolixChain = defineChain({
  id: poolixConfig.chain.id,
  name: poolixConfig.chain.name,
  nativeCurrency: poolixConfig.chain.nativeCurrency,
  rpcUrls: {
    default: { http: [poolixConfig.rpcUrl] },
  },
  blockExplorers: {
    default: poolixConfig.chain.blockExplorers.default,
  },
  testnet: poolixConfig.chain.testnet,
});

export function createWagmiConfig() {
  return createConfig({
    chains: [poolixChain],
    connectors: [injected()],
    // Cookie storage lets the server render the connected state without a flash.
    storage: createStorage({ storage: cookieStorage }),
    ssr: true,
    transports: {
      [poolixChain.id]: http(poolixConfig.rpcUrl, {
        // Collapses the many small eth_calls a pool page makes into single HTTP requests.
        batch: { wait: 16 },
        retryCount: 2,
      }),
    },
  });
}

declare module "wagmi" {
  interface Register {
    config: ReturnType<typeof createWagmiConfig>;
  }
}
