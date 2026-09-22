import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { maxSpendableNative, parseAmount, sanitizeAmountInput, toAmountInput } from "@/lib/amounts";

describe("sanitizeAmountInput", () => {
  it("keeps digits and a single decimal separator", () => {
    assert.equal(sanitizeAmountInput("1.5", 18), "1.5");
    assert.equal(sanitizeAmountInput("1.2.3", 18), "1.23");
    assert.equal(sanitizeAmountInput("abc12x.5y", 18), "12.5");
    assert.equal(sanitizeAmountInput("1,5", 18), "1.5");
  });

  it("truncates to the token's decimals instead of rounding up", () => {
    assert.equal(sanitizeAmountInput("1.123456789", 6), "1.123456");
    assert.equal(sanitizeAmountInput("1.9", 0), "1");
  });

  it("keeps partial entries typable", () => {
    assert.equal(sanitizeAmountInput("1.", 18), "1.");
    assert.equal(sanitizeAmountInput(".", 18), "0.");
    assert.equal(sanitizeAmountInput("", 18), "");
  });

  it("strips leading zeros without eating a lone zero", () => {
    assert.equal(sanitizeAmountInput("007", 18), "7");
    assert.equal(sanitizeAmountInput("0", 18), "0");
    assert.equal(sanitizeAmountInput("0.5", 18), "0.5");
  });
});

describe("parseAmount", () => {
  it("parses to base units", () => {
    assert.equal(parseAmount("1", 18), 10n ** 18n);
    assert.equal(parseAmount("0.5", 6), 500_000n);
  });

  it("returns null for empty, zero and incomplete input rather than throwing", () => {
    for (const value of ["", " ", ".", "0", "0.", "0.000", "abc"]) {
      assert.equal(parseAmount(value, 18), null, `expected null for ${JSON.stringify(value)}`);
    }
  });

  it("truncates excess precision instead of failing", () => {
    assert.equal(parseAmount("1.1234567", 6), 1_123_456n);
  });
});

describe("toAmountInput", () => {
  it("round-trips a balance at full precision", () => {
    const balance = 1_234_567_890_123_456_789n;
    assert.equal(parseAmount(toAmountInput(balance, 18), 18), balance);
  });
});

describe("maxSpendableNative", () => {
  it("holds back a gas reserve and never goes negative", () => {
    assert.equal(maxSpendableNative(1000n, 100n), 900n);
    assert.equal(maxSpendableNative(50n, 100n), 0n);
    assert.equal(maxSpendableNative(100n, 100n), 0n);
  });
});
