"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { SearchInput } from "@/components/ui/input";
import { Tabs } from "@/components/ui/tabs";
import { poolixConfig } from "@/config/poolix";
import { copy } from "@/lib/copy";
import { TokenIcon } from "@/components/token/token-icon";
import { explorerUrl, formatUsd, truncateAddress } from "@/lib/format";
import { describeDisqualification } from "@/services/pons/pons-math";
import type { PonsStatus, PonsTokenRow } from "@/services/pons/pons-view";

/*
  Pons launches, as a table of what was actually indexed.

  Every number here is either verified or "--". There is no logo: Phase 8's CSP allows
  images only from Poolix's own origin, the launch events carry no image URI at all, and
  weakening that control to display an attacker-supplied URL is not a trade worth making.
  The initials block is the same one the rest of Poolix uses.

  Nothing on this surface ranks or judges. "Qualified" is a numeric filter over two
  thresholds and is labelled with the thresholds themselves.
*/

type StatusFilter = "all" | "v2" | "discovery" | "qualified" | PonsStatus;

export interface PonsBrowserProps {
  /** A bounded slice of the index: every qualified launch plus the newest others. */
  readonly rows: readonly PonsTokenRow[];
  readonly thresholds: { readonly minMarketCapUsd: number; readonly minVolume24hUsd: number };
  readonly qualifiedCount: number;
  /** Indexed launches Poolix's Uniswap v2 core can trade. */
  readonly v2AvailableCount: number;
  /** The full indexed count, which is larger than `rows` and is stated as such. */
  readonly indexedCount: number;
}

const matches = (query: string, ...fields: (string | null)[]) =>
  query === "" || fields.some((field) => field !== null && field.toLowerCase().includes(query));

/** A USD figure from integer cents, or the em-dash. Never a zero standing in for unknown. */
function usdOrDash(cents: string | null): string {
  if (cents === null) return copy.data.unavailable;
  return formatUsd(Number(BigInt(cents)) / 100);
}

function statusLabel(status: PonsStatus): string {
  switch (status) {
    case "new":
      return "Unverified";
    case "active":
      return "Traded 24h";
    case "graduated":
      return "Pool verified";
  }
}

