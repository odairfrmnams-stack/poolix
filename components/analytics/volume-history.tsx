"use client";

import { useMemo, useState } from "react";
import { formatUnits } from "viem";

import { Badge } from "@/components/ui/badge";
import { Tabs } from "@/components/ui/tabs";
import { formatTokenAmount } from "@/lib/format";
import { cn } from "@/lib/utils";

/*
  Trading volume across three timeframes.

  24H is deliberately not charted. Its headline comes from the existing rolling window,
  which measures 864,000 blocks rather than 24 exact hours, so a chart drawn from the
  hourly historical buckets would sum to a slightly different number sitting right beside
  it — a discrepancy that looks like a bug and would be one to explain away rather than
  fix. The two measurements stay in their own lanes.

  7D and 30D are charted from the historical buckets themselves. A point whose hours are
  not all ingested is drawn hollow rather than short: a partially filled day is not a low
  day, and the difference has to be visible.
*/

export interface HistoryPointView {
  readonly startTimestamp: number;
  readonly endTimestamp: number;
  /** Decimal wei string: bigint cannot cross the server/client boundary. */
  readonly volumeWei: string;
  readonly swaps: number;
  readonly complete: boolean;
}

export interface LiquidityView {
  readonly latestWei: string;
  readonly minWei: string;
  readonly maxWei: string;
  readonly bucketsPresent: number;
  readonly bucketsExpected: number;
  readonly complete: boolean;
}

export interface AprView {
  /** Already formatted, or null when it cannot be computed. */
  readonly display: string | null;
  /** Scope-matched fees over the same pools as the liquidity denominator. */
  readonly scopedFeesWei: string;
  readonly twalWei: string | null;
  readonly reason: string;
}

export interface TimeframeView {
  readonly volumeWei: string;
  readonly feesWei: string;
  readonly swaps: number;
  readonly bucketsPresent: number;
  readonly bucketsExpected: number;
  readonly complete: boolean;
  readonly points: readonly HistoryPointView[];
  readonly liquidity: LiquidityView;
  readonly apr: AprView;
}

export interface VolumeHistoryProps {
  readonly nativeSymbol: string;
  /** The existing rolling figure. Passed through untouched. */
  readonly day: { readonly volumeWei: string; readonly available: boolean; readonly hint: string };
  readonly week: TimeframeView;
  readonly month: TimeframeView;
  readonly bootstrapping: boolean;
  readonly unavailableLabel: string;
}

type Frame = "24H" | "7D" | "30D";

const eth = (wei: string, digits = 2) =>
  formatTokenAmount(formatUnits(BigInt(wei), 18), { maximumFractionDigits: digits });

