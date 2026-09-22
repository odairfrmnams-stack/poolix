import { ChevronDown } from "lucide-react";
import type { Metadata } from "next";
import { after } from "next/server";
import { formatUnits } from "viem";

import { DashboardChart } from "@/components/analytics/dashboard-chart";
import { MetricRow, MetricTile, SectionHeading } from "@/components/analytics/dashboard-metrics";
import { PoolRankings, TokenRankings } from "@/components/analytics/dashboard-rankings";
import { LiquidityDistribution } from "@/components/analytics/liquidity-distribution";
import { PageHeader } from "@/components/ui/page-header";
import { poolixConfig } from "@/config/poolix";
import { isUniswapV2Available } from "@/config/resolve";
import { copy } from "@/lib/copy";
import { formatNumber, formatTokenAmount, formatUsd } from "@/lib/format";
import type { MetricView } from "@/services/analytics/dashboard-view";
import { getApr } from "@/services/analytics/apr-window";
import { getDashboard } from "@/services/analytics/dashboard";
import { getHistory } from "@/services/analytics/history-window";
import { getLiquidityHistory } from "@/services/analytics/liquidity-history";
import { runNextRefresh } from "@/services/analytics/refresh-rotation";
import { getPoolHistory } from "@/services/pools/pool-history";
import { getHolders } from "@/services/analytics/holders-window";
import { discoverPools } from "@/services/pools/discovery";
import { getTokenUniverse } from "@/services/tokens/universe";

export const metadata: Metadata = {
  title: copy.analytics.analytics,
  description: `Liquidity and market structure across ${poolixConfig.chain.name}.`,
};

export const revalidate = 120;

/** Formats a wei metric, or the em-dash when there is nothing to format. */
function ethValue(view: MetricView, digits = 2): string {
  if (view.value === null) return copy.data.unavailable;
  return formatTokenAmount(formatUnits(BigInt(view.value), 18), { maximumFractionDigits: digits });
}

function countValue(view: MetricView): string {
  if (view.value === null) return copy.data.unavailable;
  return formatNumber(Number(view.value), { maximumFractionDigits: 0 });
}

function usdValue(view: MetricView): string {
  if (view.value === null) return copy.data.unavailable;
  return formatUsd(Number(BigInt(view.value)) / 100);
}

