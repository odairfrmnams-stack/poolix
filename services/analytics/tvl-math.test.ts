import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatUsd } from "@/lib/format";
import {
  answerToUsd,
  centsToNumber,
  EXPECTED_FEED_DECIMALS,
  MAX_PRICE_AGE_SECONDS,
  priceAgeSeconds,
  usdCentsFrom,
  validateRound,
  type ChainlinkRound,
} from "@/services/analytics/tvl-math";

/*
  A real round read from the ETH/USD feed 0x78F3556b…8d3A9 on chain 4663 at
  2026-09-18T03:25:54Z. decimals() reported 8 and description() "ETH / USD".
*/
const LIVE_ROUND: ChainlinkRound = {
  roundId: 18_446_744_073_709_553_878n,
  answer: 246_666_630_000n, // $2,466.6663
  startedAt: 1_789_701_941n,
  updatedAt: 1_789_701_954n,
  answeredInRound: 18_446_744_073_709_553_878n,
};
const LIVE_NOW = 1_789_703_238n; // ~21 minutes later

const ETH = (whole: string) => BigInt(Math.round(Number(whole) * 1e6)) * 10n ** 12n;

describe("Chainlink answer conversion at 8 decimals", () => {
  it("converts the live round to the price it represents", () => {
    assert.equal(EXPECTED_FEED_DECIMALS, 8);
    // 1 ETH at the live answer.
    assert.equal(usdCentsFrom(10n ** 18n, LIVE_ROUND.answer, 8), 246_666n); // $2,466.66
    assert.equal(answerToUsd(LIVE_ROUND.answer, 8), 2_466.66);
  });

  it("honours a feed that reports decimals other than 8", () => {
    // Same price expressed at 6 decimals must give the same USD.
    assert.equal(usdCentsFrom(10n ** 18n, 2_466_666_630n, 6), 246_666n);
    // And at 18 decimals.
    assert.equal(usdCentsFrom(10n ** 18n, 2_466n * 10n ** 18n, 18), 246_600n);
  });

  it("truncates sub-cent remainders rather than rounding up", () => {
    // $0.019 of value must not present as $0.02.
    assert.equal(usdCentsFrom(10n ** 16n, 190_000_000n, 8), 1n); // 0.01 ETH * $1.90 = $0.019
  });
});

describe("ETH liquidity multiplied by ETH/USD", () => {
  it("values a round liquidity figure exactly", () => {
    // 1,000 ETH at $2,000.00
    const cents = usdCentsFrom(1_000n * 10n ** 18n, 200_000_000_000n, 8);
    assert.equal(cents, 200_000_000n);
    assert.equal(centsToNumber(cents), 2_000_000);
  });

  it("values the real scanned liquidity against the live answer", () => {
    // 142.83 ETH, the figure the analytics page was showing.
    const cents = usdCentsFrom(ETH("142.83"), LIVE_ROUND.answer, 8);
    assert.equal(cents, 35_231_394n);
    assert.equal(centsToNumber(cents), 352_313.94);
  });

  it("returns zero for zero liquidity rather than a placeholder", () => {
    assert.equal(usdCentsFrom(0n, LIVE_ROUND.answer, 8), 0n);
  });
});

describe("rejecting unusable oracle answers", () => {
  const base = { nowSeconds: LIVE_NOW, decimals: 8 };

  it("accepts the live round", () => {
    assert.deepEqual(validateRound(LIVE_ROUND, base), { ok: true });
  });

  it("rejects a zero or negative answer", () => {
    assert.deepEqual(validateRound({ ...LIVE_ROUND, answer: 0n }, base), {
      ok: false,
      reason: "answer-not-positive",
    });
    assert.deepEqual(validateRound({ ...LIVE_ROUND, answer: -1n }, base), {
      ok: false,
      reason: "answer-not-positive",
    });
  });

  it("rejects a feed that has never updated", () => {
    assert.deepEqual(validateRound({ ...LIVE_ROUND, updatedAt: 0n }, base), {
      ok: false,
      reason: "never-updated",
    });
  });

  it("rejects an invalid round id", () => {
    assert.deepEqual(validateRound({ ...LIVE_ROUND, roundId: 0n }, base), {
      ok: false,
      reason: "invalid-round",
    });
  });

  it("rejects a round answered in an earlier round", () => {
    assert.deepEqual(
      validateRound({ ...LIVE_ROUND, answeredInRound: LIVE_ROUND.roundId - 1n }, base),
      { ok: false, reason: "incomplete-round" },
    );
  });

  it("rejects unexpected decimals rather than mis-scaling the price", () => {
    assert.deepEqual(validateRound(LIVE_ROUND, { ...base, decimals: 18 }), {
      ok: false,
      reason: "unexpected-decimals",
    });
    assert.deepEqual(validateRound(LIVE_ROUND, { ...base, decimals: Number.NaN }), {
      ok: false,
      reason: "unexpected-decimals",
    });
  });
});

