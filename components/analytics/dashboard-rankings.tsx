"use client";

import { ArrowDown, ArrowUp, Search } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { formatUnits } from "viem";

import { PairBadge } from "@/components/pools/pair-badge";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { formatNumber, formatTokenAmount, formatUsd, truncateAddress } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  filterPoolRows,
  filterTokenRows,
  sortPoolRows,
  sortTokenRows,
  type PoolSortKey,
  type SortDirection,
  type TokenSortKey,
} from "@/services/analytics/dashboard-math";
import type { PoolRankingRow, TokenRankingRow } from "@/services/analytics/dashboard-view";

/*
  Pool and token rankings.

  Sorting and filtering happen over rows the server already sent — no chain reads, no
  second universe, no re-fetch per keystroke. The sort itself lives in dashboard-math.ts
  where it is tested, so the rule that rows without a figure sink rather than float is the
  same rule in the table and in the tests.

  A cell with no value renders "--". That is not a placeholder for a number that will
  arrive later; it is the statement that Poolix cannot derive it for that row, which for a
  token/token pool is most of the ETH-denominated columns.
*/

const DASH = "--";

const eth = (wei: string | null, digits = 4) =>
  wei === null ? DASH : formatTokenAmount(formatUnits(BigInt(wei), 18), { maximumFractionDigits: digits });

function SortButton<Key extends string>({
  label,
  columnKey,
  active,
  direction,
  onSort,
  align = "right",
}: {
  label: string;
  columnKey: Key;
  active: Key;
  direction: SortDirection;
  onSort: (key: Key) => void;
  align?: "left" | "right";
}) {
  const isActive = active === columnKey;
  return (
    <button
      type="button"
      onClick={() => onSort(columnKey)}
      aria-label={`Sort by ${label}`}
      className={cn(
        "inline-flex items-center gap-1 text-[11px] font-medium uppercase tracking-[0.07em] transition-colors",
        align === "right" ? "flex-row-reverse" : "",
        isActive ? "text-fg" : "text-subtle hover:text-muted",
      )}
    >
      {label}
      {isActive ? (
        direction === "desc" ? (
          <ArrowDown className="size-3" aria-hidden="true" />
        ) : (
          <ArrowUp className="size-3" aria-hidden="true" />
        )
      ) : null}
    </button>
  );
}

function FilterBox({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <label className="relative flex min-w-0 items-center">
      <Search className="pointer-events-none absolute left-2.5 size-3.5 text-subtle" aria-hidden="true" />
      <span className="sr-only">{placeholder}</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className={cn(
          "h-8 w-full rounded-poolix border border-line bg-canvas pl-8 pr-2.5 text-[12.5px] text-fg",
          "placeholder:text-subtle focus:border-line-strong focus:outline-none sm:w-56",
        )}
      />
    </label>
  );
}

// ------------------------------------------------------------------ pool table

