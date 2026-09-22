import { Skeleton } from "@/components/ui/skeleton";
import { copy } from "@/lib/copy";

export default function PoolsLoading() {
  return (
    <div className="mx-auto max-w-[1280px] px-4 py-10 sm:px-6 sm:py-14">
      <Skeleton className="h-8 w-40" />
      <Skeleton className="mt-3 h-4 w-full max-w-2xl" />

      <div className="mt-10">
        <h2 className="text-[15px] font-medium text-fg">{copy.liquidity.yourLiquidity}</h2>
        <Skeleton className="mt-4 h-28 w-full rounded-poolix-lg" />
      </div>

      <div className="mt-10 grid gap-6 lg:grid-cols-[1fr_1.6fr]">
        <Skeleton className="h-52 w-full rounded-poolix-lg" />
        <div>
          <p className="text-[15px] font-medium text-fg">Pools ranked by liquidity</p>
          <p className="mt-1 text-[12.5px] text-subtle">{copy.loading.pools}</p>
          <Skeleton className="mt-4 h-80 w-full rounded-poolix-lg" />
        </div>
      </div>
    </div>
  );
}
