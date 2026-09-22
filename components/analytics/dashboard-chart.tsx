"use client";

import { useMemo, useState } from "react";
import { formatUnits } from "viem";

import { Badge } from "@/components/ui/badge";
import { Tabs } from "@/components/ui/tabs";
import { formatTokenAmount } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { HistoryTimeframe } from "@/services/analytics/history-math";
import type { SeriesPointView, TimeframeView } from "@/services/analytics/dashboard-view";

/*
  The dashboard's main historical chart.

  Volume and fees are sums over a fixed hour, so they are drawn as bars: a curve between
  two buckets would draw trading at instants that were never measured. Liquidity is a level
  that exists continuously, so it is drawn as a line — and an hour with no reading leaves a
  GAP rather than being bridged, because joining across it would assert a level the chain
  never reported.

  30D is grouped into days for legibility. Grouping is presentation only: volume and fees
  add, liquidity takes each group's closing reading rather than an average, and the totals
  above the chart still come from the ungrouped hours the server sent.
*/

type Series = "volume" | "liquidity" | "fees";

const SERIES_LABEL: Readonly<Record<Series, string>> = {
  volume: "Volume",
  liquidity: "Liquidity",
  fees: "Fees",
};

/** Hours per drawn point. 720 focusable bars is a worse chart than 30. */
const HOURS_PER_POINT: Readonly<Record<HistoryTimeframe, number>> = { "7D": 1, "30D": 24 };

const eth = (wei: string, digits = 4) =>
  formatTokenAmount(formatUnits(BigInt(wei), 18), { maximumFractionDigits: digits });

/**
 * Collapses hourly points for drawing.
 *
 * Sums add; a level takes the group's LAST observed reading, never an average, which would
 * report a level that never held. A group with no reading at all stays null so the gap
 * survives grouping instead of being smoothed over by its neighbours.
 */
function groupPoints(points: readonly SeriesPointView[], perGroup: number): SeriesPointView[] {
  if (perGroup <= 1) return [...points];

  const grouped: SeriesPointView[] = [];
  for (let index = 0; index < points.length; index += perGroup) {
    const slice = points.slice(index, index + perGroup);
    const first = slice[0];
    if (first === undefined) continue;

    let volumeWei = 0n;
    let feesWei = 0n;
    let swaps = 0;
    let liquidityWei: string | null = null;
    let complete = true;

    for (const point of slice) {
      volumeWei += BigInt(point.volumeWei);
      feesWei += BigInt(point.feesWei);
      swaps += point.swaps;
      if (point.liquidityWei !== null) liquidityWei = point.liquidityWei;
      if (!point.complete) complete = false;
    }

    grouped.push({
      startTimestamp: first.startTimestamp,
      volumeWei: volumeWei.toString(),
      feesWei: feesWei.toString(),
      liquidityWei,
      swaps,
      complete,
    });
  }
  return grouped;
}

const valueOf = (point: SeriesPointView, series: Series): string | null =>
  series === "volume" ? point.volumeWei : series === "fees" ? point.feesWei : point.liquidityWei;

export interface DashboardChartProps {
  readonly week: TimeframeView;
  readonly month: TimeframeView;
  readonly nativeSymbol: string;
  readonly unavailableLabel: string;
}

