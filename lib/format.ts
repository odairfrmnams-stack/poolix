import { copy } from "@/lib/copy";

const UNAVAILABLE = copy.data.unavailable;
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const DECIMAL_PATTERN = /^\d+(\.\d+)?$/;

const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const usdSmallFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumSignificantDigits: 4,
});
const usdCompactFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 2,
});
const percentFormatter = new Intl.NumberFormat("en-US", {
  style: "percent",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const tokenFormatters = new Map<number, Intl.NumberFormat>();

function tokenFormatter(maximumFractionDigits: number): Intl.NumberFormat {
  let formatter = tokenFormatters.get(maximumFractionDigits);
  if (!formatter) {
    formatter = new Intl.NumberFormat("en-US", { maximumFractionDigits, roundingMode: "trunc" });
    tokenFormatters.set(maximumFractionDigits, formatter);
  }
  return formatter;
}

export function truncateAddress(address: string): string {
  if (!ADDRESS_PATTERN.test(address)) return address;
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

export function formatUsd(
  value: number | null | undefined,
  { compact = false }: { compact?: boolean } = {},
): string {
  if (value == null || !Number.isFinite(value)) return UNAVAILABLE;
  if (compact) return usdCompactFormatter.format(value);
  if (value !== 0 && Math.abs(value) < 1) return usdSmallFormatter.format(value);
  return usdFormatter.format(value);
}

export function formatBps(bps: number | null | undefined): string {
  if (bps == null || !Number.isFinite(bps)) return UNAVAILABLE;
  if (bps !== 0 && Math.abs(bps) < 1) return bps > 0 ? "<0.01%" : ">-0.01%";
  return percentFormatter.format(bps / 10_000);
}

/**
 * Formats a decimal string, such as the output of viem's formatUnits.
 * Truncates instead of rounding so a displayed balance never exceeds the real one.
 */
export function formatTokenAmount(
  decimal: string,
  { maximumFractionDigits = 6 }: { maximumFractionDigits?: number } = {},
): string {
  if (!DECIMAL_PATTERN.test(decimal)) return UNAVAILABLE;
  const formatted = tokenFormatter(maximumFractionDigits).format(decimal as `${number}`);
  if (formatted === "0" && /[1-9]/.test(decimal)) {
    return `<${(10 ** -maximumFractionDigits).toFixed(maximumFractionDigits)}`;
  }
  return formatted;
}

/**
 * Formats a plain number, such as a pool-derived price. Very small non-zero values
 * collapse to a threshold rather than to "0", which would read as no price at all.
 */
export function formatNumber(
  value: number | null | undefined,
  { maximumFractionDigits = 6 }: { maximumFractionDigits?: number } = {},
): string {
  if (value == null || !Number.isFinite(value)) return UNAVAILABLE;

  const threshold = 10 ** -maximumFractionDigits;
  if (value !== 0 && Math.abs(value) < threshold) {
    return `${value > 0 ? "<" : ">-"}${threshold.toFixed(maximumFractionDigits)}`;
  }
  return new Intl.NumberFormat("en-US", { maximumFractionDigits }).format(value);
}

const priceFormatter = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 6 });

/**
 * Formats a price. Pool-derived prices span many orders of magnitude, so this keeps
 * significant digits rather than a fixed number of decimals: a price of 1.2e-9 stays
 * readable instead of collapsing to a threshold.
 */
export function formatPrice(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return UNAVAILABLE;
  if (value === 0) return "0";
  return priceFormatter.format(value);
}

export type ExplorerResource = "tx" | "address" | "token";

export function explorerUrl(baseUrl: string, resource: ExplorerResource, value: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${resource}/${value}`;
}
