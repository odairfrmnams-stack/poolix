import type { ReactNode } from "react";

import { InfoTip } from "@/components/ui/info-tip";
import { cn } from "@/lib/utils";

/*
  One measured figure.

  The label is small and quiet, the value is the only thing with weight, and the hint
  underneath carries the scope — what window, what coverage, what the number does and
  does not cover. That hint is not decoration: every figure on Poolix states its own
  limits, and this is where it does it.
*/

export interface MetricCardProps {
  readonly label: string;
  readonly value: ReactNode;
  readonly hint?: ReactNode;
  readonly tip?: { readonly label: string; readonly body: string };
  /** Shown at the top right, e.g. a status badge. */
  readonly aside?: ReactNode;
  readonly className?: string;
}

export function MetricCard({ label, value, hint, tip, aside, className }: MetricCardProps) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col justify-between gap-3 rounded-poolix-lg border border-line bg-surface p-4",
        "transition-colors hover:border-line-strong",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-[11px] font-medium uppercase tracking-[0.07em] text-subtle">
            {label}
          </span>
          {tip ? <InfoTip label={tip.label} body={tip.body} /> : null}
        </div>
        {aside}
      </div>

      <div className="min-w-0">
        <p className="poolix-numeric truncate text-[22px] leading-none text-fg">{value}</p>
        {hint ? <p className="mt-2 text-[12px] leading-snug text-subtle">{hint}</p> : null}
      </div>
    </div>
  );
}

/**
 * Responsive grid for metric cards: one column on a phone, two on a small screen, then
 * the requested count. Metrics stay readable rather than being squeezed to fit a row.
 */
export function MetricGrid({
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
