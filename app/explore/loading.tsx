import { Skeleton } from "@/components/ui/skeleton";
import { copy } from "@/lib/copy";

/*
  The Explore shell, shown while its data resolves.

  It mirrors the real layout — three deepest-pool cards, the source tabs, then a table with
  the same seven columns — so the page does not jump when the data lands. A centred spinner
  would be quicker to write and would tell the reader nothing about what is coming.
*/

function Row() {
  return (
    <div className="flex items-center gap-3 border-b border-line px-4 py-3 last:border-b-0">
      <Skeleton className="size-8 shrink-0 rounded-poolix-full" />
      <div className="min-w-0 flex-1 space-y-1.5">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-2.5 w-28" />
      </div>
      <Skeleton className="hidden h-3 w-16 md:block" />
      <Skeleton className="h-3 w-20" />
      <Skeleton className="hidden h-3 w-16 sm:block" />
      <Skeleton className="hidden h-5 w-24 rounded-poolix lg:block" />
      <Skeleton className="hidden h-3 w-20 lg:block" />
    </div>
  );
}

export default function ExploreLoading() {
  return (
    <div className="mx-auto max-w-[1280px] px-4 py-10 sm:px-6 sm:py-14">
      <Skeleton className="h-8 w-40" />
      <Skeleton className="mt-3 h-4 w-full max-w-2xl" />

      <section className="mt-8">
        <Skeleton className="mb-3 h-3.5 w-28" />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((index) => (
            <div key={index} className="rounded-poolix-lg border border-line bg-surface p-4">
              <div className="flex items-center gap-2.5">
                <div className="flex -space-x-2">
                  <Skeleton className="size-6 rounded-full" />
                  <Skeleton className="size-6 rounded-full" />
                </div>
                <Skeleton className="h-3.5 w-24" />
              </div>
              <Skeleton className="mt-4 h-5 w-32" />
              <Skeleton className="mt-2 h-3 w-36" />
            </div>
          ))}
        </div>
      </section>

      <section className="mt-8">
        <Skeleton className="mb-5 h-9 w-64 rounded-poolix" />
        <Skeleton className="mb-3 h-3.5 w-28" />
        <div className="mb-4 flex items-center justify-between gap-3">
          <Skeleton className="h-9 w-[22rem] rounded-poolix" />
          <Skeleton className="h-9 w-[16rem] rounded-poolix" />
        </div>
        <div className="overflow-hidden rounded-poolix-lg border border-line bg-surface">
          <div className="flex items-center gap-3 border-b border-line bg-raised/40 px-4 py-2.5">
            <Skeleton className="h-3 w-16" />
            <div className="flex-1" />
            <Skeleton className="hidden h-3 w-14 md:block" />
            <Skeleton className="h-3 w-16" />
            <Skeleton className="hidden h-3 w-16 sm:block" />
          </div>
          {Array.from({ length: 8 }, (_, index) => (
            <Row key={index} />
          ))}
        </div>
      </section>

      <p className="mt-6 text-[12px] text-subtle">{copy.loading.explore}</p>
    </div>
  );
}
