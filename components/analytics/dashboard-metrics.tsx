"use client";

import { motion, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";

import { InfoTip } from "@/components/ui/info-tip";
import { cn } from "@/lib/utils";
import type { MetricKind, MetricView } from "@/services/analytics/dashboard-view";

/*
  The dashboard's headline figures.

  Every card renders from a MetricView, which already decided on the server whether the
  figure exists. A missing value shows "--" with the reason underneath rather than a zero,
  and no card carries a percentage change: Poolix stores no previous-period snapshot, so a
  delta would have to be invented, and an invented delta is the most confidently wrong
  thing a dashboard can display.

  Cards enter with a short stagger and nothing else moves. The one piece of motion that
  carries meaning is the value itself changing between refreshes.
*/

/** What kind of claim a figure is, said in the shortest honest words. */
const KIND_LABEL: Readonly<Record<MetricKind, string>> = {
  snapshot: "Now",
  "historical-aggregate": "Summed",
  "time-weighted": "Time-weighted",
};

export interface MetricTileProps {
  readonly label: string;
  readonly metric: MetricView;
  /** The formatted figure. Ignored when the metric is unavailable. */
  readonly display: string;
  readonly unit?: string;
  readonly timeframe?: string;
  readonly tip?: { readonly label: string; readonly body: string };
  readonly index?: number;
  readonly emphasis?: boolean;
}

export function MetricTile({
  label,
  metric,
  display,
  unit,
  timeframe,
  tip,
  index = 0,
  emphasis = false,
}: MetricTileProps) {
  const reduceMotion = useReducedMotion();
  const missing = metric.value === null;

  return (
    <motion.div
      initial={reduceMotion ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.28, delay: reduceMotion ? 0 : Math.min(index, 8) * 0.035, ease: [0.16, 1, 0.3, 1] }}
      className={cn(
        "group flex min-w-0 flex-col justify-between gap-3 rounded-poolix-lg border bg-surface p-4",
        "transition-colors hover:border-line-strong",
        emphasis ? "border-accent/25" : "border-line",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-[11px] font-medium uppercase tracking-[0.07em] text-subtle">
            {label}
          </span>
          {tip ? <InfoTip label={tip.label} body={tip.body} /> : null}
        </div>
        <span className="shrink-0 text-[10px] uppercase tracking-[0.06em] text-subtle/70">
          {timeframe ?? KIND_LABEL[metric.kind]}
        </span>
      </div>

      <div className="min-w-0">
        <p className="poolix-numeric flex items-baseline gap-1.5 truncate text-[22px] leading-none text-fg">
          {missing ? <span className="text-subtle">--</span> : display}
          {!missing && unit ? (
            <span className="text-[13px] font-normal text-muted">{unit}</span>
          ) : null}
        </p>
        <p className="mt-2 text-[12px] leading-snug text-subtle">
          {missing ? (metric.unavailableReason ?? metric.note) : metric.note}
        </p>
      </div>
    </motion.div>
  );
}

/** A responsive grid: one column on a phone, two on a small screen, then the count asked for. */
export function MetricRow({
  columns = 4,
  children,
  className,
}: {
  columns?: 2 | 3 | 4;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "grid grid-cols-1 gap-3 sm:grid-cols-2",
        columns === 3 ? "lg:grid-cols-3" : columns === 4 ? "lg:grid-cols-4" : "",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** A quiet section heading. The figures are the content; headings only sort them. */
export function SectionHeading({
  title,
  aside,
}: {
  title: string;
  aside?: ReactNode;
}) {
  return (
    <div className="mb-3 flex items-baseline justify-between gap-3">
      <h2 className="text-[13px] font-medium text-muted">{title}</h2>
      {aside ? <span className="text-[11.5px] text-subtle">{aside}</span> : null}
    </div>
  );
}
