import type { Metadata } from "next";
import Link from "next/link";
import { after } from "next/server";
import { formatUnits } from "viem";

import { ExploreSources } from "@/components/explore/explore-sources";
import { PairBadge } from "@/components/pools/pair-badge";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { poolixConfig } from "@/config/poolix";
import { isUniswapV2Available } from "@/config/resolve";
import { copy } from "@/lib/copy";
import { formatTokenAmount } from "@/lib/format";
import { discoverPools } from "@/services/pools/discovery";
import { indexPons } from "@/services/pons/pons-indexer";
import { getPonsView } from "@/services/pons/pons-view";
import { listTokens } from "@/services/tokens/listing";

export const metadata: Metadata = {
  title: copy.nav.explore,
  description: `Tokens and pools on ${poolixConfig.chain.name}, ranked by the liquidity they actually hold.`,
};

export const revalidate = 120;

/*
  One surface for discovery.

  "Top pools" is the same scan as the table underneath, ranked by ETH held — not a
  separate trending signal, because Poolix has no volume history to rank by and inventing
  one would be the kind of number this project refuses to show.
*/
export default async function ExplorePage() {
  const available = isUniswapV2Available(poolixConfig);
  const discovery = available
    ? await discoverPools()
    : { pools: [], totalPairs: 0, scanned: 0, complete: false };

  const tokens = listTokens(discovery);
  const native = poolixConfig.chain.nativeCurrency.symbol;
  const top = discovery.pools.slice(0, 3);

  // Read-only: every figure here was computed by the indexer tick and persisted.
  const pons = await getPonsView();

  /*
    The index advances AFTER the response, never during it.

    Same arrangement as the holder tick: a render reads persisted state, and the work that
    extends it happens once the page has been sent. Doing it inline cost 85 seconds of
    static generation and dragged the indexer's 30-second revalidate into this route's
    cache window. `after` does not make the route dynamic and fires on each revalidation,
    so the cadence is the page's own.
  */
  after(async () => {
    try {
      await indexPons();
    } catch {
      /*
        A tick that cannot finish changes nothing: the checkpoint only advances over a
        range that was read completely, and the previous dataset still stands. Throwing
        here would fail a response that has already been sent.
      */
    }
  });

  return (
    <div className="mx-auto max-w-[1280px] px-4 py-10 sm:px-6 sm:py-14">
      <PageHeader
        title={copy.nav.explore}
        description={`Tokens and pools on ${poolixConfig.chain.name}, read from the factory and ranked by the ${native} they hold.`}
      />

      {top.length > 0 ? (
        <section className="mt-8">
          <h2 className="mb-3 text-[13px] font-medium text-muted">Deepest pools</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {top.map((pool) => (
              <Link key={pool.address} href={`/pools/${pool.address}`} className="block">
                <Card interactive padding="md" className="h-full">
                  <PairBadge symbol0="WETH" symbol1={pool.other.symbol} />
                  <p className="poolix-numeric mt-4 text-[20px] leading-none text-fg">
                    {formatTokenAmount(formatUnits(BigInt(pool.wethReserve) * 2n, 18), {
                      maximumFractionDigits: 2,
                    })}{" "}
                    <span className="text-[13px] text-subtle">{native}</span>
                  </p>
                  <p className="mt-2 text-[12px] text-subtle">Liquidity held by the pool</p>
                </Card>
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      <section className="mt-8">
        <h2 className="sr-only">Browse tokens and pools</h2>
        <ExploreSources
          uniswap={{ tokens, pools: discovery.pools, native }}
          pons={{
            rows: pons.rows,
            thresholds: pons.thresholds,
            qualifiedCount: pons.qualifiedCount,
            v2AvailableCount: pons.v2AvailableCount,
            indexedCount: pons.index.indexedTokenCount,
          }}
          ponsAvailable={pons.available}
        />
      </section>

      <p className="mt-6 text-[12px] leading-relaxed text-subtle">
        Covering {discovery.scanned.toLocaleString("en-US")} of{" "}
        {discovery.totalPairs.toLocaleString("en-US")} pairs in the scanned window. Prices are the
        mid price implied by pool reserves, before fees and price impact, quoted in {native}{" "}
        because Poolix has no verified USD feed for these tokens.{" "}
        <Link href="/analytics" className="text-accent-text underline-offset-4 hover:underline">
          {copy.nav.analytics}
        </Link>{" "}
        covers the chain-wide figures.
      </p>

      {pons.available ? (
        <p className="mt-3 text-[12px] leading-relaxed text-subtle">
          <strong className="font-medium text-muted">Pons indexed:</strong>{" "}
          {pons.index.indexedTokenCount.toLocaleString("en-US")} launches, indexed through block{" "}
          <span className="poolix-numeric">{pons.index.indexedBlock.toLocaleString("en-US")}</span> of{" "}
          <span className="poolix-numeric">{pons.index.targetBlock.toLocaleString("en-US")}</span>
          {pons.index.coveragePercent === null ? "" : ` (${pons.index.coveragePercent}% of the factory's observed range)`}
          . This is the number of launches Poolix has indexed, not the total number of Pons
          launches — the remainder has not been read and is not estimated.{" "}
          {pons.index.updatedAt === null
            ? "Not yet indexed."
            : `Last indexed ${new Date(pons.index.updatedAt).toISOString().replace("T", " ").slice(0, 19)} UTC.`}{" "}
          Pons tokens trade in Uniswap v3 pools; Poolix does not route swaps through v3, so they are
          listed here for discovery only.
        </p>
      ) : null}
    </div>
  );
}
