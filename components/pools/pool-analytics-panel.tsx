"use client";

import { useMemo, useState } from "react";
import { formatUnits } from "viem";

import { Badge } from "@/components/ui/badge";
import { Tabs } from "@/components/ui/tabs";
import { formatNumber, formatTokenAmount } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  groupPoolPoints,
  latestObservedLiquidity,
  maskPreCreation,
  POOL_TIMEFRAME_HOURS,
  type PoolPointLike,
  type PoolTimeframe,
} from "@/services/pools/pool-analytics-math";
import type { PoolAnalyticsView, PoolTimeframeView } from "@/services/pools/pool-analytics-view";

/*
  One pool's history across four windows.

  Every frame is summed from the same hourly buckets, so switching between them changes
  the span and nothing else. A window with a missing hour reports its total as unavailable
  rather than short: an hour that was never ingested and an hour with no trades produce the
  same sum, and only one of those is a fact.

  Liquidity is drawn as a line and volume as bars, because they are different kinds of
  quantity. Liquidity is a level that exists at every instant, so connecting two readings
  asserts something true about the time between them. Volume is a sum over a fixed window,
  so a curve between two buckets would draw trading at moments that were never measured.
*/

const FRAMES = Object.keys(POOL_TIMEFRAME_HOURS) as PoolTimeframe[];

/**
 * Hours per drawn point.
 *
 * 30 days of hours is 720 points, and two charts of 720 focusable elements is a worse
 * chart and a worse keyboard experience than 30 days. Grouping is presentation only —
 * every headline figure above still sums the ungrouped hours.
 */
const HOURS_PER_POINT: Readonly<Record<PoolTimeframe, number>> = {
  "1H": 1,
  "24H": 1,
  "7D": 1,
  "30D": 24,
};

const eth = (wei: string, digits = 4) =>
  formatTokenAmount(formatUnits(BigInt(wei), 18), { maximumFractionDigits: digits });

export interface PoolAnalyticsPanelProps {
  readonly view: PoolAnalyticsView;
  readonly nativeSymbol: string;
  readonly unavailableLabel: string;
}

