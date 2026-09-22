"use client";

import { Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { getAddress, isAddress } from "viem";

import { copy } from "@/lib/copy";

/** Resolves any contract address to its token page; metadata is read there. */
export function TokenSearch() {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = value.trim();
    if (!isAddress(trimmed)) {
      setError("Enter a valid contract address.");
      return;
    }
    setError(null);
    router.push(`/token/${getAddress(trimmed)}`);
  }

  return (
    <form onSubmit={handleSubmit} className="w-full sm:max-w-sm">
      <div className="relative">
        <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-subtle" aria-hidden="true" />
        <input
          type="text"
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            if (error !== null) setError(null);
          }}
          placeholder={copy.search.placeholder}
          aria-label="Search by token address"
          spellCheck={false}
          autoComplete="off"
          className="h-10 w-full rounded-poolix border border-line bg-surface pr-3 pl-9 text-[13.5px] text-fg placeholder:text-subtle focus:border-line-strong focus:outline-none"
        />
      </div>
      {error !== null ? <p className="mt-2 text-[12px] text-negative">{error}</p> : null}
    </form>
  );
}
