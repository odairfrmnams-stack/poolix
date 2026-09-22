import Link from "next/link";

import { PoolixMark } from "@/components/brand/poolix-mark";
import { buttonVariants } from "@/components/ui/button";
import { primaryNav } from "@/lib/navigation";
import { cn } from "@/lib/utils";

export default function NotFound() {
  return (
    <div className="mx-auto flex max-w-lg flex-col items-center px-4 py-28 text-center">
      <PoolixMark className="size-9" />
      <h1 className="mt-6 text-xl font-semibold tracking-[-0.02em]">Page not found</h1>
      <p className="mt-3 text-[13.5px] leading-relaxed text-muted">
        That address does not match anything in Poolix. If you were looking for a pool or a
        token, search for its contract address.
      </p>

      <div className="mt-7 flex flex-wrap items-center justify-center gap-2">
        <Link href="/" className={cn(buttonVariants({ variant: "primary" }))}>
          Back to home
        </Link>
        {primaryNav.map((item) => (
          <Link key={item.href} href={item.href} className={cn(buttonVariants({ variant: "secondary" }))}>
            {item.label}
          </Link>
        ))}
      </div>
    </div>
  );
}