export function PoolAnalyticsPanel({
  view,
  nativeSymbol,
  unavailableLabel,
}: PoolAnalyticsPanelProps) {
  const [frame, setFrame] = useState<PoolTimeframe>("24H");
  const timeframe = view.timeframes[frame];

  /*
    Hours before the pool existed are dropped from everything that speaks about the pool's
    own liquidity — the headline reading and the chart — but never from the APR
    denominator, which has to keep covering the span it annualizes over. Both rules live
    in the math module, where they are tested.
  */
  const observed = useMemo(
    () => maskPreCreation(timeframe.points, view.creation),
    [timeframe.points, view.creation],
  );
  const liquidityNow = useMemo(() => latestObservedLiquidity(observed), [observed]);
  const drawn = useMemo(
    () => groupPoolPoints(observed, HOURS_PER_POINT[frame]),
    [observed, frame],
  );

  return (
    <section className="rounded-poolix-lg border border-line bg-surface p-4 sm:p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-[11px] font-medium tracking-[0.07em] text-subtle uppercase">
            Pool volume
          </p>
          <p className="poolix-numeric mt-2 text-[26px] leading-none text-fg">
            {timeframe.volumeComplete
              ? `${eth(timeframe.volumeWei, 4)} ${nativeSymbol}`
              : unavailableLabel}
          </p>
          <p className="mt-2 text-[12px] leading-snug text-subtle">{coverageHint(timeframe)}</p>
        </div>

        <Tabs
          label="Pool analytics timeframe"
          value={frame}
          onChange={setFrame}
          items={FRAMES.map((value) => ({ value, label: value }))}
        />
      </div>

      {timeframe.partialByCreation ? (
        <p className="mt-3 rounded-poolix border border-line bg-raised px-3 py-2 text-[12px] leading-relaxed text-muted">
          This pool is younger than the {frame} window. The hours before it existed hold nothing
          to measure — they are not missing data, and they are not padded with zeros. Rates
          derived from a window longer than the pool&rsquo;s life are dominated by the short
          period it was actually trading.
        </p>
      ) : null}

      <dl className="mt-4 grid grid-cols-2 gap-x-3 gap-y-4 border-t border-line pt-4 sm:grid-cols-3">
        <Figure
          label={`Fees (${nativeSymbol})`}
          value={timeframe.volumeComplete ? eth(timeframe.feesWei, 6) : unavailableLabel}
          note={timeframe.volumeComplete ? "0.30% of this pool's volume" : "Needs the full window"}
        />
        <Figure
          label={`Liquidity (${nativeSymbol})`}
          value={liquidityNow === null ? unavailableLabel : eth(liquidityNow, 4)}
          note={
            liquidityNow === null
              ? timeframe.partialByCreation
                ? "This window closed before the pool existed"
                : "No reserve observed in this window"
              : "Latest hour, reconstructed from Sync events"
          }
        />
        <Figure
          label={`Avg liquidity (${nativeSymbol})`}
          value={timeframe.twalWei === null ? unavailableLabel : eth(timeframe.twalWei, 4)}
          note={
            timeframe.twalWei === null
              ? "No liquidity snapshots in this window"
              : timeframe.partialByCreation
                ? // Said plainly, because this is the APR denominator: the average covers
                  // the whole window, including the hours before the pool was deployed.
                  "Time-weighted across the window, including hours before the pool existed"
                : "Time-weighted across the window"
          }
        />
        <Figure
          label="Historical fee APR"
          value={timeframe.aprDisplay ?? unavailableLabel}
          note={aprNote(timeframe)}
        />
        <Figure
          label="Swaps"
          value={
            timeframe.volumeComplete
              ? formatNumber(timeframe.swaps, { maximumFractionDigits: 0 })
              : unavailableLabel
          }
          note={timeframe.volumeComplete ? "Uniswap v2 Swap events" : "Needs the full window"}
        />
        <Figure
          label="Transactions"
          value={
            timeframe.volumeComplete
              ? formatNumber(timeframe.transactions, { maximumFractionDigits: 0 })
              : unavailableLabel
          }
          note={
            timeframe.volumeComplete
              ? "Distinct hashes touching this pool"
              : "Needs the full window"
          }
        />
      </dl>

      <p className="mt-3 text-[11.5px] leading-relaxed text-subtle">
        Historical fee APR is this pool&rsquo;s own fee revenue over the selected window,
        annualized and divided by its own time-weighted average {nativeSymbol} liquidity. It is
        a measurement of what already happened — not a projection, not compounded, and it does
        not account for impermanent loss or token price changes. A new pool with little
        liquidity can produce a very large figure from a small amount of trading; that is the
        arithmetic being reported honestly, not a yield on offer.
      </p>

      <div className="mt-5 space-y-5">
        <Chart
          title={`Volume (${nativeSymbol})`}
          points={drawn}
          frame={frame}
          nativeSymbol={nativeSymbol}
          kind="volume"
        />
        <Chart
          title={`Liquidity (${nativeSymbol})`}
          points={drawn}
          frame={frame}
          nativeSymbol={nativeSymbol}
          kind="liquidity"
        />
      </div>
    </section>
  );
}

function coverageHint(view: PoolTimeframeView): string {
  if (view.volumeComplete) {
    return `${view.swaps.toLocaleString("en-US")} swaps across ${view.bucketsExpected} hourly buckets`;
  }
  const pct = Math.round((view.bucketsPresent / Math.max(1, view.bucketsExpected)) * 100);
  return `Window incomplete: ${view.bucketsPresent} of ${view.bucketsExpected} hours ingested (${pct}%). The total is withheld until every hour is present.`;
}

/** Says why an APR is missing, since "--" alone leaves the reader guessing. */
function aprNote(view: PoolTimeframeView): string {
  switch (view.aprReason) {
    case "ok":
      return "Annualized from this window, not a projection";
    case "volume-incomplete":
      return "Needs the full fee window";
    case "liquidity-incomplete":
      return `Needs every hour: ${view.liquidityPoints} of ${view.bucketsExpected} observed`;
    case "zero-liquidity":
      return "No liquidity to divide by in this window";
    case "no-samples":
      return "No liquidity snapshots in this window";
    default:
      return "Not available for this window";
  }
}

