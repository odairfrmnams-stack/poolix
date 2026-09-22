import { Skeleton } from "@/components/ui/skeleton";
import { copy } from "@/lib/copy";

/*
  The Analytics shell.

  The previous version was three stacked bars — technically a skeleton, but it told the
  reader nothing and the page jumped when the real content replaced it. This mirrors what
  actually arrives: a four-tile overview row, the history chart with its timeframe control,
  the volume and fee tiles, and the two ranking tables.
*/

function MetricTile() {
  return (
    <div className="rounded-poolix-lg border border-line bg-surface p-4">
      <Skeleton className="h-3 w-24" />
      <Skeleton className="mt-3 h-6 w-32" />
      <Skeleton className="mt-2 h-2.5 w-36" />
    </div>
  );
}

function TableBlock({ rows }: { rows: number }) {
  return (
    <div className="overflow-hidden rounded-poolix-lg border border-line bg-surface">
      <div className="flex items-center gap-3 border-b border-line bg-raised/40 px-4 py-2.5">
        <Skeleton className="h-3 w-20" />
        <div className="flex-1" />
        <Skeleton className="hidden h-3 w-16 sm:block" />
        <Skeleton className="h-3 w-16" />
      </div>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex items-center gap-3 border-b border-line px-4 py-3 last:border-b-0">
          <Skeleton className="size-8 shrink-0 rounded-full" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-2.5 w-28" />
          </div>
          <Skeleton className="hidden h-3 w-16 sm:block" />
          <Skeleton className="h-3 w-20" />
        </div>
      ))}
    </div>
  );
}

export default function AnalyticsLoading() {
  return (
    <div className="mx-auto max-w-[1400px] px-4 py-10 sm:px-6 sm:py-14">
      <Skeleton className="h-8 w-44" />
      <Skeleton className="mt-3 h-4 w-full max-w-2xl" />

      {/* Overview: four tiles. */}
      <section className="mt-8">
        <div className="mb-3 flex items-center justify-between">
          <Skeleton className="h-3.5 w-24" />
          <Skeleton className="h-3.5 w-32" />
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((index) => (
            <MetricTile key={index} />
          ))}
        </div>
      </section>

      {/* History: the chart with its timeframe control. */}
      <section className="mt-8">
        <div className="mb-3 flex items-center justify-between">
          <Skeleton className="h-3.5 w-20" />
          <Skeleton className="h-3.5 w-48" />
        </div>
        <div className="rounded-poolix-lg border border-line bg-surface p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-2">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-7 w-48" />
              <Skeleton className="h-2.5 w-56" />
            </div>
            <div className="flex gap-1.5">
              <Skeleton className="h-7 w-16 rounded-poolix" />
              <Skeleton className="h-7 w-16 rounded-poolix" />
              <Skeleton className="h-7 w-12 rounded-poolix" />
            </div>
          </div>
          <Skeleton className="mt-6 h-56 w-full rounded-poolix" />
        </div>
      </section>

      {/* Volume and fees: six tiles. */}
      <section className="mt-8">
        <Skeleton className="mb-3 h-3.5 w-36" />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2, 3, 4, 5].map((index) => (
            <MetricTile key={index} />
          ))}
        </div>
      </section>

      {/* Rankings: pools, then the distribution beside tokens. */}
      <section className="mt-10">
        <Skeleton className="mb-3 h-3.5 w-28" />
        <TableBlock rows={5} />
      </section>

      <section className="mt-10 grid gap-6 lg:grid-cols-[1fr_1.4fr]">
        <div className="rounded-poolix-lg border border-line bg-surface p-5">
          <Skeleton className="h-3.5 w-36" />
          <Skeleton className="mt-4 h-48 w-full rounded-poolix" />
        </div>
        <div>
          <Skeleton className="mb-3 h-3.5 w-28" />
          <TableBlock rows={4} />
        </div>
      </section>

      <p className="mt-8 text-[12.5px] text-subtle">{copy.loading.analytics}</p>
    </div>
  );
}
