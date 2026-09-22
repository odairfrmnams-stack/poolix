/*
  Pure arithmetic for the portfolio. No I/O, no network, no state.

  Every on-chain quantity here stays a bigint from end to end. A liquidity position is a
  claim on reserves expressed as an exact ratio of LP tokens to total supply, and routing
  that through a float would round someone's balance — so nothing is converted to a number
  except a percentage meant for display, and that conversion happens once, at the edge.

  The other rule running through this file is that an unpriceable asset is not a worthless
  one. A holding with no validated price path carries `null`, never `0n`, and a total built
  from such a portfolio reports itself as partial. Summing unknowns as zero would produce a
  confident portfolio value that is quietly too small.
*/

/** Share is carried as an integer percentage scaled by this: six decimals of a percent. */
export const SHARE_SCALE = 1_000_000n;

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** Lower-cased, so one asset is one row however its address was written. */
export function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

export function sameAddress(a: string, b: string): boolean {
  return normalizeAddress(a) === normalizeAddress(b);
}

/**
 * Whether an address is worth reading at all.
 *
 * The zero address is excluded because a balance there is not a holding, and anything that
 * is not 20 hex bytes is rejected outright rather than passed to a contract call — token
 * metadata and URL parameters are both untrusted inputs here.
 */
export function isUsableAddress(address: string): boolean {
  const normalised = normalizeAddress(address);
  return ADDRESS_PATTERN.test(normalised) && normalised !== ZERO_ADDRESS;
}

/** Unique, usable addresses in first-seen order. Case-insensitive. */
export function dedupeAddresses(addresses: Iterable<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const address of addresses) {
    if (typeof address !== "string" || !isUsableAddress(address)) continue;
    const normalised = normalizeAddress(address);
    if (seen.has(normalised)) continue;
    seen.add(normalised);
    out.push(normalised);
  }
  return out;
}

// ------------------------------------------------------------ liquidity claim

export interface Underlying {
  readonly amount0: bigint;
  readonly amount1: bigint;
}

/**
 * The reserves an LP balance is a claim on.
 *
 *     amountN = reserveN * lpBalance / totalSupply
 *
 * One multiplication before the division, so the ratio is taken at full precision and the
 * only loss is the final floor — the same rounding the pair contract itself applies when
 * it burns. Doing it the other way round (dividing first) would zero out any position
 * smaller than the total supply, which is nearly all of them.
 *
 * Null when the question has no answer: no supply to take a share of, or nothing held.
 * That is deliberately not `{0n, 0n}`, which would read as "this position is empty".
 */
export function lpUnderlying(
  lpBalance: bigint,
  totalSupply: bigint,
  reserve0: bigint,
  reserve1: bigint,
): Underlying | null {
  if (lpBalance <= 0n || totalSupply <= 0n) return null;
  if (reserve0 < 0n || reserve1 < 0n) return null;
  // A balance above total supply is not a real chain state; refusing beats reporting a
  // claim on more than the pool holds.
  if (lpBalance > totalSupply) return null;

  return {
    amount0: (reserve0 * lpBalance) / totalSupply,
    amount1: (reserve1 * lpBalance) / totalSupply,
  };
}

/**
 * Pool share as a percentage scaled by SHARE_SCALE.
 *
 * Basis points are too coarse for this: a 0.184% position rounds to 1 bp, losing the part
 * a holder actually looks at. Six decimals of a percent keeps small positions legible
 * while staying an exact integer ratio.
 */
export function sharePercentScaled(lpBalance: bigint, totalSupply: bigint): bigint | null {
  if (lpBalance <= 0n || totalSupply <= 0n) return null;
  return (lpBalance * 100n * SHARE_SCALE) / totalSupply;
}

/**
 * Formats a scaled share.
 *
 * A share that rounds to nothing is shown as a bound, never as "0%". The ambiguity that
 * would otherwise arise is already resolved upstream: `sharePercentScaled` returns null
 * for a zero balance, so any value reaching here came from a position that really is held
 * — and a `0n` therefore means "smaller than the scale can express", not "empty". Printing
 * that as 0% would tell a holder they own none of a pool they do own.
 */