export function PoolRankings({
  rows,
  nativeSymbol,
}: {
  rows: readonly PoolRankingRow[];
  nativeSymbol: string;
}) {
  const [sort, setSort] = useState<PoolSortKey>("liquidity");
  const [direction, setDirection] = useState<SortDirection>("desc");
  const [query, setQuery] = useState("");

  const visible = useMemo(
    () => sortPoolRows(filterPoolRows(rows, query), sort, direction),
    [rows, query, sort, direction],
  );

  const onSort = (key: PoolSortKey) => {
    if (key === sort) setDirection((current) => (current === "desc" ? "asc" : "desc"));
    else {
      setSort(key);
      setDirection(key === "pair" ? "asc" : "desc");
    }
  };

  const columns: readonly Column<PoolRankingRow>[] = [
    {
      key: "pair",
      header: <SortButton label="Pool" columnKey="pair" active={sort} direction={direction} onSort={onSort} align="left" />,
      cell: (row) => (
        <Link href={`/pools/${row.pair}`} className="flex min-w-0 flex-col gap-0.5">
          <PairBadge
            symbol0={row.symbol0}
            symbol1={row.symbol1}
            address0={row.token0}
            address1={row.token1}
            className="text-[13px]"
          />
          <span className="poolix-numeric text-[11.5px] text-subtle">{truncateAddress(row.pair)}</span>
        </Link>
      ),
    },
    {
      key: "liquidity",
      align: "right",
      header: <SortButton label={`Liquidity (${nativeSymbol})`} columnKey="liquidity" active={sort} direction={direction} onSort={onSort} />,
      cell: (row) => <span className="poolix-numeric text-[13px]">{eth(row.liquidityWei, 4)}</span>,
    },
    {
      key: "volume24h",
      align: "right",
      header: <SortButton label="Volume 24H" columnKey="volume24h" active={sort} direction={direction} onSort={onSort} />,
      cell: (row) => <span className="poolix-numeric text-[13px]">{eth(row.volume24hWei, 4)}</span>,
    },
    {
      key: "fees24h",
      align: "right",
      hideBelow: "md",
      header: <SortButton label="Fees 24H" columnKey="fees24h" active={sort} direction={direction} onSort={onSort} />,
      cell: (row) => <span className="poolix-numeric text-[13px]">{eth(row.fees24hWei, 6)}</span>,
    },
    {
      key: "transactions24h",
      align: "right",
      hideBelow: "lg",
      header: <SortButton label="Txns 24H" columnKey="transactions24h" active={sort} direction={direction} onSort={onSort} />,
      cell: (row) => (
        <span className="poolix-numeric text-[13px]">
          {row.transactions24h === null ? DASH : formatNumber(row.transactions24h, { maximumFractionDigits: 0 })}
        </span>
      ),
    },
    {
      key: "apr7d",
      align: "right",
      hideBelow: "md",
      header: <SortButton label="7D APR" columnKey="apr7d" active={sort} direction={direction} onSort={onSort} />,
      cell: (row) => <span className="poolix-numeric text-[13px]">{row.apr7dDisplay ?? DASH}</span>,
    },
    {
      key: "apr30d",
      align: "right",
      hideBelow: "lg",
      header: <SortButton label="30D APR" columnKey="apr30d" active={sort} direction={direction} onSort={onSort} />,
      cell: (row) => <span className="poolix-numeric text-[13px]">{row.apr30dDisplay ?? DASH}</span>,
    },
  ];

  return (
    <div className="min-w-0">
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-baseline gap-2">
          <h2 className="text-[14px] font-medium text-fg">Pools</h2>
          <span className="text-[11.5px] text-subtle">
            {visible.length} of {rows.length} indexed
          </span>
        </div>
        <FilterBox value={query} onChange={setQuery} placeholder="Filter pools or addresses" />
      </div>

      <DataTable
        columns={columns}
        rows={visible}
        rowKey={(row) => row.pair}
        caption="Pools ranked by the selected column"
        empty={
          rows.length === 0
            ? "No pool has been indexed for per-pool analytics yet."
            : "No pool matches that filter."
        }
      />

      {rows.some((row) => row.wethSide === "none") ? (
        <p className="mt-2 text-[11.5px] leading-relaxed text-subtle">
          Token-to-token pools are listed with {DASH} in the {nativeSymbol}-denominated columns.
          Poolix prices volume, fees and liquidity from the {nativeSymbol} side of a pool, so a
          pool holding neither cannot be valued without a rate it cannot verify.
        </p>
      ) : null}
    </div>
  );
}

// ----------------------------------------------------------------- token table

