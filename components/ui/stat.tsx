import type { ReactNode } from "react";

import { InfoTip } from "@/components/ui/info-tip";
import { cn } from "@/lib/utils";

export function Stat({
  label,
  value,
  hint,
  tip,
  className,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  tip?: { title: string; body: string };
  className?: string;
}) {
  return (
    <div className={cn("px-5 py-4", className)}>
      <div className="flex items-center gap-1.5">
        <p className="text-[11.5px] tracking-wide text-subtle uppercase">{label}</p>
        {tip ? <InfoTip label={tip.title} body={tip.body} /> : null}
      </div>
      <p className="poolix-numeric mt-2 text-[19px] leading-none text-fg">{value}</p>
      {hint ? <p className="mt-1.5 text-[12px] text-subtle">{hint}</p> : null}
    </div>
  );
}

export function StatGrid({ children, columns = 4 }: { children: ReactNode; columns?: 2 | 3 | 4 }) {
  return (
    <div
      className={cn(
        "grid gap-px overflow-hidden rounded-poolix-lg border border-line bg-line",
        columns === 2 && "sm:grid-cols-2",
        columns === 3 && "sm:grid-cols-2 lg:grid-cols-3",
        columns === 4 && "sm:grid-cols-2 lg:grid-cols-4",
      )}
    >
      {children}
    </div>
  );
}

export function StatCell({ children }: { children: ReactNode }) {
  return <div className="bg-surface">{children}</div>;
}
