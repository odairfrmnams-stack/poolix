"use client";

import { useQuery } from "@tanstack/react-query";
import { Droplets, ExternalLink, FileCode2, Search, Wallet } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import type { PublicClient } from "viem";
import { usePublicClient } from "wagmi";

import { TokenIcon } from "@/components/token/token-icon";
import { Dialog } from "@/components/ui/dialog";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useMounted } from "@/hooks/use-mounted";
import { useTokenList } from "@/hooks/use-token-list";
import { poolixConfig } from "@/config/poolix";
import { copy } from "@/lib/copy";
import { explorerUrl, truncateAddress } from "@/lib/format";
import { primaryNav, secondaryNav } from "@/lib/navigation";
import { resolveSearch, type SearchResult } from "@/services/search/resolve";
import { currencyId } from "@/services/tokens/currency";

export function GlobalSearch() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const mounted = useMounted();
  const router = useRouter();
  const client = usePublicClient();
  const tokens = useTokenList();

  const factory = poolixConfig.contracts.uniswapV2.factory;
  const debounced = useDebouncedValue(query.trim(), 250);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "k" || !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      setOpen((value) => !value);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const lookup = useQuery<SearchResult | null>({
    queryKey: ["global-search", debounced],
    enabled: open && client !== undefined && debounced.length >= 42,
    retry: 0,
    staleTime: 30_000,
    queryFn: () =>
      resolveSearch(
        client as PublicClient,
        factory.status === "configured" ? factory.address : null,
        debounced,
      ),
  });

  const lower = query.trim().toLowerCase();
  const matchingTokens =
    lower.length === 0
      ? []
      : tokens.filter(
          (token) =>
            token.symbol.toLowerCase().includes(lower) ||
            (token.kind === "erc20" && token.name.toLowerCase().includes(lower)),
        );
  const matchingPages = [...primaryNav, ...secondaryNav].filter((item) =>
    lower.length === 0 ? true : item.label.toLowerCase().includes(lower),
  );

  function go(href: string) {
    setOpen(false);
    setQuery("");
    router.push(href);
  }

  // The modifier differs by platform, and reading it during SSR would mismatch.
  const shortcut = !mounted ? "" : navigator.userAgent.includes("Mac") ? "⌘K" : "Ctrl K";

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={copy.nav.search}
        className="flex h-9 items-center gap-2 rounded-poolix border border-line bg-raised px-2.5 text-[13px] text-subtle transition-colors hover:border-line-strong hover:text-muted sm:w-52 sm:justify-between"
      >
        <span className="flex items-center gap-2">
          <Search className="size-3.5" aria-hidden="true" />
          <span className="hidden sm:inline">{copy.nav.search}</span>
        </span>
        {shortcut ? (
          <kbd className="hidden rounded border border-line px-1.5 py-0.5 text-[10.5px] text-subtle sm:inline">
            {shortcut}
          </kbd>
        ) : null}
      </button>

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={copy.nav.search}
        hideTitle
        className="sm:max-w-[520px]"
      >
        <div className="border-b border-line px-5 py-3">
          <div className="relative">
            <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-subtle" aria-hidden="true" />
            <input
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={copy.search.placeholder}
              aria-label={copy.nav.search}
              spellCheck={false}
              autoComplete="off"
              data-autofocus
              className="h-10 w-full rounded-poolix border border-line bg-canvas pr-3 pl-9 text-sm text-fg placeholder:text-subtle focus:border-line-strong focus:outline-none"
            />
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {lookup.isFetching ? (
            <p className="px-3 py-6 text-center text-[13px] text-muted">{copy.loading.generic}</p>
          ) : null}

          {lookup.data ? (
            <Group title="Result">
              <ResultRow result={lookup.data} onNavigate={go} />
            </Group>
          ) : null}

          {matchingTokens.length > 0 ? (
            <Group title={copy.nav.tokens}>
              {matchingTokens.map((token) => (
                <Row
                  key={currencyId(token)}
                  icon={
                    <TokenIcon
                      address={token.kind === "erc20" ? token.address : null}
                      symbol={token.symbol}
                      size={24}
                    />
                  }
                  title={token.symbol}
                  subtitle={token.kind === "erc20" ? truncateAddress(token.address) : "Native currency"}
                  onSelect={() =>
                    token.kind === "erc20" ? go(`/token/${token.address}`) : go("/swap")
                  }
                />
              ))}
            </Group>
          ) : null}

          {matchingPages.length > 0 ? (
            <Group title="Pages">
              {matchingPages.map((page) => (
                <Row
                  key={page.href}
                  icon={<FileCode2 className="size-3.5" aria-hidden="true" />}
                  title={page.label}
                  subtitle={page.href}
                  onSelect={() => go(page.href)}
                />
              ))}
            </Group>
          ) : null}

          {query.trim().length > 0 &&
          !lookup.isFetching &&
          lookup.data == null &&
          matchingTokens.length === 0 &&
          matchingPages.length === 0 ? (
            <p className="px-3 py-10 text-center text-[13px] text-muted">
              Nothing matched. Paste a full token, pool or transaction address to look it up
              onchain.
            </p>
          ) : null}
        </div>
      </Dialog>
    </>
  );
}

