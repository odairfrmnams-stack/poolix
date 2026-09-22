import { resolvePoolixConfig } from "@/config/resolve";

// Next.js inlines NEXT_PUBLIC_* values only when each variable is referenced literally.
export const poolixConfig = resolvePoolixConfig({
  network: process.env.NEXT_PUBLIC_POOLIX_NETWORK,
  rpcUrl: process.env.NEXT_PUBLIC_RPC_URL,
  uniswapV2Factory: process.env.NEXT_PUBLIC_UNISWAP_V2_FACTORY_ADDRESS,
  uniswapV2Router: process.env.NEXT_PUBLIC_UNISWAP_V2_ROUTER_ADDRESS,
});
