/*
  Pure shaping for the analytics dashboard. No I/O, no network, no state.

  This module decides what the dashboard is ALLOWED to say. It computes nothing new — every
  figure it handles was already produced and verified by the Phase 1-4 pipelines — but it is
  the single place where "is this publishable?" is answered, so the answer is testable and
  cannot drift between one card and the next.

  Three rules, all of which exist because breaking them produces a plausible-looking screen:

  1. Absence is null, never zero. A metric that was not measured renders "--" and says why.
  2. USD exists only where a verified oracle round backed it. There is no historical USD,
     because there is no historical oracle to price it with.
  3. A pool without WETH is ranked, not dropped. Its ETH-denominated columns read "--"
     because they cannot be derived, which is a different statement from "this pool is
     not worth listing".
*/

import type {
  MetricKind,
  MetricView,
  PoolRankingRow,
  TokenRankingRow,
} from "@/services/analytics/dashboard-view";

/** A metric that was measured. */
export function metric(value: string, kind: MetricKind, note: string): MetricView {
  return { value, kind, note };
}

/** A metric that was not. The reason is rendered beside the "--". */
export function unavailable(kind: MetricKind, note: string, reason: string): MetricView {
  return { value: null, kind, note, unavailableReason: reason };
}

/**
 * Builds a metric from a value that may not exist.
 *
 * The point of routing every card through this is that "available" is decided once, from
 * the flag the producing service already set, rather than by each call site inventing its
 * own test — `=== 0`, `?? 0`, a truthiness check — which is how a real zero and a missing
 * reading end up rendered identically.
 */
export function metricFrom(
  available: boolean,
  value: () => string,
  kind: MetricKind,
  note: string,
  reason: string,
): MetricView {
  return available ? metric(value(), kind, note) : unavailable(kind, note, reason);
}

/**
 * USD cents for an amount of wei, or null.
 *
 * Null whenever the oracle is not available, which is the whole guard: there is no
 * fallback rate, no cached last-known price and no cross-rate from a pool. A dashboard
 * that prints a dollar figure the chain cannot back is worse than one that prints "--".
 */
export function usdCentsOrNull(
  weiAmount: bigint,
  ethUsd: { readonly answer: bigint; readonly decimals: number } | null,
): bigint | null {
  if (ethUsd === null || ethUsd.answer <= 0n) return null;
  return (weiAmount * ethUsd.answer * 100n) / (10n ** 18n * 10n ** BigInt(ethUsd.decimals));
}

/**
 * Whether a window's total may be published.
 *
 * A window with an un-ingested hour has a real sum, but that sum is not the window's
 * total — it is the total of the hours that happened to be present. Phase 1 withholds it,
 * and the dashboard withholds it the same way rather than showing a smaller number.
 */
export function windowPublishable(bucketsPresent: number, bucketsExpected: number): boolean {
  return bucketsExpected > 0 && bucketsPresent === bucketsExpected;
}

// ------------------------------------------------------------------- rankings

export type PoolSortKey =
  | "liquidity"
  | "volume24h"
  | "fees24h"
  | "transactions24h"
  | "apr7d"
  | "apr30d"
  | "pair";
export type TokenSortKey = "liquidity" | "pools" | "holders" | "price" | "symbol";
export type SortDirection = "asc" | "desc";

