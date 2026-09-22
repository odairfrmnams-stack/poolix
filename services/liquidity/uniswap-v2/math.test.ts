import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MINIMUM_LIQUIDITY,
  UniswapV2MathError,
  applySlippage,
  getAmountOut,
  getAmountsOut,
  liquidityForPercentage,
  liquidityMinted,
  optimalLiquidityAmounts,
  poolShareBps,
  priceImpactBps,
  quote,
  removeLiquidityAmounts,
  sqrt,
} from "@/services/liquidity/uniswap-v2/math";

const E18 = 10n ** 18n;
const E6 = 10n ** 6n;

/** The K check from UniswapV2Pair.swap for a single-direction trade. */
function pairAcceptsSwap(amountIn: bigint, amountOut: bigint, reserveIn: bigint, reserveOut: bigint): boolean {
  if (amountOut >= reserveOut) return false;
  const adjustedIn = (reserveIn + amountIn) * 1000n - amountIn * 3n;
  const adjustedOut = (reserveOut - amountOut) * 1000n;
  return adjustedIn * adjustedOut >= reserveIn * reserveOut * 1_000_000n;
}

function expectCode(fn: () => unknown, code: string) {
  assert.throws(fn, (error: unknown) => error instanceof UniswapV2MathError && error.code === code);
}

function* deterministicCases(count: number) {
  let seed = 0x5eedn;
  const next = (bound: bigint) => {
    seed = (seed * 6364136223846793005n + 1442695040888963407n) % 2n ** 64n;
    return (seed % bound) + 1n;
  };
  for (let i = 0; i < count; i++) {
    yield { amountIn: next(10_000n * E18), reserveIn: next(1_000_000n * E18), reserveOut: next(1_000_000n * E6) };
  }
}

describe("getAmountOut", () => {
  it("returns exactly the largest output the pair contract accepts", () => {
    const cases = [
      { amountIn: 1n, reserveIn: 1_000n, reserveOut: 1_000n },
      { amountIn: E18, reserveIn: 100n * E18, reserveOut: 200n * E18 },
      { amountIn: 5_000n * E6, reserveIn: 2_000_000n * E6, reserveOut: 800n * E18 },
      ...deterministicCases(200),
    ];
    for (const { amountIn, reserveIn, reserveOut } of cases) {
      const amountOut = getAmountOut(amountIn, { reserveIn, reserveOut });
      assert.ok(pairAcceptsSwap(amountIn, amountOut, reserveIn, reserveOut));
      assert.ok(!pairAcceptsSwap(amountIn, amountOut + 1n, reserveIn, reserveOut));
    }
  });

  it("reverts like the library for zero input or empty reserves", () => {
    expectCode(() => getAmountOut(0n, { reserveIn: E18, reserveOut: E18 }), "INSUFFICIENT_INPUT_AMOUNT");
    expectCode(() => getAmountOut(E18, { reserveIn: 0n, reserveOut: E18 }), "INSUFFICIENT_LIQUIDITY");
  });
});

describe("getAmountsOut", () => {
  it("chains hops and rejects empty paths", () => {
    const hops = [
      { reserveIn: 100n * E18, reserveOut: 300_000n * E6 },
      { reserveIn: 500_000n * E6, reserveOut: 50n * E18 },
    ];
    const [input, middle, output] = getAmountsOut(E18, hops);
    assert.equal(input, E18);
    assert.equal(middle, getAmountOut(E18, hops[0]!));
    assert.equal(output, getAmountOut(middle!, hops[1]!));
    expectCode(() => getAmountsOut(E18, []), "INVALID_PATH");
  });
});

