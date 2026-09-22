import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PONS_DISCOVERY_CONFIG } from "@/services/pons/pons-config";
import {
  coveragePercent,
  describeDisqualification,
  marketCapUsdCents,
  priceInQuoteE18,
  qualify,
  swapQuoteVolumeWei,
  volumeUsdCents,
} from "@/services/pons/pons-math";

/** Real slot0 from the verified BUNEE/WETH pool at the 1% tier. */
const REAL_SQRT_PRICE = 4_517_874_848_524_550_533_109_777n;
/** Chainlink ETH/USD: $2,661.60 with 8 decimals. */
const ETH_USD = 266_160_315_240n;
const ETH_USD_DECIMALS = 8;

describe("priceInQuoteE18", () => {
  it("prices a real pool", () => {
    const price = priceInQuoteE18({
      sqrtPriceX96: REAL_SQRT_PRICE,
      quoteIsToken1: true,
      tokenDecimals: 18,
      quoteDecimals: 18,
    });
    assert.ok(price !== null);
    // sqrt ratio ~ 5.7e-5, so price is a small fraction of an ETH but not zero.
    assert.ok(price > 0n, "a live pool must produce a positive price");
    assert.ok(price < 10n ** 18n, "this token is worth far less than 1 ETH");
  });

  it("does not floor a small price to zero", () => {
    // The trap: dividing before scaling makes every cheap token cost exactly 0.
    const price = priceInQuoteE18({
      sqrtPriceX96: REAL_SQRT_PRICE,
      quoteIsToken1: true,
      tokenDecimals: 18,
      quoteDecimals: 18,
    });
    assert.notEqual(price, 0n);
    assert.notEqual(price, null);
  });

  it("inverts when the quote asset is token0", () => {
    const asToken1 = priceInQuoteE18({
      sqrtPriceX96: REAL_SQRT_PRICE,
      quoteIsToken1: true,
      tokenDecimals: 18,
      quoteDecimals: 18,
    });
    const asToken0 = priceInQuoteE18({
      sqrtPriceX96: REAL_SQRT_PRICE,
      quoteIsToken1: false,
      tokenDecimals: 18,
      quoteDecimals: 18,
    });
    assert.ok(asToken1 !== null && asToken0 !== null);
    // Reading the ordering backwards is off by the square of the ratio, not a rounding
    // difference — which is why token ordering is verified before a price is trusted.
    assert.notEqual(asToken1, asToken0);
    assert.ok(asToken0 > asToken1);
  });

  it("returns null for an uninitialised pool rather than zero", () => {
    assert.equal(
      priceInQuoteE18({ sqrtPriceX96: 0n, quoteIsToken1: true, tokenDecimals: 18, quoteDecimals: 18 }),
      null,
    );
    assert.equal(
      priceInQuoteE18({ sqrtPriceX96: -1n, quoteIsToken1: true, tokenDecimals: 18, quoteDecimals: 18 }),
      null,
    );
  });

  it("rejects out-of-range decimals", () => {
    for (const decimals of [-1, 37, 255, 1.5, Number.NaN]) {
      assert.equal(
        priceInQuoteE18({
          sqrtPriceX96: REAL_SQRT_PRICE,
          quoteIsToken1: true,
          tokenDecimals: decimals,
          quoteDecimals: 18,
        }),
        null,
        `decimals ${String(decimals)} must be refused`,
      );
    }
  });
});