export function PonsBrowser({
  rows,
  thresholds,
  qualifiedCount,
  v2AvailableCount,
  indexedCount,
}: PonsBrowserProps) {
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [query, setQuery] = useState("");

  const needle = query.trim().toLowerCase();

  const visible = useMemo(() => {
    const byStatus = rows.filter((row) => {
      if (filter === "all") return true;
      if (filter === "qualified") return row.qualified;
      if (filter === "v2") return row.v2Availability === "available";
      if (filter === "discovery") return row.v2Availability !== "available";
      return row.status === filter;
    });
    return byStatus.filter((row) => matches(needle, row.symbol, row.name, row.tokenAddress));
  }, [rows, filter, needle]);

  const columns: Column<PonsTokenRow>[] = [
    {
      key: "token",
      header: copy.tokens.token,
      width: "26%",
      cell: (row) => (
        <Link href={`/token/${row.tokenAddress}`} className="flex items-center gap-3">
          <TokenIcon address={row.tokenAddress} symbol={row.symbol} size={32} />
          <span className="min-w-0">
            <span className="block truncate text-fg">{row.symbol ?? copy.data.unavailable}</span>
            <span className="poolix-numeric block text-[11.5px] text-subtle">
              {truncateAddress(row.tokenAddress)}
            </span>
          </span>
        </Link>
      ),
    },
    {
      key: "price",
      header: "Price (ETH)",
      align: "right",
      hideBelow: "md",
      cell: (row) =>
        row.priceInQuoteE18 === null ? (
          <span className="text-subtle">{copy.data.unavailable}</span>
        ) : (
          <span className="poolix-numeric text-muted">
            {(Number(BigInt(row.priceInQuoteE18)) / 1e18).toPrecision(4)}
          </span>
        ),
    },
    {
      key: "marketCap",
      header: "Market cap",
      align: "right",
      cell: (row) => (
        <span className={row.marketCapUsdCents === null ? "text-subtle" : "poolix-numeric text-muted"}>
          {usdOrDash(row.marketCapUsdCents)}
        </span>
      ),
    },
    {
      key: "volume",
      header: "Volume 24H",
      align: "right",
      hideBelow: "sm",
      cell: (row) => (
        <span className={row.volume24hUsdCents === null ? "text-subtle" : "poolix-numeric text-muted"}>
          {usdOrDash(row.volume24hUsdCents)}
        </span>
      ),
    },
    {
      key: "trading",
      header: "Poolix trading",
      cell: (row) => (
        <span className="flex flex-wrap items-center gap-1.5">
          {row.v2Availability === "available" ? (
            <Badge tone="accent">V2 Available</Badge>
          ) : row.v2Availability === "unavailable" ? (
            <Badge tone="neutral">V2 Not Available</Badge>
          ) : (
            <Badge tone="neutral">{copy.data.unavailable}</Badge>
          )}
          {row.qualified ? <Badge tone="accent">Qualified</Badge> : null}
        </span>
      ),
    },
    {
      key: "status",
      header: "Pons pool",
      hideBelow: "lg",
      cell: (row) => <span className="text-subtle">{statusLabel(row.status)}</span>,
    },
    {
      key: "launch",
      header: "Launch block",
      align: "right",
      hideBelow: "lg",
      cell: (row) => (
        <span className="poolix-numeric text-subtle">{row.launchBlock.toLocaleString("en-US")}</span>
      ),
    },
    {
      key: "pool",
      // Named "source pool" deliberately: this is where the launch put its liquidity, not
      // a route Poolix trades through.
      header: "Source pool",
      align: "right",
      hideBelow: "lg",
      cell: (row) =>
        row.poolVerified ? (
          <a
            href={explorerUrl(poolixConfig.explorerUrl, "address", row.poolAddress)}
            target="_blank"
            rel="noopener noreferrer"
            className="poolix-numeric text-subtle underline-offset-4 hover:text-fg hover:underline"
          >
            {truncateAddress(row.poolAddress)}
          </a>
        ) : (
          <span className="text-subtle">{copy.data.unavailable}</span>
        ),
    },
  ];

  const filters: readonly { readonly value: StatusFilter; readonly label: string }[] = [
    { value: "all", label: "All" },
    { value: "v2", label: "V2 Available" },
    { value: "discovery", label: "Discovery only" },
    { value: "qualified", label: "Qualified" },
    { value: "active", label: "Traded 24h" },
  ];

  return (
    <div>
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Tabs
          items={filters.map((item) => ({
            value: item.value,
            label: item.label,
            count:
              item.value === "qualified"
                ? qualifiedCount
                : item.value === "v2"
                  ? v2AvailableCount
                  : undefined,
          }))}
          value={filter}
          onChange={setFilter}
          label="Filter Pons launches"
        />
        <SearchInput
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search symbol or address"
          className="sm:max-w-[260px]"
        />
      </div>

      {filter === "qualified" ? (
        <p className="mb-3 text-[12px] leading-relaxed text-subtle">
          Market cap at or above {formatUsd(thresholds.minMarketCapUsd)} <strong className="font-medium text-muted">and</strong>{" "}
          24-hour volume at or above {formatUsd(thresholds.minVolume24hUsd)}, both computed from
          verified on-chain data. This is a numerical filter only — it is not a judgement about any
          token.
        </p>
      ) : null}

      {filter === "v2" ? (
        <p className="mb-3 text-[12px] leading-relaxed text-subtle">
          A Uniswap v2 pair against W{poolixConfig.chain.nativeCurrency.symbol} exists for these
          tokens, read from the v2 factory itself. Poolix&rsquo;s existing swap, liquidity and
          analytics flows apply to them unchanged.
        </p>
      ) : null}

      {filter === "discovery" ? (
        <p className="mb-3 text-[12px] leading-relaxed text-subtle">
          The Uniswap v2 factory reports no pair for these tokens, so Poolix cannot trade them.
          They are listed for discovery only. Their launch liquidity sits in a Uniswap v3 pool
          that Poolix records as a reference but never routes through.
        </p>
      ) : null}

      <DataTable
        columns={columns}
        rows={visible}
        rowKey={(row) => row.tokenAddress}
        caption="Pons launches indexed by Poolix"
        empty={
          filter === "qualified" ? (
            <span>
              No indexed launch currently meets both thresholds. A token qualifies only when its
              market cap and its 24-hour volume can each be calculated from a verified price — a
              token with no verified price is never counted as zero.
            </span>
          ) : rows.length === 0 ? (
            <span>No Pons launches have been indexed yet.</span>
          ) : (
            <span>No indexed launch matches this filter.</span>
          )
        }
      />

      {visible.length > 0 && filter !== "qualified" ? (
        <p className="mt-3 text-[11.5px] leading-relaxed text-subtle">
          Showing the newest {rows.length.toLocaleString("en-US")} of{" "}
          {indexedCount.toLocaleString("en-US")} indexed launches, plus every launch that meets both
          thresholds.{" "}
          {visible.filter((row) => row.marketCapUsdCents === null).length.toLocaleString("en-US")} of{" "}
          {visible.length.toLocaleString("en-US")} shown rows carry {copy.data.unavailable} for market
          cap:{" "}
          {describeDisqualification("no-market-cap").toLowerCase()}. Prices are read from the pool a
          launch created, so a launch whose pool has not yet been re-verified shows no price rather
          than a stale one.
        </p>
      ) : null}
    </div>
  );
}
