"use client";

import { useState } from "react";

import { ExploreBrowser, type ExploreBrowserProps } from "@/components/explore/explore-browser";
import { PonsBrowser, type PonsBrowserProps } from "@/components/pons/pons-browser";
import { Tabs } from "@/components/ui/tabs";

/*
  One switch between two discovery sources that are genuinely different things.

  Uniswap rows come from V2 pool reserves. Pons rows come from launch events and V3 pools.
  They are NOT merged into a single table: a V2 pair and a V3 pool have different liquidity
  models, and a column that means "reserves" for one row and "slot0 price" for the next is
  a column that means nothing. Keeping them separate is what lets each say exactly what it
  measured.
*/

type Source = "all" | "pons" | "uniswap";

export interface ExploreSourcesProps {
  readonly uniswap: ExploreBrowserProps;
  readonly pons: PonsBrowserProps;
  readonly ponsAvailable: boolean;
}

export function ExploreSources({ uniswap, pons, ponsAvailable }: ExploreSourcesProps) {
  const [source, setSource] = useState<Source>("all");

  const showUniswap = source === "all" || source === "uniswap";
  const showPons = ponsAvailable && (source === "all" || source === "pons");

  return (
    <div>
      <Tabs
        items={[
          { value: "all", label: "All" },
          { value: "pons", label: "Pons", count: ponsAvailable ? pons.rows.length : undefined },
          { value: "uniswap", label: "Uniswap", count: uniswap.tokens.length },
        ]}
        value={source}
        onChange={setSource}
        label="Discovery source"
        className="mb-5"
      />

      {showPons ? (
        <section className={showUniswap ? "mb-10" : undefined}>
          <h3 className="mb-3 text-[13px] font-medium text-muted">Pons launches</h3>
          <PonsBrowser {...pons} />
        </section>
      ) : null}

      {source === "pons" && !ponsAvailable ? (
        <p className="text-[13px] text-subtle">
          The Pons index is not available in this deployment.
        </p>
      ) : null}

      {showUniswap ? (
        <section>
          {showPons ? (
            <h3 className="mb-3 text-[13px] font-medium text-muted">Uniswap v2 pools</h3>
          ) : null}
          <ExploreBrowser {...uniswap} />
        </section>
      ) : null}
    </div>
  );
}