describe("marketCapUsdCents", () => {
  const base = {
    priceInQuoteE18: 10n ** 15n, // 0.001 ETH per token
    totalSupply: 10n ** 27n, // 1,000,000,000 tokens at 18 decimals
    tokenDecimals: 18,
    quoteUsdAnswer: ETH_USD,
    quoteUsdDecimals: ETH_USD_DECIMALS,
  };

  it("computes a market cap in cents", () => {
    const cents = marketCapUsdCents(base);
    assert.ok(cents !== null);
    // 1e9 tokens x 0.001 ETH = 1e6 ETH, at $2,661.60 = $2.66bn.
    const dollars = cents / 100n;
    assert.ok(dollars > 2_600_000_000n && dollars < 2_700_000_000n, `got $${dollars.toString()}`);
  });

  it("uses exact integer arithmetic at 1e27 supply", () => {
    // A double cannot hold this; the result must still be exact.
    const cents = marketCapUsdCents(base);
    assert.equal(typeof cents, "bigint");
  });

  it("returns null when the price is unknown", () => {
    assert.equal(marketCapUsdCents({ ...base, priceInQuoteE18: null }), null);
    assert.equal(marketCapUsdCents({ ...base, priceInQuoteE18: 0n }), null);
  });

  it("returns null when the supply is unknown or zero", () => {
    assert.equal(marketCapUsdCents({ ...base, totalSupply: null }), null);
    assert.equal(marketCapUsdCents({ ...base, totalSupply: 0n }), null);
  });

  it("returns null when the oracle is unavailable", () => {
    // No ETH/USD means no USD figure. It does not mean a market cap of zero.
    assert.equal(marketCapUsdCents({ ...base, quoteUsdAnswer: null }), null);
    assert.equal(marketCapUsdCents({ ...base, quoteUsdDecimals: null }), null);
    assert.equal(marketCapUsdCents({ ...base, quoteUsdAnswer: 0n }), null);
    assert.equal(marketCapUsdCents({ ...base, quoteUsdAnswer: -1n }), null);
  });

  it("rejects out-of-range decimals", () => {
    assert.equal(marketCapUsdCents({ ...base, tokenDecimals: 255 }), null);
    assert.equal(marketCapUsdCents({ ...base, quoteUsdDecimals: 99 }), null);
  });
});

describe("swapQuoteVolumeWei", () => {
  it("takes the quote side whole, whichever way it went", () => {
    // Turnover, not net flow: a sell and a buy of the same size both count fully.
    assert.equal(swapQuoteVolumeWei(-500n, 1_000n, true), 1_000n);
    assert.equal(swapQuoteVolumeWei(500n, -1_000n, true), 1_000n);
    assert.equal(swapQuoteVolumeWei(-500n, 1_000n, false), 500n);
    assert.equal(swapQuoteVolumeWei(500n, -1_000n, false), 500n);
  });
});

describe("volumeUsdCents", () => {
  const base = {
    quoteVolumeWei: 10n ** 18n, // 1 ETH
    windowComplete: true,
    quoteUsdAnswer: ETH_USD,
    quoteUsdDecimals: ETH_USD_DECIMALS,
  };

  it("converts a complete window", () => {
    const cents = volumeUsdCents(base);
    assert.ok(cents !== null);
    assert.equal(cents / 100n, 2_661n);
  });

  it("returns null for an incomplete window, never a partial sum", () => {
    // A partial sum is always an undercount and never announces itself.
    assert.equal(volumeUsdCents({ ...base, windowComplete: false }), null);
  });

  it("reports zero for a complete window with no trades", () => {
    // Genuinely different from "unknown": the window was read and nothing traded.
    assert.equal(volumeUsdCents({ ...base, quoteVolumeWei: 0n }), 0n);
  });

  it("returns null without an oracle", () => {
    assert.equal(volumeUsdCents({ ...base, quoteUsdAnswer: null }), null);
    assert.equal(volumeUsdCents({ ...base, quoteUsdDecimals: null }), null);
  });

  it("refuses a negative volume", () => {
    assert.equal(volumeUsdCents({ ...base, quoteVolumeWei: -1n }), null);
  });
});

