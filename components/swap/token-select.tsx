"use client";

import { useQuery } from "@tanstack/react-query";
import { Check, Plus, Search, Trash2, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { formatUnits, isAddress, type PublicClient } from "viem";
import { useConnection, usePublicClient } from "wagmi";

import { Dialog } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useCurrencyBalance } from "@/hooks/use-currency-balance";
import { useTokenList } from "@/hooks/use-token-list";
import { TokenIcon } from "@/components/token/token-icon";
import { copy } from "@/lib/copy";
import { formatTokenAmount, truncateAddress } from "@/lib/format";
import { addStoredToken, isDefaultToken, removeStoredToken } from "@/lib/token-storage";
import type { Currency } from "@/services/liquidity/types";
import { currencyId } from "@/services/tokens/currency";
import { fetchTokenMetadata } from "@/services/tokens/metadata";

interface TokenSelectProps {
  open: boolean;
  onClose: () => void;
  onSelect: (currency: Currency) => void;
  selectedId?: string;
}

export function TokenSelect({ open, onClose, onSelect, selectedId }: TokenSelectProps) {
  const [search, setSearch] = useState("");
  const tokens = useTokenList();
  const client = usePublicClient();

  const term = search.trim();
  const lower = term.toLowerCase();

  const matches = tokens.filter((token) => {
    if (term === "") return true;
    const address = token.kind === "erc20" ? token.address.toLowerCase() : "";
    return (
      token.symbol.toLowerCase().includes(lower) ||
      (token.kind === "erc20" && token.name.toLowerCase().includes(lower)) ||
      address === lower
    );
  });

  // An address that matches nothing in the list may still be a real token onchain.
  const shouldLookUp = isAddress(term) && matches.length === 0 && client !== undefined;
  const lookup = useQuery({
    queryKey: ["token-metadata", term],
    enabled: shouldLookUp,
    retry: 0,
    staleTime: 60_000,
    queryFn: () => fetchTokenMetadata(client as PublicClient, term),
  });

  const handleSelect = (currency: Currency) => {
    onSelect(currency);
    setSearch("");
    onClose();
  };

  return (
    <Dialog open={open} onClose={onClose} title={copy.swap.selectToken} className="sm:max-w-[420px]">
      <div className="border-b border-line px-5 py-3">
        <div className="relative">
          <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-subtle" aria-hidden="true" />
          <input
            type="text"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search name or paste address"
            aria-label="Search tokens"
            spellCheck={false}
            autoComplete="off"
            data-autofocus
            className="h-10 w-full rounded-poolix border border-line bg-canvas pr-3 pl-9 text-sm text-fg placeholder:text-subtle focus:border-line-strong focus:outline-none"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {matches.map((token) => (
          <TokenRow
            key={currencyId(token)}
            token={token}
            selected={currencyId(token) === selectedId}
            onSelect={handleSelect}
          />
        ))}

        {matches.length === 0 ? (
          shouldLookUp ? (
            <LookupResult
              isLoading={lookup.isPending}
              error={lookup.error}
              token={lookup.data ?? null}
              onImport={(token) => {
                addStoredToken(token);
                handleSelect(token);
              }}
            />
          ) : (
            <div className="px-3 py-10 text-center">
              <p className="text-[13.5px] text-fg">{copy.empty.tokens.title}</p>
              <p className="mt-1 text-[12.5px] text-muted">{copy.empty.tokens.message}</p>
            </div>
          )
        ) : null}
      </div>

      <p className="border-t border-line px-5 py-3 text-[11.5px] leading-relaxed text-subtle">
        Poolix ships no curated token list. Imported tokens are read from their own
        contracts and stored in this browser only — always check the address.
      </p>
    </Dialog>
  );
}

function TokenRow({
  token,
  selected,
  onSelect,
}: {
  token: Currency;
  selected: boolean;
  onSelect: (currency: Currency) => void;
}) {
  const connection = useConnection();
  const balance = useCurrencyBalance(token, connection.address);
  const removable = !isDefaultToken(token) && token.kind === "erc20";

  return (
    <div className="group relative">
      <button
        type="button"
        onClick={() => onSelect(token)}
        className="flex w-full items-center gap-3 rounded-poolix px-3 py-2.5 text-left transition-colors hover:bg-raised"
      >
        <TokenIcon
          address={token.kind === "erc20" ? token.address : null}
          symbol={token.symbol}
          size={32}
        />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate text-[14px] text-fg">{token.symbol}</span>
            {selected ? <Check className="size-3.5 shrink-0 text-accent-text" aria-hidden="true" /> : null}
          </span>
          <span className="block truncate text-[12px] text-subtle">
            {token.kind === "erc20" ? `${token.name} · ${truncateAddress(token.address)}` : "Native currency"}
          </span>
        </span>
        <span className="poolix-numeric shrink-0 pr-6 text-[12.5px] text-muted">
          {!connection.address ? null : balance.isLoading ? (
            <Skeleton className="h-3 w-12" />
          ) : balance.value === undefined ? (
            copy.data.unavailable
          ) : (
            formatTokenAmount(formatUnits(balance.value, token.decimals), { maximumFractionDigits: 4 })
          )}
        </span>
      </button>

      {removable && token.kind === "erc20" ? (
        <button
          type="button"
          onClick={() => removeStoredToken(token.address)}
          aria-label={`Remove ${token.symbol}`}
          className="absolute top-1/2 right-2 flex size-7 -translate-y-1/2 items-center justify-center rounded text-subtle opacity-0 transition-opacity group-hover:opacity-100 hover:text-negative focus-visible:opacity-100"
        >
          <Trash2 className="size-3.5" aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

function LookupResult({
  isLoading,
  error,
  token,
  onImport,
}: {
  isLoading: boolean;
  error: unknown;
  token: Currency | null;
  onImport: (token: Currency) => void;
}) {
  if (isLoading) {
    return <p className="px-3 py-10 text-center text-[13px] text-muted">{copy.loading.generic}</p>;
  }

  if (error !== null || token === null) {
    return (
      <div className="px-3 py-10 text-center">
        <TriangleAlert className="mx-auto size-5 text-warning" aria-hidden="true" />
        <p className="mt-3 text-[13.5px] text-fg">
          {error instanceof Error ? error.message : copy.empty.tokens.title}
        </p>
      </div>
    );
  }

  return (
    <div className="p-3">
      <div className="rounded-poolix border border-line bg-raised p-4">
        <p className="text-[14px] text-fg">
          {token.symbol}
          {token.kind === "erc20" ? <span className="ml-2 text-[12.5px] text-subtle">{token.name}</span> : null}
        </p>
        {token.kind === "erc20" ? (
          <p className="poolix-numeric mt-1 text-[11.5px] break-all text-subtle">{token.address}</p>
        ) : null}
        <p className="mt-3 text-[12px] leading-relaxed text-warning">
          This token is not verified by Poolix. Anyone can deploy a token using any name
          or symbol. Confirm the address before trading.
        </p>
        <button
          type="button"
          onClick={() => onImport(token)}
          className="mt-4 inline-flex h-9 w-full items-center justify-center gap-2 rounded-poolix bg-accent text-[13px] font-medium text-canvas transition-colors hover:bg-accent-hover"
        >
          <Plus className="size-4" aria-hidden="true" />
          Import {token.symbol}
        </button>
      </div>
    </div>
  );
}
