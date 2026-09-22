import type { Metadata } from "next";

import { LiquidityField } from "@/components/swap/liquidity-field";
import { SwapCard } from "@/components/swap/swap-card";
import { poolixConfig } from "@/config/poolix";
import { isUniswapV2Available } from "@/config/resolve";
import { copy } from "@/lib/copy";

export const metadata: Metadata = {
  title: copy.swap.swap,
  description: `Swap tokens on ${poolixConfig.chain.name}. Quotes are read from pool reserves onchain.`,
};

export default function SwapPage() {
  const available = isUniswapV2Available(poolixConfig);

  return (
    // `isolate` gives the field a stacking context to sit behind: it uses -z-10, which
    // without this would place it behind the page background instead of behind the card.
    // `overflow-hidden` keeps the rings from widening the page on a narrow viewport.
    <div className="relative isolate mx-auto max-w-[1280px] overflow-hidden px-4 py-10 sm:px-6 sm:py-16">
      <LiquidityField />
      {!available ? (
        <div className="mx-auto mb-6 max-w-[460px] rounded-poolix-lg border border-warning/30 bg-warning/5 px-4 py-3.5">
          <p className="text-[13px] font-medium text-warning">{copy.status.contractNotConfigured}</p>
          <p className="mt-1 text-[12.5px] leading-relaxed text-muted">
            No liquidity source is deployed on {poolixConfig.chain.name}. Switch to a network
            where Poolix has a configured source, or set the router and factory addresses in
            the environment.
          </p>
        </div>
      ) : null}

      <SwapCard />

      <p className="mx-auto mt-6 max-w-[460px] text-center text-[12px] leading-relaxed text-subtle">
        Quotes come from Uniswap v2 pools on {poolixConfig.chain.name}. Poolix never takes
        custody of your tokens; the swap is executed by the router contract you approve.
      </p>
    </div>
  );
}