export function VolumeHistory({
  nativeSymbol,
  day,
  week,
  month,
  bootstrapping,
  unavailableLabel,
}: VolumeHistoryProps) {
  const [frame, setFrame] = useState<Frame>("24H");

  const view = frame === "7D" ? week : frame === "30D" ? month : null;

  const headline = useMemo(() => {
    if (frame === "24H") return day.available ? `${eth(day.volumeWei)} ${nativeSymbol}` : unavailableLabel;
    if (view === null) return unavailableLabel;
    // A window with holes has a real sum, but it is not the window's volume — so it is
    // withheld rather than presented as one.
    return view.complete ? `${eth(view.volumeWei)} ${nativeSymbol}` : unavailableLabel;
  }, [frame, day, view, nativeSymbol, unavailableLabel]);

  return (
    <section className="rounded-poolix-lg border border-line bg-surface p-4 sm:p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-[11px] font-medium tracking-[0.07em] text-subtle uppercase">
            Trading volume
          </p>
          <p className="poolix-numeric mt-2 text-[26px] leading-none text-fg">{headline}</p>
          <p className="mt-2 text-[12px] leading-snug text-subtle">
            {frame === "24H" ? day.hint : coverageHint(view, frame)}
          </p>
        </div>

        <Tabs
          label="Volume timeframe"
          value={frame}
          onChange={setFrame}
          items={[{ value: "24H" }, { value: "7D" }, { value: "30D" }].map((item) => ({
            value: item.value as Frame,
            label: item.value,
          }))}
        />
      </div>

      {/* Fees and liquidity sit beside the volume headline for the historical frames.
          Each is withheld on its own terms: fees follow volume's coverage, liquidity
          follows its own, because the two are built from different event streams and one
          can be complete while the other is not. */}
      {view !== null ? (
        <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-line pt-4 sm:grid-cols-3">
          <Figure
            label={`Fees (${nativeSymbol})`}
            value={view.complete ? eth(view.feesWei, 4) : unavailableLabel}
            note={view.complete ? "0.30% of swap volume" : "Needs the full window"}
          />
          <Figure
            label={`Liquidity now (${nativeSymbol})`}
            value={view.liquidity.complete ? eth(view.liquidity.latestWei, 2) : unavailableLabel}
            note={
              view.liquidity.complete
                ? "Reconstructed from Sync events"
                : `Rebuilding: ${view.liquidity.bucketsPresent} of ${view.liquidity.bucketsExpected} hours`
            }
          />
          <Figure
            label={`Liquidity range (${nativeSymbol})`}
            value={
              view.liquidity.complete
                ? `${eth(view.liquidity.minWei, 2)} – ${eth(view.liquidity.maxWei, 2)}`
                : unavailableLabel
            }
            note={view.liquidity.complete ? "Low to high across the window" : "Needs the full window"}
          />
          {/* APR sits in the same row at the same weight as the figures it is derived
              from, rather than as a headline — it is the most easily misread number here
              and should not be the first thing the eye lands on. */}
          <Figure
            label="Historical fee APR"
            value={view.apr.display ?? unavailableLabel}
            note={aprNote(view.apr)}
          />
          <Figure
            label={`Fees, scanned pools (${nativeSymbol})`}
            value={
              view.apr.display !== null ? eth(view.apr.scopedFeesWei, 4) : unavailableLabel
            }
            note="The APR numerator: same pools as the liquidity"
          />
        </dl>
      ) : null}

      {view !== null ? (
        <p className="mt-3 text-[11.5px] leading-relaxed text-subtle">
          Historical fee APR is fee revenue from the selected period, annualized and divided by
          time-weighted average {nativeSymbol} liquidity. It is a measurement of what already
          happened — not a projection, not compounded, and it does not account for impermanent
          loss or token price changes. Fee revenue is derived from Uniswap v2 Swap volume at the
          protocol&rsquo;s 0.30% rate. Numerator and denominator both cover Poolix&rsquo;s scanned
          pools only, so this is the APR of those pools rather than of {" "}
          {/* The chain-wide volume shown above deliberately does not feed this. */}
          the whole chain.
        </p>
      ) : null}

      <div className="mt-5">
        {frame === "24H" ? (
          <p className="rounded-poolix border border-line bg-raised px-4 py-6 text-center text-[12.5px] leading-relaxed text-subtle">
            The 24-hour figure is the rolling window Poolix already measures, over a block
            range rather than exact clock hours. Historical buckets start at 7D.
          </p>
        ) : view === null || view.points.length === 0 ? (
          <EmptyState bootstrapping={bootstrapping} view={view} />
        ) : (
          <VolumeChart points={view.points} nativeSymbol={nativeSymbol} frame={frame} />
        )}
      </div>
    </section>
  );
}