describe("priceImpactBps", () => {
  it("is near zero for a tiny trade because the LP fee is excluded", () => {
    const reserves = { reserveIn: 1_000_000n * E18, reserveOut: 1_000_000n * E18 };
    const amountIn = E18;
    assert.ok(priceImpactBps(amountIn, getAmountOut(amountIn, reserves), [reserves]) < 0.1);
  });

  it("grows with trade size", () => {
    const reserves = { reserveIn: 1_000n * E18, reserveOut: 1_000n * E18 };
    const small = priceImpactBps(E18, getAmountOut(E18, reserves), [reserves]);
    const large = priceImpactBps(100n * E18, getAmountOut(100n * E18, reserves), [reserves]);
    assert.ok(large > small);
    // Closed form for one hop: impact = x·0.997 / (reserveIn + x·0.997) = 99.7 / 1099.7
    const expected = (99.7 / 1099.7) * 10_000;
    assert.ok(Math.abs(large - expected) < 0.01, `expected ${expected} bps, received ${large}`);
  });
});

describe("applySlippage", () => {
  it("floors the amount by the tolerance and validates input", () => {
    assert.equal(applySlippage(10_000n, 50), 9_950n);
    assert.equal(applySlippage(E18, 0), E18);
    expectCode(() => applySlippage(E18, 50.5), "INVALID_BPS");
    expectCode(() => applySlippage(E18, 5_001), "INVALID_BPS");
  });
});

describe("liquidity previews", () => {
  it("quotes the required ratio", () => {
    assert.equal(quote(2n * E18, 100n * E18, 300n * E18), 6n * E18);
  });

  it("matches router amount selection", () => {
    assert.deepEqual(optimalLiquidityAmounts(E18, 5n * E18, 100n * E18, 300n * E18), {
      amountA: E18,
      amountB: 3n * E18,
    });
    assert.deepEqual(optimalLiquidityAmounts(5n * E18, 3n * E18, 100n * E18, 300n * E18), {
      amountA: E18,
      amountB: 3n * E18,
    });
    assert.deepEqual(optimalLiquidityAmounts(7n, 9n, 0n, 0n), { amountA: 7n, amountB: 9n });
  });

  it("locks minimum liquidity on the first deposit", () => {
    const minted = liquidityMinted({ amountA: 4n * E18, amountB: E18, reserveA: 0n, reserveB: 0n, totalSupply: 0n });
    assert.equal(minted, 2n * E18 - MINIMUM_LIQUIDITY);
    expectCode(
      () => liquidityMinted({ amountA: 1_000n, amountB: 1_000n, reserveA: 0n, reserveB: 0n, totalSupply: 0n }),
      "INSUFFICIENT_LIQUIDITY_MINTED",
    );
  });

  it("mints the smaller share for later deposits", () => {
    const minted = liquidityMinted({
      amountA: 10n * E18,
      amountB: 20n * E18,
      reserveA: 100n * E18,
      reserveB: 100n * E18,
      totalSupply: 100n * E18,
    });
    assert.equal(minted, 10n * E18);
  });

  it("previews removal and rejects burns that return nothing", () => {
    assert.deepEqual(removeLiquidityAmounts(25n * E18, 400n * E18, 800n * E6, 100n * E18), {
      amountA: 100n * E18,
      amountB: 200n * E6,
    });
    expectCode(() => removeLiquidityAmounts(1n, 1n, 1n, 100n * E18), "INSUFFICIENT_LIQUIDITY_BURNED");
    expectCode(() => removeLiquidityAmounts(2n, E18, E18, 1n), "INSUFFICIENT_LIQUIDITY");
  });

  it("returns the exact balance at 100% to avoid leaving dust", () => {
    const balance = 123_456_789n;
    assert.equal(liquidityForPercentage(balance, 10_000), balance);
    assert.equal(liquidityForPercentage(balance, 2_500), 30_864_197n);
    expectCode(() => liquidityForPercentage(balance, 10_001), "INVALID_BPS");
  });

  it("computes pool share in basis points", () => {
    assert.equal(poolShareBps(25n, 100n), 2_500);
    assert.equal(poolShareBps(1n, 3n), 3_333.33);
    assert.equal(poolShareBps(1n, 0n), null);
  });
});

describe("sqrt", () => {
  it("returns the integer floor square root", () => {
    for (const value of [0n, 1n, 2n, 3n, 4n, 15n, 16n, 17n, 10n ** 36n, 2n ** 255n]) {
      const root = sqrt(value);
      assert.ok(root * root <= value && (root + 1n) * (root + 1n) > value, `sqrt(${value})`);
    }
  });
});