export function DashboardChart({
  week,
  month,
  nativeSymbol,
  unavailableLabel,
}: DashboardChartProps) {
  const [frame, setFrame] = useState<HistoryTimeframe>("7D");
  const [series, setSeries] = useState<Series>("volume");
  const [active, setActive] = useState<number | null>(null);

  const view = frame === "7D" ? week : month;
  const points = useMemo(
    () => groupPoints(view.points, HOURS_PER_POINT[frame]),
    [view.points, frame],
  );

  const headline = useMemo(() => {
    if (series === "volume") return view.volumeWei === null ? null : eth(view.volumeWei, 4);
    if (series === "fees") return view.feesWei === null ? null : eth(view.feesWei, 6);
    return view.liquidityLatestWei === null ? null : eth(view.liquidityLatestWei, 4);
  }, [series, view]);

  const hasData = useMemo(
    () =>
      series === "liquidity"
        ? points.some((point) => point.liquidityWei !== null)
        : points.some((point) => BigInt(valueOf(point, series) ?? "0") > 0n),
    [points, series],
  );

  const selected = active === null ? null : (points[active] ?? null);

  return (
    <section className="rounded-poolix-lg border border-line bg-surface p-4 sm:p-5">
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <p className="text-[11px] font-medium uppercase tracking-[0.07em] text-subtle">
              {SERIES_LABEL[series]} · {frame}
            </p>
            <p className="poolix-numeric mt-2 text-[26px] leading-none text-fg">
              {headline === null ? (
                <span className="text-subtle">{unavailableLabel}</span>
              ) : (
                `${headline} ${nativeSymbol}`
              )}
            </p>
            <p className="mt-2 text-[12px] leading-snug text-subtle">{subtitle(view, series, frame)}</p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Tabs
              label="Chart series"
              value={series}
              onChange={setSeries}
              items={(["volume", "liquidity", "fees"] as const).map((value) => ({
                value,
                label: SERIES_LABEL[value],
              }))}
            />
            <Tabs
              label="Chart timeframe"
              value={frame}
              onChange={setFrame}
              items={(["7D", "30D"] as const).map((value) => ({ value, label: value }))}
            />
          </div>
        </div>

        <div>
          {points.length === 0 || !hasData ? (
            <p className="rounded-poolix border border-line bg-raised px-4 py-12 text-center text-[12.5px] leading-relaxed text-subtle">
              {series === "liquidity"
                ? "No reserve was observed in this window."
                : "No trades in this window."}
            </p>
          ) : series === "liquidity" ? (
            <LiquidityLine points={points} onActive={setActive} label={`Liquidity over ${frame}`} />
          ) : (
            <Bars points={points} series={series} onActive={setActive} label={`${SERIES_LABEL[series]} over ${frame}`} />
          )}

          {points.length > 0 && hasData ? (
            <>
              <div className="mt-2 flex items-center justify-between text-[11px] text-subtle">
                <span>{points[0] ? labelFor(points[0], frame) : ""}</span>
                <span>{labelFor(points[points.length - 1]!, frame)}</span>
              </div>

              <div className="mt-3 min-h-[44px] rounded-poolix border border-line bg-raised px-3 py-2">
                {selected === null ? (
                  <p className="text-[12px] text-subtle">
                    Hover or focus a point for its exact value.
                  </p>
                ) : (
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
                    <span className="text-muted">{labelFor(selected, frame)}</span>
                    {valueOf(selected, series) === null ? (
                      <Badge tone="warning" size="sm">
                        Not observed
                      </Badge>
                    ) : (
                      <span className="poolix-numeric text-fg">
                        {eth(valueOf(selected, series)!, 6)} {nativeSymbol}
                      </span>
                    )}
                    {series === "volume" ? (
                      <span className="poolix-numeric text-subtle">
                        {selected.swaps.toLocaleString("en-US")} swaps
                      </span>
                    ) : null}
                    {!selected.complete ? (
                      <Badge tone="warning" size="sm">
                        Partial
                      </Badge>
                    ) : null}
                  </div>
                )}
              </div>
            </>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function subtitle(view: TimeframeView, series: Series, frame: HistoryTimeframe): string {
  if (series === "liquidity") {
    return view.liquidityComplete
      ? `Latest hour in the window, reconstructed from Sync events · ${frame} range ${view.liquidityMinWei === null ? "--" : eth(view.liquidityMinWei, 2)} – ${view.liquidityMaxWei === null ? "--" : eth(view.liquidityMaxWei, 2)}`
      : "Liquidity window incomplete — the figure is withheld until every hour is present";
  }
  if (view.complete) {
    return `${view.swaps.toLocaleString("en-US")} swaps across ${view.bucketsExpected} hourly buckets`;
  }
  const pct = Math.round((view.bucketsPresent / Math.max(1, view.bucketsExpected)) * 100);
  return `Window incomplete: ${view.bucketsPresent} of ${view.bucketsExpected} hours ingested (${pct}%). The total is withheld until every hour is present.`;
}

function Bars({
  points,
  series,
  onActive,
  label,
}: {
  points: readonly SeriesPointView[];
  series: Series;
  onActive: (index: number | null) => void;
  label: string;
}) {
  const max = useMemo(
    () =>
      points.reduce((peak, point) => {
        const value = BigInt(valueOf(point, series) ?? "0");
        return value > peak ? value : peak;
      }, 1n),
    [points, series],
  );

  return (
    <div className="flex h-[180px] items-end gap-px" role="img" aria-label={label}>
      {points.map((point, index) => {
        // Integer maths for the ratio: the bar height is presentation, but the number
        // behind it stays exact until the last possible moment.
        const value = BigInt(valueOf(point, series) ?? "0");
        const height = Number((value * 1000n) / max) / 10;
        return (
          <button
            key={point.startTimestamp}
            type="button"
            onMouseEnter={() => onActive(index)}
            onMouseLeave={() => onActive(null)}
            onFocus={() => onActive(index)}
            onBlur={() => onActive(null)}
            aria-label={`${new Date(point.startTimestamp * 1000).toISOString()}: ${eth(valueOf(point, series) ?? "0", 6)}`}
            className="group relative flex h-full flex-1 items-end focus-visible:outline-none"
          >
            <span
              className={cn(
                "w-full rounded-t-[2px] transition-colors",
                point.complete
                  ? "bg-accent/35 group-hover:bg-accent/70 group-focus-visible:bg-accent/70"
                  : // Hollow: the hours behind this point are not all ingested.
                    "border border-dashed border-accent/40 bg-transparent",
              )}
              style={{ height: `${Math.max(height, point.complete ? 1.5 : 6)}%` }}
            />
          </button>
        );
      })}
    </div>
  );
}

/** Liquidity as a line, with unobserved hours left as gaps rather than bridged. */
function LiquidityLine({
  points,
  onActive,
  label,
}: {
  points: readonly SeriesPointView[];
  onActive: (index: number | null) => void;
  label: string;
}) {
  const segments = useMemo(() => {
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
    return runs;
  }, [points]);

  return (
    <div className="relative h-[180px]">
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        className="absolute inset-0 size-full"
        role="img"
        aria-label={label}
      >
        {segments.map((segment) => (
          <g key={`${segment[0]?.x ?? 0}-${segment.length}`}>
            {segment.length === 1 ? (
              <circle cx={segment[0]?.x ?? 0} cy={segment[0]?.y ?? 0} r={0.8} className="fill-accent" />
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

      {/* An invisible strip per point: the line itself is too thin to aim at, and this
          gives a line chart the same keyboard target a bar chart has. */}
      <div className="absolute inset-0 flex">
        {points.map((point, index) => (
          <button
            key={point.startTimestamp}
            type="button"
            onMouseEnter={() => onActive(index)}
            onMouseLeave={() => onActive(null)}
            onFocus={() => onActive(index)}
            onBlur={() => onActive(null)}
            aria-label={`${new Date(point.startTimestamp * 1000).toISOString()}: ${
              point.liquidityWei === null ? "not observed" : eth(point.liquidityWei, 6)
            }`}
            className="h-full flex-1 rounded-[2px] transition-colors hover:bg-accent/10 focus-visible:bg-accent/10 focus-visible:outline-none"
          />
        ))}
      </div>
    </div>
  );
}

function labelFor(point: SeriesPointView, frame: HistoryTimeframe): string {
  const date = new Date(point.startTimestamp * 1000);
  const day = date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  // A 30D point covers a whole day, so naming its first hour would claim more than it holds.
  if (HOURS_PER_POINT[frame] >= 24) return day;
  return `${day} ${String(date.getUTCHours()).padStart(2, "0")}:00 UTC`;
}