describe("qualify", () => {
  const cents = (dollars: number) => BigInt(dollars) * 100n;

  it("qualifies when both thresholds are met", () => {
    const result = qualify({ marketCapUsdCents: cents(50_000), volume24hUsdCents: cents(30_000) });
    assert.equal(result.qualified, true);
    assert.equal(result.reason, null);
  });

  it("qualifies at exactly the threshold, on both", () => {
    const result = qualify({
      marketCapUsdCents: cents(PONS_DISCOVERY_CONFIG.minMarketCapUsd),
      volume24hUsdCents: cents(PONS_DISCOVERY_CONFIG.minVolume24hUsd),
    });
    assert.equal(result.qualified, true);
  });

  it("does not qualify one cent below either threshold", () => {
    const capShort = qualify({
      marketCapUsdCents: cents(PONS_DISCOVERY_CONFIG.minMarketCapUsd) - 1n,
      volume24hUsdCents: cents(100_000),
    });
    assert.equal(capShort.qualified, false);
    assert.equal(capShort.reason, "market-cap-below-threshold");

    const volumeShort = qualify({
      marketCapUsdCents: cents(100_000),
      volume24hUsdCents: cents(PONS_DISCOVERY_CONFIG.minVolume24hUsd) - 1n,
    });
    assert.equal(volumeShort.qualified, false);
    assert.equal(volumeShort.reason, "volume-below-threshold");
  });

  it("requires BOTH conditions, not either", () => {
    assert.equal(qualify({ marketCapUsdCents: cents(1_000_000), volume24hUsdCents: cents(5) }).qualified, false);
    assert.equal(qualify({ marketCapUsdCents: cents(5), volume24hUsdCents: cents(1_000_000) }).qualified, false);
  });

  it("never qualifies a token with a missing market cap", () => {
    const result = qualify({ marketCapUsdCents: null, volume24hUsdCents: cents(1_000_000) });
    assert.equal(result.qualified, false);
    assert.equal(result.reason, "no-market-cap");
  });

  it("never qualifies a token with a missing volume", () => {
    // An incomplete 24h window must not be treated as zero and must not qualify.
    const result = qualify({ marketCapUsdCents: cents(1_000_000), volume24hUsdCents: null });
    assert.equal(result.qualified, false);
    assert.equal(result.reason, "no-volume");
  });

  it("treats a zero market cap as failing the threshold, not as missing", () => {
    assert.equal(qualify({ marketCapUsdCents: 0n, volume24hUsdCents: cents(50_000) }).reason, "market-cap-below-threshold");
  });

  it("is deterministic", () => {
    const input = { marketCapUsdCents: cents(20_000), volume24hUsdCents: cents(20_000) };
    const first = qualify(input);
    for (let i = 0; i < 200; i++) {
      assert.deepEqual(qualify(input), first);
    }
  });

  it("explains every disqualification", () => {
    for (const reason of [
      "no-market-cap",
      "no-volume",
      "market-cap-below-threshold",
      "volume-below-threshold",
    ] as const) {
      const text = describeDisqualification(reason);
      assert.ok(text.length > 0);
      // The explanation is numeric, never a judgement about the token.
      assert.ok(!/safe|good|bad|recommend|risk|scam/i.test(text), `"${text}" must not judge`);
    }
  });
});

describe("coveragePercent", () => {
  it("reports real coverage", () => {
    assert.equal(coveragePercent(0, 50, 100), 50);
    assert.equal(coveragePercent(1_000, 1_250, 1_500), 50);
  });

  it("caps at 100 rather than exceeding it", () => {
    assert.equal(coveragePercent(0, 150, 100), 100);
  });

  it("returns null rather than a misleading 0% or 100%", () => {
    assert.equal(coveragePercent(100, 100, 100), null);
    assert.equal(coveragePercent(100, 50, 200), null);
    assert.equal(coveragePercent(0, 0, Number.NaN), null);
  });

  it("never extrapolates beyond what was indexed", () => {
    // Indexing 6.9% must report 6.9%, not a projection of the remainder.
    const percent = coveragePercent(8_991_118, 13_117_425, 68_762_355);
    assert.ok(percent !== null);
    assert.ok(percent > 6 && percent < 8, `got ${String(percent)}`);
  });
});