function ResultRow({
  result,
  onNavigate,
}: {
  result: SearchResult;
  onNavigate: (href: string) => void;
}) {
  switch (result.kind) {
    case "pool":
      return (
        <Row
          icon={<Droplets className="size-3.5" aria-hidden="true" />}
          title="Liquidity pool"
          subtitle={truncateAddress(result.address)}
          onSelect={() => onNavigate(`/pools/${result.address}`)}
        />
      );
    case "token":
      return (
        <Row
          icon={<TokenIcon address={result.address} symbol={result.symbol} size={24} />}
          title={result.symbol}
          subtitle={truncateAddress(result.address)}
          onSelect={() => onNavigate(`/token/${result.address}`)}
        />
      );
    case "account":
      return (
        <ExternalRow
          icon={<Wallet className="size-3.5" aria-hidden="true" />}
          title="Address"
          subtitle={truncateAddress(result.address)}
          href={explorerUrl(poolixConfig.explorerUrl, "address", result.address)}
        />
      );
    case "contract":
      return (
        <ExternalRow
          icon={<FileCode2 className="size-3.5" aria-hidden="true" />}
          title="Contract"
          subtitle={`${truncateAddress(result.address)} · not a pool or ERC-20 Poolix can read`}
          href={explorerUrl(poolixConfig.explorerUrl, "address", result.address)}
        />
      );
    case "transaction":
      return (
        <ExternalRow
          icon={<ExternalLink className="size-3.5" aria-hidden="true" />}
          title="Transaction"
          subtitle={truncateAddress(result.hash)}
          href={explorerUrl(poolixConfig.explorerUrl, "tx", result.hash)}
        />
      );
  }
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mb-2 last:mb-0">
      <p className="px-3 py-1.5 text-[11px] font-medium tracking-wider text-subtle uppercase">{title}</p>
      {children}
    </div>
  );
}

function Row({
  icon,
  title,
  subtitle,
  onSelect,
}: {
  icon: ReactNode;
  title: string;
  subtitle: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex w-full items-center gap-3 rounded-poolix px-3 py-2.5 text-left transition-colors hover:bg-raised"
    >
      <span className="text-subtle">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13.5px] text-fg">{title}</span>
        <span className="poolix-numeric block truncate text-[11.5px] text-subtle">{subtitle}</span>
      </span>
    </button>
  );
}

function ExternalRow({
  icon,
  title,
  subtitle,
  href,
}: {
  icon: ReactNode;
  title: string;
  subtitle: string;
  href: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="flex w-full items-center gap-3 rounded-poolix px-3 py-2.5 text-left transition-colors hover:bg-raised"
    >
      <span className="text-subtle">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13.5px] text-fg">{title}</span>
        <span className="poolix-numeric block truncate text-[11.5px] text-subtle">{subtitle}</span>
      </span>
      <ExternalLink className="size-3.5 shrink-0 text-subtle" aria-hidden="true" />
    </a>
  );
}
