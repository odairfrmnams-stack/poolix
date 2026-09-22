import { Skeleton } from "@/components/ui/skeleton";
import { copy } from "@/lib/copy";

/*
  The Portfolio shell.

  Mirrors the real page: header, the connect/summary band, then the token and LP position
  lists. The shell is the same whether or not a wallet is connected, so the layout does not
  shift when the wallet resolves on the client.
*/

function PositionRow() {
  return (
    <div className="flex items-center gap-3 border-b border-line px-4 py-3 last:border-b-0">
      <Skeleton className="size-8 shrink-0 rounded-full" />
      <div className="min-w-0 flex-1 space-y-1.5">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-2.5 w-32" />
      </div>
      <div className="space-y-1.5 text-right">
        <Skeleton className="ml-auto h-3 w-20" />
        <Skeleton className="ml-auto h-2.5 w-16" />
      </div>
    </div>
  );
}

export default function PortfolioLoading() {
  return (
    <div className="mx-auto max-w-[1280px] px-4 py-10 sm:px-6 sm:py-14">
      <Skeleton className="h-8 w-40" />
      <Skeleton className="mt-3 h-4 w-full max-w-xl" />

      <div className="mt-8 rounded-poolix-lg border border-line bg-surface p-5">
        <Skeleton className="h-3.5 w-32" />
        <Skeleton className="mt-3 h-7 w-44" />
        <Skeleton className="mt-2 h-3 w-56" />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        {["Tokens", "Liquidity positions"].map((section) => (
          <section key={section}>
            <Skeleton className="mb-3 h-3.5 w-32" />
            <div className="overflow-hidden rounded-poolix-lg border border-line bg-surface">
              {Array.from({ length: 4 }, (_, index) => (
                <PositionRow key={index} />
              ))}
            </div>
          </section>
        ))}
      </div>

      <p className="mt-6 text-[12px] text-subtle">{copy.loading.portfolio}</p>
    </div>
  );
}
