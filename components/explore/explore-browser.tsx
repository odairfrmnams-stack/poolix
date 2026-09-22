"use client";

import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { formatUnits } from "viem";

import { PairBadge } from "@/components/pools/pair-badge";
import { TokenIcon } from "@/components/token/token-icon";
import { DataTable, type Column } from "@/components/ui/data-table";
import { SearchInput } from "@/components/ui/input";
import { Tabs } from "@/components/ui/tabs";
import { poolixConfig } from "@/config/poolix";
import { copy } from "@/lib/copy";
import { formatPrice, formatTokenAmount, truncateAddress } from "@/lib/format";
import type { DiscoveredPool } from "@/services/pools/discovery";
import type { TokenListing } from "@/services/tokens/listing";

/*
  Tokens and pools in one place, over the same scan.

  The filter is deliberately dumb: it matches symbol or address against what is already
  on screen. It does not fetch, so it can never appear to find something the scan did not
  actually see — pasting an unknown address gives an empty result and the resolver link,
  rather than a fabricated row.
*/

type View = "tokens" | "pools";

export interface ExploreBrowserProps {
  readonly tokens: readonly TokenListing[];
  readonly pools: readonly DiscoveredPool[];
  readonly native: string;
}

const matches = (query: string, ...fields: string[]) =>
  query === "" || fields.some((field) => field.toLowerCase().includes(query));

export function ExploreBrowser({ tokens, pools, native }: ExploreBrowserProps) {
  const [view, setView] = useState<View>("tokens");
  const [query, setQuery] = useState("");

  const needle = query.trim().toLowerCase();

  const visibleTokens = useMemo(
    () => tokens.filter((token) => matches(needle, token.symbol, token.address)),
    [tokens, needle],
  );
  const visiblePools = useMemo(
    () => pools.filter((pool) => matches(needle, pool.other.symbol, pool.address, pool.other.address)),
    [pools, needle],
  );

  const tokenColumns: Column<TokenListing>[] = [
    {
      key: "token",
      header: copy.tokens.token,
      width: "34%",
      cell: (token) => (
        <Link href={`/token/${token.address}`} className="flex items-center gap-3">
          <TokenIcon address={token.address} symbol={token.symbol} size={32} />
          <span className="min-w-0">
            <span className="block truncate text-fg">{token.symbol}</span>
            <span className="poolix-numeric block text-[11.5px] text-subtle">
              {truncateAddress(token.address)}
            </span>
          </span>
        </Link>
      ),
    },
    {
      key: "price",
      header: `Price (${native})`,
      align: "right",
      cell: (token) => <span className="poolix-numeric text-fg">{formatPrice(token.priceEth)}</span>,
    },
    {
      key: "liquidity",
      header: copy.tokens.liquidity,
      align: "right",
      cell: (token) => (
        <span className="poolix-numeric text-fg">
          {formatTokenAmount(formatUnits(token.ethLiquidity, 18), { maximumFractionDigits: 4 })} {native}
        </span>
      ),
    },
    {
      key: "pools",
      header: copy.tokens.pools,
      align: "right",
      hideBelow: "sm",
      cell: (token) => <span className="poolix-numeric text-muted">{token.poolCount}</span>,
    },
    {
      key: "go",
      header: "",
      align: "right",
      width: "48px",
      cell: (token) => (
        <Link href={`/token/${token.address}`} aria-label={`Open ${token.symbol}`}>
          <ChevronRight className="ml-auto size-4 text-subtle" aria-hidden />
        </Link>
      ),
    },
  ];

  const poolColumns: Column<DiscoveredPool>[] = [
    {
      key: "pool",
      header: "Pool",
      width: "38%",
      cell: (pool) => (
        <Link href={`/pools/${pool.address}`} className="flex flex-col gap-0.5">
          <PairBadge
            symbol0="WETH"
            symbol1={pool.other.symbol}
            address0={poolixConfig.contracts.weth}
            address1={pool.other.address}
          />
          <span className="poolix-numeric pl-[46px] text-[11.5px] text-subtle">
            {truncateAddress(pool.address)}
          </span>
        </Link>
      ),
    },
    {
      key: "liquidity",
      header: `Liquidity (${native})`,
      align: "right",
      // Both sides of a balanced pool, so twice the ETH reserve.
      cell: (pool) => (
        <span className="poolix-numeric text-fg">
          {formatTokenAmount(formatUnits(BigInt(pool.wethReserve) * 2n, 18), {
            maximumFractionDigits: 4,
          })}
        </span>
      ),
    },
    {
      key: "reserve",
      header: "Token reserve",
      align: "right",
      hideBelow: "sm",
      cell: (pool) => (
        <span className="poolix-numeric text-muted">
          {formatTokenAmount(formatUnits(BigInt(pool.otherReserve), pool.other.decimals), {
            maximumFractionDigits: 2,
          })}
        </span>
      ),
    },
    {
      key: "go",
      header: "",
      align: "right",
      width: "48px",
      cell: (pool) => (
        <Link href={`/pools/${pool.address}`} aria-label={`Open WETH / ${pool.other.symbol} pool`}>
          <ChevronRight className="ml-auto size-4 text-subtle" aria-hidden />
        </Link>
      ),
    },
  ];

  return (
    <div>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Tabs
          label="Explore view"
          value={view}
          onChange={setView}
          items={[
            { value: "tokens", label: copy.nav.tokens, count: tokens.length },
            { value: "pools", label: copy.nav.pools, count: pools.length },
          ]}
        />
        <SearchInput
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search tokens, pools, or addresses"
          aria-label="Search tokens, pools, or addresses"
          wrapperClassName="sm:w-[320px]"
        />
      </div>

      <div className="mt-4">
        {view === "tokens" ? (
          <DataTable
            columns={tokenColumns}
            rows={visibleTokens}
            rowKey={(token) => token.address}
            caption="Tokens found by the pool scan"
            empty={
              needle === ""
                ? copy.empty.tokens.message
                : `Nothing in the scanned set matches "${query.trim()}". Paste a full address in the header search to read it straight from its contract.`
            }
          />
        ) : (
          <DataTable
            columns={poolColumns}
            rows={visiblePools}
            rowKey={(pool) => pool.address}
            caption="Pools found by the factory scan"
            empty={
              needle === ""
                ? "The scanned window contained no pools with liquidity on both sides."
                : `No scanned pool matches "${query.trim()}".`
            }
          />
        )}
      </div>
    </div>
  );
}