export default async function AnalyticsPage() {
  const dashboard = await getDashboard();
  // The distribution chart consumes the same scan the dashboard aggregated; the discovery
  // service caches per tick, so this is the same universe rather than a second scan.
  const discovery = isUniswapV2Available(poolixConfig)
    ? await discoverPools()
    : { pools: [], totalPairs: 0, scanned: 0, complete: false };

  /*
    Holders advances AFTER the response, never during it.

    The render reads the published holder snapshot and nothing more, because confirming
    balances is allowed to spend a whole tick budget and a page must not wait on it — that
    is what put the prerender at 61s against Next's 60s ceiling.

    But something still has to advance it, and after the render stopped calling the tick,
    nothing did: the token universe kept rotating on every revalidation while the holder
    snapshot stayed frozen on whichever universe last ticked it, so the two drifted apart
    and the published count described a set that no longer existed.

    `after` is the fix rather than a cron because it keeps the two in the same place. The
    universe read here is the one this render just used — getTokenUniverse serves it from
    the tick cache, so this is not a second scan — and holders is advanced over exactly
    that list. The callback runs once the response is sent and, on this statically
    generated route, on every revalidation, so the cadence is the page's own.
  */
  const universe = await getTokenUniverse();
  after(async () => {
    try {
      /*
        One refresh per render, rotating.

        These ticks used to run inside getDashboard, so every visitor waited for them —
        measured cold at 1.5s, 7.0s, 4.1s and 14.1s. Moving them here fixed the render but
        created a second problem: run end to end they take well over a minute, and because
        `after` counts towards a prerender's budget, /analytics began failing its build
        with "took more than 60 seconds".

        So each render advances exactly one of them. With a 30-second revalidate the whole
        set refreshes inside a couple of minutes, every tick is bounded, and no single
        response carries the cost of all five. The same shape the Pons indexer uses, for
        the same reason.

        The order matters where the services do: liquidity is refreshed before APR, which
        reads it.
      */
      await runNextRefresh("analytics", [
        ["history", getHistory],
        /*
          Liquidity and APR advance TOGETHER, in one slot.

          APR's denominator is the time-weighted liquidity of a specific set of pools, and
          verify:apr asserts the two describe the same set. Refreshing them on separate
          renders let liquidity move to a new pool set while APR still held the old one:
          16 pools against 6, and a ratio that is not an APR of anything. They depend on
          each other, so they are not independent rotation steps.
        */
        [
          "liquidity-history+apr",
          async () => {
            await getLiquidityHistory();
            await getApr();
          },
        ],
        ["pool-history", getPoolHistory],
        ["holders", () => getHolders(universe.tokens)],
      ]);
    } catch {
      /*
        A tick that cannot finish changes nothing: progress is persisted by the tick
        itself, the previous snapshot still stands, and the next revalidation picks up
        from the same queue. Letting this throw would fail a response that has already
        been sent successfully.
      */
    }
  });

  const { headline, coverage, timeframes, day } = dashboard;
  const native = dashboard.nativeSymbol;
  const week = timeframes["7D"];
  const month = timeframes["30D"];

  return (
    <div className="mx-auto max-w-[1400px] px-4 py-10 sm:px-6 sm:py-14">
      <PageHeader
        title={copy.analytics.analytics}
        description={`Liquidity and market structure on ${dashboard.chainName}, measured directly from the factory and its pairs. Every figure states the window it covers and the scope it does not.`}
      />

      {/* ------------------------------------------------------------ overview */}
      <section className="mt-8">
        <SectionHeading
          title="Overview"
          aside={
            coverage.latestBlock === null
              ? undefined
              : `Block ${coverage.latestBlock.toLocaleString("en-US")}`
          }
        />
        <MetricRow>
          <MetricTile
            index={0}
            emphasis
            label="Poolix scanned TVL"
            metric={headline.tvlCents}
            display={usdValue(headline.tvlCents)}
            tip={{ label: copy.tooltips.tvl.title, body: copy.tooltips.tvl.body }}
          />
          <MetricTile
            index={1}
            label={`Scanned liquidity (${native})`}
            metric={headline.scannedLiquidityWei}
            display={ethValue(headline.scannedLiquidityWei, 2)}
          />
          <MetricTile
            index={2}
            label={`Volume 24H (${native})`}
            metric={headline.volume24hWei}
            display={ethValue(headline.volume24hWei, 2)}
            timeframe="24H"
          />
          <MetricTile
            index={3}
            label={`Fees 24H (${native})`}
            metric={headline.fees24hWei}
            display={ethValue(headline.fees24hWei, 4)}
            timeframe="24H"
          />
        </MetricRow>
      </section>

      {/* --------------------------------------------------------------- chart */}
      <section className="mt-8">
        <SectionHeading title="History" aside="Hourly buckets over exact clock hours" />
        <DashboardChart
          week={week}
          month={month}
          nativeSymbol={native}
          unavailableLabel={copy.data.unavailable}
        />
      </section>

      {/* ------------------------------------------------- volume, fees, APR */}
      <section className="mt-8">
        <SectionHeading
          title="Volume and fees"
          aside={`${native} side of Uniswap v2 swaps · 0.30% fee`}
        />
        <MetricRow columns={3}>
          <MetricTile
            index={0}
            label={`Volume 24H (${native})`}
            metric={headline.volume24hWei}
            display={ethValue(headline.volume24hWei, 4)}
            timeframe="24H rolling"
          />
          <MetricTile
            index={1}
            label={`Volume 7D (${native})`}
            metric={{
              value: week.volumeWei,
              kind: "historical-aggregate",
              note: `${week.swaps.toLocaleString("en-US")} swaps across ${week.bucketsExpected} hourly buckets`,
              unavailableReason: `Window incomplete: ${week.bucketsPresent} of ${week.bucketsExpected} hours ingested`,
            }}
            display={ethValue({ value: week.volumeWei, kind: "historical-aggregate", note: "" }, 4)}
            timeframe="7D"
          />
          <MetricTile
            index={2}
            label={`Volume 30D (${native})`}
            metric={{
              value: month.volumeWei,
              kind: "historical-aggregate",
              note: `${month.swaps.toLocaleString("en-US")} swaps across ${month.bucketsExpected} hourly buckets`,
              unavailableReason: `Window incomplete: ${month.bucketsPresent} of ${month.bucketsExpected} hours ingested`,
            }}
            display={ethValue({ value: month.volumeWei, kind: "historical-aggregate", note: "" }, 4)}
            timeframe="30D"
          />
          <MetricTile
            index={3}
            label={`Fees 24H (${native})`}
            metric={headline.fees24hWei}
            display={ethValue(headline.fees24hWei, 6)}
            timeframe="24H rolling"
          />
          <MetricTile
            index={4}
            label={`Fees 7D (${native})`}
            metric={{
              value: week.feesWei,
              kind: "historical-aggregate",
              note: "0.30% of the 7D swap volume",
              unavailableReason: "Needs the full window",
            }}
            display={ethValue({ value: week.feesWei, kind: "historical-aggregate", note: "" }, 6)}
            timeframe="7D"
          />
          <MetricTile
            index={5}
            label={`Fees 30D (${native})`}
            metric={{
              value: month.feesWei,
              kind: "historical-aggregate",
              note: "0.30% of the 30D swap volume",
              unavailableReason: "Needs the full window",
            }}
            display={ethValue({ value: month.feesWei, kind: "historical-aggregate", note: "" }, 6)}
            timeframe="30D"
          />
        </MetricRow>

        <p className="mt-3 text-[11.5px] leading-relaxed text-subtle">
          Volume is the {native} side of each Uniswap v2 Swap, so it is measured rather than
          priced and no oracle is involved. Fees are the protocol&rsquo;s 0.30% of that volume.
          Token-to-token swaps are excluded from both: valuing them would need a rate Poolix
          cannot verify.
          {day.ignoredNonWeth > 0 ? (
            <> {day.ignoredNonWeth.toLocaleString("en-US")} such swaps were excluded from the 24-hour window.</>
          ) : null}
          {day.unresolvedSwaps > 0 ? (
            <>
              {" "}
              A further {day.unresolvedSwaps.toLocaleString("en-US")} swaps in that window sat on
              pairs whose sides were not yet classified when the hour was ingested, so they are not
              attributed to either total — the 24-hour volume is a lower bound rather than a
              complete figure until those pairs are resolved.
            </>
          ) : null}{" "}
          The 24-hour figure measures a rolling block range; 7D and 30D sum exact clock hours,
          so the two are deliberately different windows and are not added together.
        </p>
      </section>

      {/* ---------------------------------------------------------- liquidity */}
      <section className="mt-8">
        <SectionHeading title="Liquidity" aside={`${native}-denominated · no historical USD`} />
        <MetricRow>
          <MetricTile
            index={0}
            label="Poolix scanned TVL"
            metric={headline.tvlCents}
            display={usdValue(headline.tvlCents)}
          />
          <MetricTile
            index={1}
            label={`Scanned liquidity (${native})`}
            metric={headline.scannedLiquidityWei}
            display={ethValue(headline.scannedLiquidityWei, 4)}
          />
          <MetricTile
            index={2}
            label={`Liquidity 7D (${native})`}
            metric={{
              value: week.liquidityLatestWei,
              kind: "snapshot",
              note: `Latest hour of the 7D series · range ${week.liquidityMinWei === null ? copy.data.unavailable : ethValue({ value: week.liquidityMinWei, kind: "snapshot", note: "" }, 2)} – ${week.liquidityMaxWei === null ? copy.data.unavailable : ethValue({ value: week.liquidityMaxWei, kind: "snapshot", note: "" }, 2)}`,
              unavailableReason: "Liquidity window incomplete",
            }}
            display={ethValue({ value: week.liquidityLatestWei, kind: "snapshot", note: "" }, 4)}
            timeframe="7D"
          />
          <MetricTile
            index={3}
            label={`Avg liquidity 30D (${native})`}
            metric={{
              value: month.twalWei,
              kind: "time-weighted",
              note: "Time-weighted across the 30D window — the APR denominator",
              unavailableReason: "No liquidity snapshots in this window",
            }}
            display={ethValue({ value: month.twalWei, kind: "time-weighted", note: "" }, 4)}
            timeframe="30D"
          />
        </MetricRow>

        <p className="mt-3 text-[11.5px] leading-relaxed text-subtle">
          <strong className="font-medium text-muted">Poolix scanned liquidity</strong> covers the
          pools this deployment has discovered — it is not total {dashboard.chainName} TVL, and it
          is never labelled as such. The USD figure prices exactly that {native} liquidity at the
          Chainlink ETH/USD feed, read fresh and rejected if the round is stale.{" "}
          Historical liquidity stays {native}-denominated: that feed publishes no usable history on
          this chain, so a historical USD series would have to be invented and is therefore absent
          rather than estimated.
        </p>
      </section>

      {/* ---------------------------------------------------------------- APR */}
      <section className="mt-8">
        <SectionHeading title="Historical fee APR" aside="Measured, not projected" />
        <MetricRow columns={2}>
          <MetricTile
            index={0}
            label="7D fee APR"
            metric={{
              value: week.aprDisplay,
              kind: "time-weighted",
              note: "Annualized 7D fee revenue over time-weighted average liquidity",
              unavailableReason: aprReason(week.aprReason),
            }}
            display={week.aprDisplay ?? copy.data.unavailable}
            timeframe="7D"
          />
          <MetricTile
            index={1}
            label="30D fee APR"
            metric={{
              value: month.aprDisplay,
              kind: "time-weighted",
              note: "Annualized 30D fee revenue over time-weighted average liquidity",
              unavailableReason: aprReason(month.aprReason),
            }}
            display={month.aprDisplay ?? copy.data.unavailable}
            timeframe="30D"
          />
        </MetricRow>

        <p className="mt-3 text-[11.5px] leading-relaxed text-subtle">
          Historical fee APR is fee revenue from the selected period, annualized and divided by
          time-weighted average {native} liquidity over the same period and the same pools. It is a
          measurement of what already happened — not a projection, not compounded, and it does not
          account for impermanent loss or token price movement. A pool with little liquidity can
          produce a very large figure from a small amount of trading; that is the arithmetic
          reported honestly, not a yield on offer.
        </p>
      </section>

      {/* --------------------------------------------------- network activity */}
      <section className="mt-8">
        <SectionHeading title="Network activity" aside="Rolling 24-hour window" />
        <MetricRow>
          <MetricTile
            index={0}
            label={copy.analytics.transactions}
            metric={headline.transactions}
            display={countValue(headline.transactions)}
            timeframe="24H"
          />
          <MetricTile
            index={1}
            label="Active addresses"
            metric={headline.activeUsers}
            display={countValue(headline.activeUsers)}
            timeframe="24H"
          />
          <MetricTile
            index={2}
            label={copy.tokens.holders}
            metric={headline.holders}
            display={countValue(headline.holders)}
          />
          <MetricTile
            index={3}
            label="Tokens tracked"
            metric={headline.tokensTracked}
            display={countValue(headline.tokensTracked)}
          />
        </MetricRow>

        <MetricRow columns={3} className="mt-3">
          <MetricTile
            index={4}
            label="Pools scanned"
            metric={headline.pools}
            display={countValue(headline.pools)}
          />
          <MetricTile
            index={5}
            label="Pairs created"
            metric={headline.pairsCreated}
            display={countValue(headline.pairsCreated)}
          />
          <MetricTile
            index={6}
            label="Latest block"
            metric={headline.latestBlock}
            display={countValue(headline.latestBlock)}
          />
        </MetricRow>

        <p className="mt-3 text-[11.5px] leading-relaxed text-subtle">
          These count on-chain activity against the Uniswap v2 contracts, not Poolix usage.
          Anyone can trade the same pools through any frontend, and nothing on chain distinguishes
          one interface from another — so <strong className="font-medium text-muted">active
          addresses</strong> is the number of distinct accounts that sent a qualifying transaction,
          not the number of people who used Poolix.
        </p>
      </section>

      {/* ------------------------------------------------------------ rankings */}
      <section className="mt-10">
        <PoolRankings rows={dashboard.poolRows} nativeSymbol={native} />
      </section>

      <section className="mt-10 grid gap-6 lg:grid-cols-[1fr_1.4fr]">
        <LiquidityDistribution result={discovery} />
        <TokenRankings
          rows={dashboard.tokenRows}
          nativeSymbol={native}
          trackedCount={coverage.tokensVerified}
        />
      </section>

      {/* --------------------------------------------------------- methodology */}
      <details className="group mt-10 rounded-poolix-lg border border-line bg-surface/60">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-[13px] text-muted transition-colors hover:text-fg">
          Coverage and methodology — what this page measures, and what it does not
          <ChevronDown
            className="size-4 shrink-0 text-subtle transition-transform duration-200 group-open:rotate-180"
            aria-hidden="true"
          />
        </summary>
        <div className="space-y-3 border-t border-line px-4 py-4 text-[12.5px] leading-relaxed text-muted">
          <Method title="Pool discovery scope">
            The scan covers {coverage.poolsScanned.toLocaleString("en-US")} pools from{" "}
            {coverage.pairsTotal.toLocaleString("en-US")} pairs the factory has created, walking the
            most recently created window first.{" "}
            {coverage.poolScanComplete
              ? "This pass covered the whole space."
              : "It is a window rather than a complete ranking, because the endpoint throttles bulk reads."}{" "}
            Pairs holding less than 0.0001 {native} are left out as untradeable.
          </Method>

          <Method title="Historical coverage">
            Volume and liquidity are stored as hourly buckets over exact clock hours, 168 for 7D and
            720 for 30D. A window missing even one hour has its total withheld rather than shown
            smaller — an hour with no trades and an hour that was never ingested produce the same
            sum, and only one of them is a fact.{" "}
            {coverage.historyBootstrapping ? "The volume series is still bootstrapping. " : ""}
            {coverage.liquidityBuilding ? "The liquidity series is still building. " : ""}
            The 24-hour figures measure a rolling block range instead, which is a different window
            and is never added to the hourly totals.
          </Method>

          <Method title={`${native} denomination`}>
            Volume, fees and liquidity are measured on the {native} side of each pool. That is a
            measurement rather than a valuation, and it is why token-to-token pools carry{" "}
            {copy.data.unavailable} in those columns: pricing them would need a rate for a third
            asset Poolix cannot verify. Such pools are still listed and still counted for
            transactions.
          </Method>

          <Method title="USD pricing">
            {coverage.ethUsdAvailable
              ? `Current TVL prices scanned ${native} liquidity at ${coverage.ethUsdDescription}, read fresh each refresh and rejected if the round is stale or malformed.`
              : "The ETH/USD feed is unavailable or stale, so no USD figure is shown at all."}{" "}
            There is no historical USD series: the feed publishes no usable history on this chain,
            so historical liquidity stays {native}-denominated rather than being priced at
            today&rsquo;s rate, which would misstate every past hour.
          </Method>

          <Method title="Token universe">
            {coverage.tokensVerified} of up to {coverage.tokensLimit} unique non-W{native} tokens
            from the scanned pools are tracked.{" "}
            {coverage.tokenSweepComplete
              ? "The sweep has covered the whole pair space."
              : "The sweep is still widening, so this is the set found so far rather than the deepest tokens on the chain."}{" "}
            It is not every token on {dashboard.chainName}.
          </Method>

          <Method title="Holders">
            Every ERC-20 Transfer of the tracked tokens is replayed to find each address that could
            hold one, then each token contract is asked for{" "}
            <code className="poolix-numeric">balanceOf</code> and only the addresses it reports a
            positive balance for are counted. The contract decides, not the event log — some tokens
            emit Transfers that move no state, and counting events alone reported them as holders.{" "}
            {coverage.holdersComplete
              ? `All ${coverage.holdersTokenCount} tokens are confirmed across ${coverage.holdersCandidates.toLocaleString("en-US")} candidate addresses.`
              : `Currently ${coverage.holdersTokensConfirmed} of ${coverage.holdersTokenCount} tokens are confirmed, so the count reads ${copy.data.unavailable} until every one is.`}{" "}
            {coverage.holdersMismatches > 0
              ? `The replay and the contracts disagreed on ${coverage.holdersMismatches.toLocaleString("en-US")} addresses and the contract was used every time. `
              : ""}
            Contracts count as holders; the zero address does not. An address that holds a token
            without ever appearing in one of its Transfer events cannot be found this way, so this
            is a lower bound.
          </Method>

          <Method title="24-hour activity">
            Transactions counts distinct transaction hashes that emitted a Swap, Mint or Burn, so
            one transaction touching several pairs counts once. Active addresses counts the accounts
            that sent them. Both cover every pair including token-to-token, because counting a
            transaction does not require valuing it — and both describe the contracts, not Poolix.
          </Method>

          <Method title="Per-pool figures">
            The pool table is built from {coverage.rankedPools} pools with their own indexed
            history, summed from each pool&rsquo;s own Swap events and reconstructed from its own
            Sync events, so no pool borrows another&rsquo;s activity. Pool APR uses the same formula
            and the same 0.30% rate as the chain-wide figure above.
          </Method>

          <Method title="Unattributed swaps">
            A swap is only counted once Poolix knows which side of its pair holds {native}. A pair
            first seen part-way through an hour leaves that hour&rsquo;s swaps recorded as
            unattributed rather than counted, so the 24-hour volume is a floor, not a ceiling.{" "}
            {day.unresolvedSwaps > 0
              ? `${day.unresolvedSwaps.toLocaleString("en-US")} swaps are in that state right now.`
              : "No swaps are in that state right now."}{" "}
            They are not discarded and not guessed at; the count is published beside the total so
            the gap is visible rather than absorbed into it.
          </Method>

          <Method title="No invented comparisons">
            No card shows a percentage change. Poolix keeps no previous-period snapshot to compare
            against, so a delta would be fabricated — and a fabricated trend is read as fact more
            readily than a fabricated level.
          </Method>
        </div>
      </details>
    </div>
  );
}

function Method({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[12px] font-medium text-fg">{title}</p>
      <p className="mt-1">{children}</p>
    </div>
  );
}

/** Says why an APR is missing, since "--" alone leaves the reader guessing. */
function aprReason(reason: string): string {
  switch (reason) {
    case "volume-incomplete":
      return "Needs the full fee window";
    case "liquidity-incomplete":
      return "Needs the full liquidity window";
    case "zero-liquidity":
      return "No liquidity to divide by in this window";
    case "no-samples":
      return "No liquidity snapshots in this window";
    default:
      return "Not available for this window";
  }
}