/** Says why an APR is missing, since "--" alone leaves the reader guessing. */
function aprNote(apr: AprView): string {
  switch (apr.reason) {
    case "ok":
      return "Annualized from this window, not a projection";
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

function Figure({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-medium tracking-[0.07em] text-subtle uppercase">{label}</dt>
      <dd className="poolix-numeric mt-1.5 truncate text-[15px] text-fg">{value}</dd>
      <p className="mt-1 text-[11.5px] leading-snug text-subtle">{note}</p>
    </div>
  );
}

function coverageHint(view: TimeframeView | null, frame: Frame): string {
  if (view === null) return "";
  if (view.complete) {
    return `${view.swaps.toLocaleString("en-US")} swaps across ${view.bucketsExpected} hourly buckets`;
  }
  const pct = Math.round((view.bucketsPresent / Math.max(1, view.bucketsExpected)) * 100);
  return `Window incomplete: ${view.bucketsPresent} of ${view.bucketsExpected} hours ingested (${pct}%). The ${frame} total is withheld until every hour is present.`;
}

function EmptyState({ bootstrapping, view }: { bootstrapping: boolean; view: TimeframeView | null }) {
  const message =
    view === null
      ? "Historical data is not available yet."
      : bootstrapping
        ? "Building historical data..."
        : "Historical data is not available yet.";

  return (
    <div className="rounded-poolix border border-line bg-raised px-4 py-10 text-center">
      <p className="text-[13px] text-fg">{message}</p>
      {view !== null ? (
        <p className="mx-auto mt-1.5 max-w-sm text-[12px] leading-relaxed text-subtle">
          {view.bucketsPresent} of {view.bucketsExpected} hourly buckets ingested so far. Missing
          hours are never filled in as zero, so the chart appears once there is something real to
          draw.
        </p>
      ) : null}
    </div>
  );
}

/**
 * A bar per bucket, scaled to the largest one.
 *
 * Bars rather than a smoothed line: the values are discrete sums over fixed windows, and
 * a curve between them would draw volume at instants that were never measured.
 */
function VolumeChart({
  points,
  nativeSymbol,
  frame,
}: {
  points: readonly HistoryPointView[];
  nativeSymbol: string;
  frame: Frame;
}) {
  const [active, setActive] = useState<number | null>(null);

  const max = useMemo(
    () => points.reduce((peak, point) => (BigInt(point.volumeWei) > peak ? BigInt(point.volumeWei) : peak), 1n),
    [points],
  );

  const selected = active === null ? null : points[active] ?? null;

  return (
    <div>
      <div
        className="flex h-[140px] items-end gap-px"
        role="img"
        aria-label={`Trading volume over ${frame}, ${points.length} buckets`}
      >
        {points.map((point, index) => {
          // Integer maths for the ratio: the bar height is presentation, but the number
          // behind it stays exact until the last possible moment.
          const height = Number((BigInt(point.volumeWei) * 1000n) / max) / 10;
          return (
            <button
              key={point.startTimestamp}
              type="button"
              onMouseEnter={() => setActive(index)}
              onMouseLeave={() => setActive(null)}
              onFocus={() => setActive(index)}
              onBlur={() => setActive(null)}
              aria-label={`${labelFor(point, frame)}: ${eth(point.volumeWei, 4)} ${nativeSymbol}`}
              className="group relative flex h-full flex-1 items-end"
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

      {/* The ends of the axis carry the date as well as the hour: "16" alone tells you
          nothing about which day you are looking at. */}
      <div className="mt-2 flex items-center justify-between text-[11px] text-subtle">
        <span>{points[0] ? labelFor(points[0], frame, true) : ""}</span>
        <span>{points[points.length - 1] ? labelFor(points[points.length - 1]!, frame, true) : ""}</span>
      </div>

      <div className="mt-3 min-h-[44px] rounded-poolix border border-line bg-raised px-3 py-2">
        {selected === null ? (
          <p className="text-[12px] text-subtle">Hover or focus a bar for its exact total.</p>
        ) : (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
            <span className="text-muted">{labelFor(selected, frame, true)}</span>
            <span className="poolix-numeric text-fg">
              {eth(selected.volumeWei, 4)} {nativeSymbol}
            </span>
            <span className="poolix-numeric text-subtle">
              {selected.swaps.toLocaleString("en-US")} swaps
            </span>
            {!selected.complete ? (
              <Badge tone="warning" size="sm">
                Partial
              </Badge>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

function labelFor(point: HistoryPointView, frame: Frame, long = false): string {
  const date = new Date(point.startTimestamp * 1000);
  if (frame === "30D") {
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  }
  const time = `${String(date.getUTCHours()).padStart(2, "0")}:00`;
  if (!long) return time;
  return `${date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })} ${time} UTC`;
}
