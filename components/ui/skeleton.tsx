import { cn } from "@/lib/utils";

/** Placeholder for a value that is loading. Never used to stand in for missing data. */
export function Skeleton({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("inline-block animate-pulse rounded bg-line-strong/60 align-middle", className)}
    />
  );
}
