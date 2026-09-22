// Mirrors UniswapV2Library, UniswapV2Router02, and UniswapV2Pair arithmetic.
// Onchain router quotes stay the source of truth; these functions drive previews.

const FEE_NUMERATOR = 997n;
const FEE_DENOMINATOR = 1000n;
const BPS = 10_000n;
const PPM = 1_000_000n;

export const MINIMUM_LIQUIDITY = 1_000n;
export const MAX_SLIPPAGE_BPS = 5_000;

export type UniswapV2MathErrorCode =
  | "INSUFFICIENT_INPUT_AMOUNT"
  | "INSUFFICIENT_AMOUNT"
  | "INSUFFICIENT_LIQUIDITY"
  | "INSUFFICIENT_LIQUIDITY_MINTED"
  | "INSUFFICIENT_LIQUIDITY_BURNED"
  | "INVALID_PATH"
  | "INVALID_BPS";

export class UniswapV2MathError extends Error {
  override readonly name = "UniswapV2MathError";
  readonly code: UniswapV2MathErrorCode;

  constructor(code: UniswapV2MathErrorCode) {
    super(code);
    this.code = code;
  }
}

export interface Reserves {
  readonly reserveIn: bigint;
  readonly reserveOut: bigint;
}

export interface LiquidityAmounts {
  readonly amountA: bigint;
  readonly amountB: bigint;
}

function assertBps(value: number, max: number): void {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new UniswapV2MathError("INVALID_BPS");
  }
}

function assertReserves(...reserves: bigint[]): void {
  if (reserves.some((reserve) => reserve <= 0n)) {
    throw new UniswapV2MathError("INSUFFICIENT_LIQUIDITY");
  }
}

export function sqrt(value: bigint): bigint {
  if (value < 0n) throw new RangeError("Square root of a negative bigint");
  if (value < 4n) return value === 0n ? 0n : 1n;
  let result = value;
  let estimate = value / 2n + 1n;
  while (estimate < result) {
    result = estimate;
    estimate = (value / estimate + estimate) / 2n;
  }
  return result;
}

export function getAmountOut(amountIn: bigint, { reserveIn, reserveOut }: Reserves): bigint {
  if (amountIn <= 0n) throw new UniswapV2MathError("INSUFFICIENT_INPUT_AMOUNT");
  assertReserves(reserveIn, reserveOut);
  const amountInWithFee = amountIn * FEE_NUMERATOR;
  return (amountInWithFee * reserveOut) / (reserveIn * FEE_DENOMINATOR + amountInWithFee);
}

export function getAmountsOut(amountIn: bigint, hops: readonly Reserves[]): bigint[] {
  if (hops.length === 0) throw new UniswapV2MathError("INVALID_PATH");
  const amounts = [amountIn];
  let current = amountIn;
  for (const hop of hops) {
    current = getAmountOut(current, hop);
    amounts.push(current);
  }
  return amounts;
}

export function quote(amountA: bigint, reserveA: bigint, reserveB: bigint): bigint {
  if (amountA <= 0n) throw new UniswapV2MathError("INSUFFICIENT_AMOUNT");
  assertReserves(reserveA, reserveB);
  return (amountA * reserveB) / reserveA;
}

/**
 * Price impact in basis points, excluding the LP fee (shown separately).
 * Compares actual output with the mid-price output after fees across every hop.
 */
export function priceImpactBps(amountIn: bigint, amountOut: bigint, hops: readonly Reserves[]): number {
  if (hops.length === 0) throw new UniswapV2MathError("INVALID_PATH");
  if (amountIn <= 0n) throw new UniswapV2MathError("INSUFFICIENT_INPUT_AMOUNT");

  let reservesIn = 1n;
  let reservesOut = 1n;
  let feeNumerator = 1n;
  let feeDenominator = 1n;
  for (const { reserveIn, reserveOut } of hops) {
    assertReserves(reserveIn, reserveOut);
    reservesIn *= reserveIn;
    reservesOut *= reserveOut;
    feeNumerator *= FEE_NUMERATOR;
    feeDenominator *= FEE_DENOMINATOR;
  }

  const expected = amountIn * reservesOut * feeNumerator;
  const actual = amountOut * reservesIn * feeDenominator;
  if (actual >= expected) return 0;
  return Number(((expected - actual) * PPM) / expected) / 100;
}

/** Lower bound after slippage, used for amountOutMin, amountAMin, and amountBMin. */
export function applySlippage(amount: bigint, slippageBps: number): bigint {
  assertBps(slippageBps, MAX_SLIPPAGE_BPS);
  return (amount * (BPS - BigInt(slippageBps))) / BPS;
}

/** Mirrors UniswapV2Router02._addLiquidity. */
export function optimalLiquidityAmounts(
  amountADesired: bigint,
  amountBDesired: bigint,
  reserveA: bigint,
  reserveB: bigint,
): LiquidityAmounts {
  if (reserveA === 0n && reserveB === 0n) {
    return { amountA: amountADesired, amountB: amountBDesired };
  }
  const amountBOptimal = quote(amountADesired, reserveA, reserveB);
  if (amountBOptimal <= amountBDesired) {
    return { amountA: amountADesired, amountB: amountBOptimal };
  }
  return { amountA: quote(amountBDesired, reserveB, reserveA), amountB: amountBDesired };
}

/** Estimate only: the pair also mints protocol fees when feeTo is set. */
export function liquidityMinted({
  amountA,
  amountB,
  reserveA,
  reserveB,
  totalSupply,
}: LiquidityAmounts & { reserveA: bigint; reserveB: bigint; totalSupply: bigint }): bigint {
  let liquidity: bigint;
  if (totalSupply === 0n) {
    liquidity = sqrt(amountA * amountB) - MINIMUM_LIQUIDITY;
  } else {
    assertReserves(reserveA, reserveB);
    const fromA = (amountA * totalSupply) / reserveA;
    const fromB = (amountB * totalSupply) / reserveB;
    liquidity = fromA < fromB ? fromA : fromB;
  }
  if (liquidity <= 0n) throw new UniswapV2MathError("INSUFFICIENT_LIQUIDITY_MINTED");
  return liquidity;
}

export function removeLiquidityAmounts(
  liquidity: bigint,
  reserveA: bigint,
  reserveB: bigint,
  totalSupply: bigint,
): LiquidityAmounts {
  if (totalSupply <= 0n || liquidity > totalSupply) {
    throw new UniswapV2MathError("INSUFFICIENT_LIQUIDITY");
  }
  const amountA = liquidity > 0n ? (liquidity * reserveA) / totalSupply : 0n;
  const amountB = liquidity > 0n ? (liquidity * reserveB) / totalSupply : 0n;
  if (amountA <= 0n || amountB <= 0n) {
    throw new UniswapV2MathError("INSUFFICIENT_LIQUIDITY_BURNED");
  }
  return { amountA, amountB };
}

/** Percentage slider input in basis points; 100% returns the exact balance. */
export function liquidityForPercentage(balance: bigint, percentBps: number): bigint {
  assertBps(percentBps, 10_000);
  if (percentBps === 10_000) return balance;
  return (balance * BigInt(percentBps)) / BPS;
}

export function poolShareBps(balance: bigint, totalSupply: bigint): number | null {
  if (totalSupply <= 0n || balance < 0n || balance > totalSupply) return null;
  return Number((balance * PPM) / totalSupply) / 100;
}
