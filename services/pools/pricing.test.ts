import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { midPrice, poolValueInQuote } from "@/services/pools/pricing";

const ether = (value: string) => BigInt(Math.round(Number(value) * 1e6)) * 10n ** 12n;

describe("midPrice", () => {
  it("prices a same-decimals pair from its reserves", () => {
    // 1 WETH against 2,500 TOKEN -> 2,500 TOKEN per WETH.
    const price = midPrice(10n ** 18n, 18, 2_500n * 10n ** 18n, 18);
    assert.equal(price, 2_500);
  });

  it("handles a large decimals gap in either direction", () => {
    // 1 WETH (18dp) against 3,000 USDC (6dp).
    assert.equal(midPrice(10n ** 18n, 18, 3_000n * 10n ** 6n, 6), 3_000);
    // The inverse: 3,000 USDC (6dp) against 1 WETH (18dp).
    const inverse = midPrice(3_000n * 10n ** 6n, 6, 10n ** 18n, 18);
    assert.ok(inverse !== null);
    assert.ok(Math.abs(inverse - 1 / 3_000) < 1e-12);
  });

  it("returns null when either side is empty rather than dividing by zero", () => {
    assert.equal(midPrice(0n, 18, 10n ** 18n, 18), null);
    assert.equal(midPrice(10n ** 18n, 18, 0n, 18), null);
  });

  it("stays finite for the lopsided reserves seen on this chain", () => {
    // 0.2095 WETH against 1.88 of an 18dp token, taken from a live pair.
    const price = midPrice(ether("0.209514"), 18, ether("1.883936"), 18);
    assert.ok(price !== null);
    assert.ok(Math.abs(price - 8.9919) < 0.01);
  });
});

describe("poolValueInQuote", () => {
  it("doubles the quote side, because a pool holds equal value on each", () => {
    assert.equal(poolValueInQuote(5n * 10n ** 18n), 10n * 10n ** 18n);
    assert.equal(poolValueInQuote(0n), 0n);
  });
});
