/**
 * Pool-derived pricing.
 *
 * A constant product pool's reserves give a mid price directly. That price is real and
 * checkable, but it is the price in the *paired asset*, not in dollars: Poolix has no
 * verified USD feed on this chain, so nothing here converts to fiat.
 */

/**
 * Mid price of the base asset denominated in the quote asset, ignoring fees and price
 * impact. Null when either reserve is empty, since there is no price to express.
 */
export function midPrice(
  baseReserve: bigint,
  baseDecimals: number,
  quoteReserve: bigint,
  quoteDecimals: number,
): number | null {
  if (baseReserve <= 0n || quoteReserve <= 0n) return null;

  // Scale to a common precision before converting, so a large decimals gap between the
  // two tokens does not lose the ratio to integer division.
  const PRECISION = 10n ** 18n;
  const scaledBase = baseReserve * 10n ** BigInt(Math.max(quoteDecimals - baseDecimals, 0));
  const scaledQuote = quoteReserve * 10n ** BigInt(Math.max(baseDecimals - quoteDecimals, 0));

  const ratio = (scaledQuote * PRECISION) / scaledBase;
  const price = Number(ratio) / Number(PRECISION);
  return Number.isFinite(price) ? price : null;
}

/**
 * Total value of a pool expressed in its quote asset: a balanced pool holds equal
 * value on each side, so the quote reserve doubled is the whole pool.
 */
export function poolValueInQuote(quoteReserve: bigint): bigint {
  return quoteReserve * 2n;
}
