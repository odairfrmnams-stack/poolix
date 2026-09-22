import type { Metadata } from "next";

import { DiscoveredPools } from "@/components/pools/discovered-pools";
import { PoolFinder } from "@/components/pools/pool-finder";
import { YourLiquidity } from "@/components/pools/your-liquidity";
import { Notice } from "@/components/ui/notice";
import { PageHeader } from "@/components/ui/page-header";
import { poolixConfig } from "@/config/poolix";
import { isUniswapV2Available } from "@/config/resolve";
import { copy } from "@/lib/copy";
import { discoverPools } from "@/services/pools/discovery";

export const metadata: Metadata = {
  title: copy.nav.pools,
  description: `Provide and manage liquidity on ${poolixConfig.chain.name}.`,
};

// The scan is paced against the RPC's rate limit and shared between visitors. Two
// minutes keeps the page fresh without re-rendering ahead of the scan's own cache, and
// lets a throttled scan recover quickly.
export const revalidate = 120;

export default async function PoolsPage() {
  const available = isUniswapV2Available(poolixConfig);
  const discovery = available
    ? await discoverPools()
    : { pools: [], totalPairs: 0, scanned: 0, complete: false };

  return (
    <div className="mx-auto max-w-[1280px] px-4 py-10 sm:px-6 sm:py-14">
      <PageHeader
        title={copy.nav.pools}
        description={`Provide liquidity to earn a share of the trading fees a pool collects. Reserves and positions are read directly from ${poolixConfig.chain.name}.`}
      />

      {!available ? (
        <div className="mt-8">
          <Notice title={copy.status.contractNotConfigured} tone="warning">
            No liquidity source is deployed on {poolixConfig.chain.name}, so there are no pools
            to show.
          </Notice>
        </div>
      ) : null}

      <section className="mt-10">
        <h2 className="text-[15px] font-medium text-fg">{copy.liquidity.yourLiquidity}</h2>
        <div className="mt-4">
          <YourLiquidity />
        </div>
      </section>

      <section className="mt-10 grid gap-6 lg:grid-cols-[1fr_1.6fr]">
        <PoolFinder />

        <div className="min-w-0">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
            <h2 className="text-[15px] font-medium text-fg">Pools ranked by liquidity</h2>
            <p className="text-[12px] text-subtle">
              {discovery.scanned > 0
                ? `Scanned ${discovery.scanned.toLocaleString("en-US")} of ${discovery.totalPairs.toLocaleString("en-US")} pairs`
                : null}
            </p>
          </div>
          <div className="mt-4">
            <DiscoveredPools result={discovery} />
          </div>
        </div>
      </section>

      <div className="mt-8 grid gap-4 lg:grid-cols-2">
        <Notice title="Why some values read --">
          {copy.poolData.tvl} needs a verified USD price feed, and {copy.poolData.volume24h},{" "}
          {copy.poolData.fees24h} and {copy.poolData.apr} need swap history. The public RPC
          rejects archive queries, so Poolix has neither and shows {copy.data.unavailable} rather
          than an estimate.
        </Notice>
        <Notice title="Why the list is partial">
          The factory holds {discovery.totalPairs.toLocaleString("en-US")} pairs and the public
          endpoint throttles bulk reads, so Poolix ranks the most recently created window rather
          than claiming a complete ranking. Pairs holding under 0.0001 ETH are left out as
          untradeable. Use the finder for any pair.
        </Notice>
      </div>
    </div>
  );
}
