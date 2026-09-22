import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  explorerUrl,
  formatBps,
  formatNumber,
  formatPrice,
  formatTokenAmount,
  formatUsd,
  truncateAddress,
} from "@/lib/format";

describe("truncateAddress", () => {
  it("shortens a valid address and leaves other strings untouched", () => {
    assert.equal(truncateAddress("0x1234567890123456789012345678901234ABCDEF"), "0x12...CDEF");
    assert.equal(truncateAddress("0x1234"), "0x1234");
  });
});

describe("formatUsd", () => {
  it("shows the unavailable marker instead of inventing a value", () => {
    assert.equal(formatUsd(null), "--");
    assert.equal(formatUsd(undefined), "--");
    assert.equal(formatUsd(Number.NaN), "--");
  });

  it("formats standard, small, and compact values", () => {
    assert.equal(formatUsd(1234.5), "$1,234.50");
    assert.equal(formatUsd(0), "$0.00");
    assert.equal(formatUsd(0.00012345), "$0.0001235");
    assert.equal(formatUsd(1_250_000, { compact: true }), "$1.25M");
  });
});

describe("formatBps", () => {
  it("formats basis points as percentages", () => {
    assert.equal(formatBps(25), "0.25%");
    assert.equal(formatBps(10_000), "100.00%");
    assert.equal(formatBps(0), "0.00%");
    assert.equal(formatBps(0.4), "<0.01%");
    assert.equal(formatBps(null), "--");
  });
});

describe("formatTokenAmount", () => {
  it("keeps full precision for large 18-decimal values", () => {
    assert.equal(formatTokenAmount("1234567.123456789123456789"), "1,234,567.123456");
  });

  it("truncates instead of rounding up", () => {
    assert.equal(formatTokenAmount("0.9999999"), "0.999999");
  });

  it("marks dust below the display precision", () => {
    assert.equal(formatTokenAmount("0.0000001"), "<0.000001");
    assert.equal(formatTokenAmount("0"), "0");
  });

  it("rejects non-decimal input", () => {
    assert.equal(formatTokenAmount("1e18"), "--");
    assert.equal(formatTokenAmount("-1"), "--");
  });
});

describe("formatNumber", () => {
  it("marks missing values rather than printing zero", () => {
    assert.equal(formatNumber(null), "--");
    assert.equal(formatNumber(Number.POSITIVE_INFINITY), "--");
  });

  it("groups thousands and collapses values below the display precision", () => {
    assert.equal(formatNumber(43_778, { maximumFractionDigits: 0 }), "43,778");
    assert.equal(formatNumber(0.0000001), "<0.000001");
    assert.equal(formatNumber(0), "0");
  });
});

describe("formatPrice", () => {
  it("keeps significant digits across many orders of magnitude", () => {
    assert.equal(formatPrice(2_500), "2,500");
    assert.equal(formatPrice(8.991934), "8.99193");
    // A price this small would read as "<0.000001" under fixed decimals.
    assert.equal(formatPrice(0.00000000123456), "0.00000000123456");
  });

  it("marks a missing price instead of showing zero", () => {
    assert.equal(formatPrice(null), "--");
    assert.equal(formatPrice(Number.NaN), "--");
    assert.equal(formatPrice(0), "0");
  });
});

describe("explorerUrl", () => {
  it("builds Blockscout paths without double slashes", () => {
    assert.equal(
      explorerUrl("https://robinhoodchain.blockscout.com/", "tx", "0xabc"),
      "https://robinhoodchain.blockscout.com/tx/0xabc",
    );
  });
});