describe("staleness against the 24h heartbeat", () => {
  const base = { nowSeconds: LIVE_NOW, decimals: 8 };

  it("allows for the full heartbeat plus grace", () => {
    assert.equal(MAX_PRICE_AGE_SECONDS, 26 * 60 * 60);
  });

  it("accepts a price published 23 hours ago, which this feed does routinely", () => {
    const round = { ...LIVE_ROUND, updatedAt: LIVE_NOW - BigInt(23 * 3600) };
    assert.deepEqual(validateRound(round, base), { ok: true });
  });

  it("accepts a price right at the threshold and rejects one past it", () => {
    const atLimit = { ...LIVE_ROUND, updatedAt: LIVE_NOW - BigInt(MAX_PRICE_AGE_SECONDS) };
    assert.deepEqual(validateRound(atLimit, base), { ok: true });

    const past = { ...LIVE_ROUND, updatedAt: LIVE_NOW - BigInt(MAX_PRICE_AGE_SECONDS + 1) };
    assert.deepEqual(validateRound(past, base), { ok: false, reason: "stale" });
  });

  it("treats a future timestamp as clock skew, not staleness", () => {
    const ahead = { ...LIVE_ROUND, updatedAt: LIVE_NOW + 60n };
    assert.deepEqual(validateRound(ahead, base), { ok: true });
    assert.equal(priceAgeSeconds(ahead, LIVE_NOW), 0n);
  });

  it("reports the age of the live round", () => {
    assert.equal(priceAgeSeconds(LIVE_ROUND, LIVE_NOW), 1_284n);
  });
});

describe("large values and precision", () => {
  it("stays exact at a scale far beyond this chain", () => {
    // 1,000,000 ETH at $2,466.6663 — no float could hold this exactly.
    const cents = usdCentsFrom(1_000_000n * 10n ** 18n, LIVE_ROUND.answer, 8);
    assert.equal(cents, 246_666_630_000n);
    // Still inside the safe integer range once reduced to cents.
    assert.ok(Number(cents) < Number.MAX_SAFE_INTEGER);
  });

  it("does not overflow on absurd inputs", () => {
    const huge = usdCentsFrom(10n ** 30n, 10n ** 20n, 8);
    assert.ok(huge > 0n);
    assert.equal(typeof huge, "bigint");
  });

  it("keeps wei-level precision that a float would lose", () => {
    const odd = 1_234_567_890_123_456_789n; // 1.234567890123456789 ETH
    assert.equal(usdCentsFrom(odd, LIVE_ROUND.answer, 8), 304_526n);
  });
});

describe("USD formatting at the presentation layer", () => {
  it("formats a computed TVL", () => {
    const cents = usdCentsFrom(ETH("142.83"), LIVE_ROUND.answer, 8);
    assert.equal(formatUsd(centsToNumber(cents)), "$352,313.94");
  });

  it("formats compactly for a stat tile", () => {
    const cents = usdCentsFrom(1_000n * 10n ** 18n, 200_000_000_000n, 8);
    assert.equal(formatUsd(centsToNumber(cents), { compact: true }), "$2M");
  });

  it("shows the unavailable marker for a missing value rather than $0.00", () => {
    assert.equal(formatUsd(null), "--");
  });
});
