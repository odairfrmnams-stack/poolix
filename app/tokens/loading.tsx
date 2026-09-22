import { Skeleton } from "@/components/ui/skeleton";
import { copy } from "@/lib/copy";

export default function TokensLoading() {
  return (
    <div className="mx-auto max-w-[1280px] px-4 py-10 sm:px-6 sm:py-14">
      <Skeleton className="h-8 w-40" />
      <Skeleton className="mt-3 h-4 w-full max-w-2xl" />
      <p className="mt-8 text-[12.5px] text-subtle">{copy.loading.generic}</p>
      <Skeleton className="mt-3 h-96 w-full rounded-poolix-lg" />
    </div>
  );
}
