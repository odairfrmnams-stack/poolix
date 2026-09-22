"use client";

import { RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { classifyError } from "@/lib/errors";

/**
 * Last-resort boundary. The message is mapped through the same classifier the
 * transaction surfaces use, so a wallet or RPC failure reads the same here as anywhere
 * else rather than dumping a stack trace at the user.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const poolixError = classifyError(error);

  return (
    <div className="mx-auto flex max-w-lg flex-col items-center px-4 py-28 text-center">
      <h1 className="text-xl font-semibold tracking-[-0.02em]">{poolixError.title}</h1>
      <p className="mt-3 text-[13.5px] leading-relaxed text-muted">{poolixError.message}</p>
      {error.digest ? (
        <p className="poolix-numeric mt-4 text-[11.5px] text-subtle">Reference {error.digest}</p>
      ) : null}
      <Button onClick={reset} className="mt-7">
        <RefreshCw className="size-4" aria-hidden="true" />
        Try Again
      </Button>
    </div>
  );
}