/** Parses a decimal-wei string, treating absence as absence rather than as zero. */
function weiOrNull(value: string | null): bigint | null {
  if (value === null) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

/**
 * Parses an APR back out of its formatted display, for sorting only.
 *
 * Sorting needs an order, and re-deriving the rate from the scaled integer would be a
 * second APR calculation living in the UI — exactly what Phase 3 forbids. Reading the
 * number the one formatter already produced keeps a single source for the value while
 * still giving the table something to sort on. It is never displayed.
 */
export function aprSortValue(display: string | null): number | null {
  if (display === null) return null;
  const parsed = Number.parseFloat(display.replace(/,/g, "").replace(/%$/, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Orders rows so that missing values sink.
 *
 * A row with no figure is never allowed to outrank one that has a real figure, in either
 * direction — sorting ascending must not promote every "--" to the top, because that
 * silently reorders the table around data that does not exist.
 */
function compareNullable(
  a: number | bigint | null,
  b: number | bigint | null,
  direction: SortDirection,
): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const ordering = a < b ? -1 : a > b ? 1 : 0;
  return direction === "asc" ? ordering : -ordering;
}

function compareText(a: string, b: string, direction: SortDirection): number {
  const ordering = a.localeCompare(b);
  return direction === "asc" ? ordering : -ordering;
}

function poolSortValue(row: PoolRankingRow, key: PoolSortKey): number | bigint | null {
  switch (key) {
    case "liquidity":
      return weiOrNull(row.liquidityWei);
    case "volume24h":
      return weiOrNull(row.volume24hWei);
    case "fees24h":
      return weiOrNull(row.fees24hWei);
    case "transactions24h":
      return row.transactions24h;
    case "apr7d":
      return aprSortValue(row.apr7dDisplay);
    case "apr30d":
      return aprSortValue(row.apr30dDisplay);
    case "pair":
      return null;
  }
}

/**
 * Sorts the pool ranking.
 *
 * Token/token pools are ORDERED, never removed. They carry no ETH-denominated figures, so
 * they sink under `compareNullable` like any other row without data — which is a statement
 * about what can be measured, not about whether the pool exists.
 *
 * The pair address breaks ties so the order is stable across renders; a table that
 * reshuffles rows holding identical values looks like live movement when nothing moved.
 */
export function sortPoolRows(
  rows: readonly PoolRankingRow[],
  key: PoolSortKey,
  direction: SortDirection,
): PoolRankingRow[] {
  return [...rows].sort((a, b) => {
    if (key === "pair") {
      const byPair = compareText(`${a.symbol0}/${a.symbol1}`, `${b.symbol0}/${b.symbol1}`, direction);
      if (byPair !== 0) return byPair;
    } else {
      const ordered = compareNullable(poolSortValue(a, key), poolSortValue(b, key), direction);
      if (ordered !== 0) return ordered;
    }
    return a.pair.localeCompare(b.pair);
  });
}

function tokenSortValue(row: TokenRankingRow, key: TokenSortKey): number | bigint | null {
  switch (key) {
    case "liquidity":
      return weiOrNull(row.liquidityWei);
    case "pools":
      return row.poolCount;
    case "holders":
      return row.holders;
    case "price":
      return weiOrNull(row.priceEthWei);
    case "symbol":
      return null;
  }
}

export function sortTokenRows(
  rows: readonly TokenRankingRow[],
  key: TokenSortKey,
  direction: SortDirection,
): TokenRankingRow[] {
  return [...rows].sort((a, b) => {
    if (key === "symbol") {
      const bySymbol = compareText(a.symbol, b.symbol, direction);
      if (bySymbol !== 0) return bySymbol;
    } else {
      const ordered = compareNullable(tokenSortValue(a, key), tokenSortValue(b, key), direction);
      if (ordered !== 0) return ordered;
    }
    return a.address.localeCompare(b.address);
  });
}

/**
 * Filters rows by a free-text query over symbols and addresses.
 *
 * Deliberately a filter over rows already on the page rather than a lookup: Poolix has one
 * search engine, reached with ctrl+K, and a second one that resolved addresses would be
 * two things to keep correct. An empty query returns everything rather than nothing.
 */
export function filterPoolRows(
  rows: readonly PoolRankingRow[],
  query: string,
): PoolRankingRow[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [...rows];
  return rows.filter((row) =>
    [row.pair, row.token0, row.token1, row.symbol0, row.symbol1, `${row.symbol0}/${row.symbol1}`]
      .join(" ")
      .toLowerCase()
      .includes(needle),
  );
}

export function filterTokenRows(
  rows: readonly TokenRankingRow[],
  query: string,
): TokenRankingRow[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [...rows];
  return rows.filter((row) =>
    `${row.address} ${row.symbol}`.toLowerCase().includes(needle),
  );
}

/**
 * Whether a historical point may be drawn for a pool that did not exist yet.
 *
 * Hours before a pool's creation carry a provable zero — the contract held nothing because
 * it had not been deployed — and that is true without being a measurement OF the pool.
 * Drawn on a chart it reads as a flat line of real activity at zero.
 */
export function pointPrecedesCreation(
  startTimestamp: number,
  creationTimestamp: number | null,
  bucketSeconds: number,
): boolean {
  if (creationTimestamp === null) return false;
  return startTimestamp < Math.floor(creationTimestamp / bucketSeconds) * bucketSeconds;
}