function Figure({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-medium tracking-[0.07em] text-subtle uppercase">{label}</dt>
      <dd className="poolix-numeric mt-1.5 truncate text-[15px] text-fg">{value}</dd>
      <p className="mt-1 text-[11.5px] leading-snug text-subtle">{note}</p>
    </div>
  );
}

// ------------------------------------------------------------------------ charts

interface ChartProps {
  readonly title: string;
  readonly points: readonly PoolPointLike[];
  readonly frame: PoolTimeframe;
  readonly nativeSymbol: string;
  readonly kind: "volume" | "liquidity";
}

function Chart({ title, points, frame, nativeSymbol, kind }: ChartProps) {
  const [active, setActive] = useState<number | null>(null);
  const selected = active === null ? null : (points[active] ?? null);

  const hasData = useMemo(
    () =>
      kind === "volume"
        ? points.some((point) => BigInt(point.volumeWei) > 0n)
        : points.some((point) => point.liquidityWei !== null),
    [points, kind],
  );

  return (
    <div>
      <p className="mb-2 text-[11px] font-medium tracking-[0.07em] text-subtle uppercase">
        {title}
      </p>

      {points.length === 0 || !hasData ? (
        <p className="rounded-poolix border border-line bg-raised px-4 py-8 text-center text-[12.5px] leading-relaxed text-subtle">
          {kind === "volume"
            ? "No trades in this window."
            : "No reserve was observed for this pool in this window."}
        </p>
      ) : kind === "volume" ? (
        <VolumeBars
          points={points}
          frame={frame}
          nativeSymbol={nativeSymbol}
          onActive={setActive}
        />
      ) : (
        <LiquidityLine
          points={points}
          frame={frame}
          nativeSymbol={nativeSymbol}
          onActive={setActive}
        />
      )}

      {points.length > 0 && hasData ? (
        <>
          <div className="mt-2 flex items-center justify-between text-[11px] text-subtle">
            <span>{points[0] ? labelFor(points[0], frame, true) : ""}</span>
            <span>
              {points.length > 0 ? labelFor(points[points.length - 1]!, frame, true) : ""}
            </span>
          </div>

          <div className="mt-2 min-h-[40px] rounded-poolix border border-line bg-raised px-3 py-2">
            {selected === null ? (
              <p className="text-[12px] text-subtle">Hover or focus a point for its exact value.</p>
            ) : (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
                <span className="text-muted">{labelFor(selected, frame, true)}</span>
                {kind === "volume" ? (
                  <>
                    <span className="poolix-numeric text-fg">
                      {eth(selected.volumeWei, 6)} {nativeSymbol}
                    </span>
                    <span className="poolix-numeric text-subtle">
                      {selected.swaps.toLocaleString("en-US")} swaps
                    </span>
                  </>
                ) : selected.liquidityWei === null ? (
                  <Badge tone="warning" size="sm">
                    Not observed
                  </Badge>
                ) : (
                  <span className="poolix-numeric text-fg">
                    {eth(selected.liquidityWei, 6)} {nativeSymbol}
                  </span>
                )}
              </div>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}

interface SeriesProps {
  readonly points: readonly PoolPointLike[];
  readonly frame: PoolTimeframe;
  readonly nativeSymbol: string;
  readonly onActive: (index: number | null) => void;
}

function VolumeBars({ points, frame, nativeSymbol, onActive }: SeriesProps) {
  const max = useMemo(
    () =>
      points.reduce(
        (peak, point) => (BigInt(point.volumeWei) > peak ? BigInt(point.volumeWei) : peak),
        1n,
      ),
    [points],
  );

  return (
    <div
      className="flex h-[120px] items-end gap-px"
      role="img"
      aria-label={`Pool volume over ${frame}, ${points.length} hourly buckets`}
    >
      {points.map((point, index) => {
        // Integer maths for the ratio: the bar height is presentation, but the number
        // behind it stays exact until the last possible moment.
        const height = Number((BigInt(point.volumeWei) * 1000n) / max) / 10;
        return (
          <button
            key={point.startTimestamp}
            type="button"
            onMouseEnter={() => onActive(index)}
            onMouseLeave={() => onActive(null)}
            onFocus={() => onActive(index)}
            onBlur={() => onActive(null)}
            aria-label={`${labelFor(point, frame, true)}: ${eth(point.volumeWei, 6)} ${nativeSymbol}`}
            className="group relative flex h-full flex-1 items-end"
          >
            <span
              className="w-full rounded-t-[2px] bg-accent/35 transition-colors group-hover:bg-accent/70 group-focus-visible:bg-accent/70"
              style={{ height: `${Math.max(height, 1.5)}%` }}
            />
          </button>
        );
      })}
    </div>
  );
}

/**
 * Liquidity as a line, with unobserved hours left as gaps rather than bridged.
 *
 * A gap is the whole point: drawing straight through an hour with no reading would invent
 * a level the chain never reported. The line restarts on the far side instead.
 */
function LiquidityLine({ points, frame, nativeSymbol, onActive }: SeriesProps) {
  const { segments, max } = useMemo(() => {
    let peak = 1n;
    for (const point of points) {
      if (point.liquidityWei === null) continue;
      const value = BigInt(point.liquidityWei);
      if (value > peak) peak = value;
    }

    const runs: { x: number; y: number }[][] = [];
    let current: { x: number; y: number }[] = [];
    const span = Math.max(1, points.length - 1);

    points.forEach((point, index) => {
      if (point.liquidityWei === null) {
        if (current.length > 0) runs.push(current);
        current = [];
        return;
      }
      const ratio = Number((BigInt(point.liquidityWei) * 10_000n) / peak) / 10_000;
      current.push({ x: (index / span) * 100, y: 100 - ratio * 100 });
    });
    if (current.length > 0) runs.push(current);

    return { segments: runs, max: peak };
  }, [points]);

  return (
    <div className="relative h-[120px]">
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        className="absolute inset-0 size-full"
        role="img"
        aria-label={`Pool liquidity over ${frame}, peaking at ${eth(max.toString(), 4)} ${nativeSymbol}`}
      >
        {segments.map((segment) => (
          <g key={`${segment[0]?.x ?? 0}-${segment.length}`}>
            {segment.length === 1 ? (
              <circle
                cx={segment[0]?.x ?? 0}
                cy={segment[0]?.y ?? 0}
                r={0.8}
                className="fill-accent"
                vectorEffect="non-scaling-stroke"
              />
            ) : (
              <polyline
                points={segment.map((p) => `${p.x},${p.y}`).join(" ")}
                fill="none"
                strokeWidth={1.5}
                vectorEffect="non-scaling-stroke"
                className="stroke-accent"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            )}
          </g>
        ))}
      </svg>

      {/* An invisible strip per hour, so the same hover and keyboard target exists for a
          line chart as for the bars. The line itself is too thin to aim at. */}
      <div className="absolute inset-0 flex">
        {points.map((point, index) => (
          <button
            key={point.startTimestamp}
            type="button"
            onMouseEnter={() => onActive(index)}
            onMouseLeave={() => onActive(null)}
            onFocus={() => onActive(index)}
            onBlur={() => onActive(null)}
            aria-label={`${labelFor(point, frame, true)}: ${
              point.liquidityWei === null
                ? "not observed"
                : `${eth(point.liquidityWei, 6)} ${nativeSymbol}`
            }`}
            className={cn(
              "h-full flex-1 rounded-[2px] transition-colors",
              "hover:bg-accent/10 focus-visible:bg-accent/10 focus-visible:outline-none",
            )}
          />
        ))}
      </div>
    </div>
  );
}

function labelFor(point: PoolPointLike, frame: PoolTimeframe, long = false): string {
  const date = new Date(point.startTimestamp * 1000);
  const day = date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  // A 30D point covers a whole day, so naming its first hour would be a narrower claim
  // than the point actually makes.
  if (HOURS_PER_POINT[frame] >= 24) return day;

  const time = `${String(date.getUTCHours()).padStart(2, "0")}:00`;
  return long ? `${day} ${time} UTC` : time;
}