export function TokenRankings({
  rows,
  nativeSymbol,
  trackedCount,
}: {
  rows: readonly TokenRankingRow[];
  nativeSymbol: string;
  trackedCount: number;
}) {
  const [sort, setSort] = useState<TokenSortKey>("liquidity");
  const [direction, setDirection] = useState<SortDirection>("desc");
  const [query, setQuery] = useState("");

  const visible = useMemo(
    () => sortTokenRows(filterTokenRows(rows, query), sort, direction),
    [rows, query, sort, direction],
  );

  const onSort = (key: TokenSortKey) => {
    if (key === sort) setDirection((current) => (current === "desc" ? "asc" : "desc"));
    else {
      setSort(key);
      setDirection(key === "symbol" ? "asc" : "desc");
    }
  };

  const columns: readonly Column<TokenRankingRow>[] = [
    {
      key: "symbol",
      header: <SortButton label="Token" columnKey="symbol" active={sort} direction={direction} onSort={onSort} align="left" />,
      cell: (row) => (
        <Link href={`/token/${row.address}`} className="flex min-w-0 flex-col gap-0.5">
          <span className="flex items-center gap-1.5 text-[13px] text-fg">
            {row.symbol}
            {row.tracked ? (
              <Badge tone="neutral" size="sm">
                Tracked
              </Badge>
            ) : null}
          </span>
          <span className="poolix-numeric text-[11.5px] text-subtle">{truncateAddress(row.address)}</span>
        </Link>
      ),
    },
    {
      key: "liquidity",
      align: "right",
      header: <SortButton label={`Liquidity (${nativeSymbol})`} columnKey="liquidity" active={sort} direction={direction} onSort={onSort} />,
      cell: (row) => <span className="poolix-numeric text-[13px]">{eth(row.liquidityWei, 4)}</span>,
    },
    {
      key: "price",
      align: "right",
      header: <SortButton label={`Price (${nativeSymbol})`} columnKey="price" active={sort} direction={direction} onSort={onSort} />,
      cell: (row) => (
        <span className="poolix-numeric text-[13px]">
          {row.priceEthWei === null
            ? DASH
            : formatTokenAmount(formatUnits(BigInt(row.priceEthWei), 18), { maximumFractionDigits: 8 })}
        </span>
      ),
    },
    {
      key: "priceUsd",
      align: "right",
      hideBelow: "md",
      header: <span className="text-[11px] font-medium uppercase tracking-[0.07em] text-subtle">Price (USD)</span>,
      cell: (row) => (
        <span className="poolix-numeric text-[13px]">
          {/* USD only where a verified oracle round backed it. Never a cross-rate. */}
          {row.priceUsdCents === null
            ? DASH
            : BigInt(row.priceUsdCents) === 0n
              ? "<$0.01"
              : formatUsd(Number(BigInt(row.priceUsdCents)) / 100)}
        </span>
      ),
    },
    {
      key: "pools",
      align: "right",
      hideBelow: "sm",
      header: <SortButton label="Pools" columnKey="pools" active={sort} direction={direction} onSort={onSort} />,
      cell: (row) => <span className="poolix-numeric text-[13px]">{row.poolCount}</span>,
    },
  ];

  return (
    <div className="min-w-0">
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-baseline gap-2">
          <h2 className="text-[14px] font-medium text-fg">Tokens</h2>
          <span className="text-[11.5px] text-subtle">
            {visible.length} of {rows.length} from the scanned pools
          </span>
        </div>
        <FilterBox value={query} onChange={setQuery} placeholder="Filter tokens or addresses" />
      </div>

      <DataTable
        columns={columns}
        rows={visible}
        rowKey={(row) => row.address}
        caption="Tokens ranked by the selected column"
        empty={rows.length === 0 ? "No token has been scanned yet." : "No token matches that filter."}
      />

      <p className="mt-2 text-[11.5px] leading-relaxed text-subtle">
        These are the tokens found in Poolix&rsquo;s scanned pools, not every token on the chain.
        Of them, {trackedCount} are in the tracked universe that Holders is counted over. Holders
        is a chain-wide figure across that universe rather than a per-token one, so it is not
        broken down here.
      </p>
    </div>
  );
}