export function formatSharePercent(scaled: bigint | null, decimals = 3): string | null {
  if (scaled === null) return null;
  const floor = `<0.${"0".repeat(decimals - 1)}1%`;
  if (scaled <= 0n) return floor;

  const divisor = SHARE_SCALE / 10n ** BigInt(decimals);
  const rounded = scaled / divisor;
  if (rounded === 0n) return floor;

  const whole = rounded / 10n ** BigInt(decimals);
  const fraction = rounded % 10n ** BigInt(decimals);
  return `${whole.toLocaleString("en-US")}.${fraction.toString().padStart(decimals, "0")}%`;
}

// ------------------------------------------------------------------ valuation

export interface EthUsdRound {
  readonly answer: bigint;
  readonly decimals: number;
}

/**
 * Value of a token amount in the native asset, from the pool that holds both sides.
 *
 *     valueWei = amount * quoteReserve / baseReserve
 *
 * Exact integer arithmetic against the pool's own ratio. Null when the pool cannot price
 * it — an empty side means there is no rate, not a rate of zero.
 */
export function valueInEthWei(
  amount: bigint,
  baseReserve: bigint,
  quoteReserve: bigint,
): bigint | null {
  if (amount <= 0n) return 0n;
  if (baseReserve <= 0n || quoteReserve <= 0n) return null;
  return (amount * quoteReserve) / baseReserve;
}

/**
 * USD cents for an amount of the native asset.
 *
 * Only ever from a validated oracle round that the caller has already accepted. There is
 * no fallback rate, no cached last-known price and no cross-rate assembled from pools:
 * a dollar figure the chain cannot back is worse than no dollar figure.
 */
export function usdCentsForEth(weiAmount: bigint | null, ethUsd: EthUsdRound | null): bigint | null {
  if (weiAmount === null || ethUsd === null || ethUsd.answer <= 0n) return null;
  if (weiAmount <= 0n) return 0n;
  return (weiAmount * ethUsd.answer * 100n) / (10n ** 18n * 10n ** BigInt(ethUsd.decimals));
}

export interface ValuationTotal {
  /** Sum over the rows that had a validated price. Null when none did. */
  readonly cents: bigint | null;
  /** Rows that carried a price. */
  readonly valued: number;
  /** Rows that did not, and are therefore absent from the sum rather than zero in it. */
  readonly unvalued: number;
  /** True when every row was valued; a false here is what "partial valuation" means. */
  readonly complete: boolean;
}

/**
 * Totals a portfolio from rows that may or may not be priceable.
 *
 * Unpriced rows are counted, not summed. That is the difference between "your portfolio is
 * worth $X" and "the part of your portfolio we can price is worth $X" — and only the
 * second is ever true here, so the shape forces the caller to say which one it is showing.
 *
 * A portfolio with nothing priceable totals to null rather than to $0.00.
 */
export function totalValuation(rows: Iterable<bigint | null>): ValuationTotal {
  let cents = 0n;
  let valued = 0;
  let unvalued = 0;

  for (const row of rows) {
    if (row === null) unvalued++;
    else {
      cents += row;
      valued++;
    }
  }

  return {
    cents: valued === 0 ? null : cents,
    valued,
    unvalued,
    complete: valued > 0 && unvalued === 0,
  };
}

/**
 * Value of one LP position in the native asset.
 *
 * A position is valued through its WETH side doubled — the same definition Poolix uses for
 * pool liquidity everywhere else, and the reason it is sound is that a constant-product
 * pool holds equal value on each side.
 *
 * A token/token position returns null. Valuing it would need a rate for a third asset that
 * Poolix has not validated, and inventing one here would put a confident number on the
 * screen with nothing behind it.
 */
export function lpValueInEthWei(
  underlying: Underlying | null,
  wethSide: "token0" | "token1" | "none",
): bigint | null {
  if (underlying === null) return null;
  if (wethSide === "none") return null;
  const wethAmount = wethSide === "token0" ? underlying.amount0 : underlying.amount1;
  return wethAmount * 2n;
}

/** Which side of a pair holds WETH, decided by comparing addresses rather than assuming. */
export function wethSideOf(
  token0: string,
  token1: string,
  weth: string,
): "token0" | "token1" | "none" {
  if (sameAddress(token0, weth)) return "token0";
  if (sameAddress(token1, weth)) return "token1";
  return "none";
}
