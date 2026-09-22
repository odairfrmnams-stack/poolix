import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  APR_SCALE,
  formatApr,
  historicalFeeApr,
  timeWeightedLiquidity,
  YEAR_SECONDS,
  type LiquiditySample,
} from "@/services/analytics/apr-math";

const HOUR = 3_600;
const ETH = 10n ** 18n;
const WEEK = 7 * 24 * HOUR;
const MONTH = 30 * 24 * HOUR;

const T0 = 1_700_000_000 - (1_700_000_000 % HOUR);

/** `count` hourly samples all holding the same liquidity. */
const flat = (count: number, liquidityWei: bigint): LiquiditySample[] =>
  Array.from({ length: count }, (_, i) => ({
    startTimestamp: T0 + i * HOUR,
    durationSeconds: HOUR,
    liquidityWei,
  }));

/** APR as a plain number, for readable assertions only — never used in the maths. */
const asPercent = (scaled: bigint | null) => (scaled === null ? null : Number(scaled) / Number(APR_SCALE));

describe("time-weighted liquidity", () => {
  it("averages equal-duration samples", () => {
    const result = timeWeightedLiquidity([
      { startTimestamp: T0, durationSeconds: HOUR, liquidityWei: 100n },
      { startTimestamp: T0 + HOUR, durationSeconds: HOUR, liquidityWei: 200n },
    ]);
    assert.equal(result.twalWei, 150n);
    assert.equal(result.totalDurationSeconds, 2 * HOUR);
  });

  it("weights by duration, not by sample count", () => {
    // Three hours at 100 and one at 500 averages to 200, not to 300.
    const result = timeWeightedLiquidity([
      { startTimestamp: T0, durationSeconds: 3 * HOUR, liquidityWei: 100n },
      { startTimestamp: T0 + 3 * HOUR, durationSeconds: HOUR, liquidityWei: 500n },
    ]);
    assert.equal(result.twalWei, 200n);
  });

  it("handles unequal interval durations exactly", () => {
    const result = timeWeightedLiquidity([
      { startTimestamp: T0, durationSeconds: 1_000, liquidityWei: 10n },
      { startTimestamp: T0 + 1_000, durationSeconds: 3_000, liquidityWei: 30n },
    ]);
    // (10*1000 + 30*3000) / 4000 = 100000/4000 = 25
    assert.equal(result.twalWei, 25n);
  });

  it("ignores non-positive durations rather than skewing the weight", () => {
    const result = timeWeightedLiquidity([
      { startTimestamp: T0, durationSeconds: HOUR, liquidityWei: 100n },
      { startTimestamp: T0 + HOUR, durationSeconds: 0, liquidityWei: 999_999n },
    ]);
    assert.equal(result.twalWei, 100n);
    assert.equal(result.totalDurationSeconds, HOUR);
  });

  it("returns null when there is no duration to average over", () => {
    assert.equal(timeWeightedLiquidity([]).twalWei, null);
  });
});

describe("historical fee APR", () => {
  it("computes a normal 7D APR", () => {
    // 1 ETH of fees on 100 ETH average liquidity over 7 days.
    // 0.01 * (365/7) * 100 = 52.142857...%
    const result = historicalFeeApr({
      feesWei: ETH,
      samples: flat(168, 100n * ETH),
      windowSeconds: WEEK,
    });
    assert.equal(result.reason, "ok");
    const percent = asPercent(result.aprScaled);
    assert.equal(percent !== null && Math.abs(percent - 52.142857) < 0.0001, true);
  });

  it("computes a normal 30D APR", () => {
    // 1 ETH of fees on 100 ETH over 30 days: 0.01 * (365/30) * 100 = 12.1666...%
    const result = historicalFeeApr({
      feesWei: ETH,
      samples: flat(720, 100n * ETH),
      windowSeconds: MONTH,
    });
    const percent = asPercent(result.aprScaled);
    assert.equal(percent !== null && Math.abs(percent - 12.166666) < 0.0001, true);
  });

  it("annualizes by exactly year / window", () => {
    // Same fees and liquidity over 7D and 30D: the 7D figure must be 30/7 times larger.
    const week = historicalFeeApr({ feesWei: ETH, samples: flat(168, 100n * ETH), windowSeconds: WEEK });
    const month = historicalFeeApr({ feesWei: ETH, samples: flat(720, 100n * ETH), windowSeconds: MONTH });
    const ratio = Number(week.aprScaled) / Number(month.aprScaled);
    assert.equal(Math.abs(ratio - 30 / 7) < 0.0001, true);
  });

  it("uses the time-weighted average as the denominator, not the latest value", () => {
    // Liquidity ends at 1000 but averaged 100 across the window; APR must use 100.
    const samples = [...flat(167, 100n * ETH), { startTimestamp: T0, durationSeconds: HOUR, liquidityWei: 100n * ETH }];
    const spiked = [...flat(167, 100n * ETH), { startTimestamp: T0, durationSeconds: HOUR, liquidityWei: 1000n * ETH }];

    const flatResult = historicalFeeApr({ feesWei: ETH, samples, windowSeconds: WEEK });
    const spikedResult = historicalFeeApr({ feesWei: ETH, samples: spiked, windowSeconds: WEEK });
    // The spike raises the average, so APR falls — it does not track the final value.
    assert.equal((spikedResult.aprScaled ?? 0n) < (flatResult.aprScaled ?? 0n), true);
  });

  it("returns unavailable for zero liquidity rather than dividing", () => {
    const result = historicalFeeApr({ feesWei: ETH, samples: flat(168, 0n), windowSeconds: WEEK });
    assert.equal(result.aprScaled, null);
    assert.equal(result.reason, "zero-liquidity");
    assert.equal(formatApr(result.aprScaled), null);
  });

  it("returns unavailable when every sample is zero, not Infinity or NaN", () => {
    const result = historicalFeeApr({ feesWei: 5n * ETH, samples: flat(720, 0n), windowSeconds: MONTH });
    assert.equal(result.aprScaled, null);
    assert.equal(Number.isNaN(Number(result.aprScaled)), false);
  });

  it("returns unavailable with no samples at all", () => {
    const result = historicalFeeApr({ feesWei: ETH, samples: [], windowSeconds: WEEK });
    assert.equal(result.aprScaled, null);
    assert.equal(result.reason, "no-samples");
  });

  it("returns unavailable for a zero-length window", () => {
    const result = historicalFeeApr({ feesWei: ETH, samples: flat(168, ETH), windowSeconds: 0 });
    assert.equal(result.aprScaled, null);
    assert.equal(result.reason, "zero-window");
  });

  it("gives exactly zero APR for zero fees", () => {
    // Zero fees on real liquidity is a genuine zero, not an unavailable.
    const result = historicalFeeApr({ feesWei: 0n, samples: flat(168, 100n * ETH), windowSeconds: WEEK });
    assert.equal(result.aprScaled, 0n);
    assert.equal(result.reason, "ok");
    assert.equal(formatApr(result.aprScaled), "0.00%");
  });

  it("preserves a very high APR instead of capping it", () => {
    // Thin liquidity genuinely produces a huge figure; clamping it would be the lie.
    const result = historicalFeeApr({
      feesWei: 1_000n * ETH,
      samples: flat(168, ETH / 1_000n),
      windowSeconds: WEEK,
    });
    const percent = asPercent(result.aprScaled);
    assert.equal(percent !== null && percent > 1_000_000, true);
  });

  it("keeps full precision at wei scale", () => {
    // Values far beyond what a double can hold must survive intact.
    const fees = 123_456_789_012_345_678_901n;
    const liquidity = 987_654_321_098_765_432_109n;
    const result = historicalFeeApr({ feesWei: fees, samples: flat(168, liquidity), windowSeconds: WEEK });

    const expected =
      (fees * BigInt(168 * HOUR) * BigInt(YEAR_SECONDS) * 100n * APR_SCALE) /
      (liquidity * BigInt(168 * HOUR) * BigInt(WEEK));
    assert.equal(result.aprScaled, expected);
  });

  it("loses nothing that a float calculation would", () => {
    /*
      Two fee totals one wei apart. As doubles they are the same number, so any
      implementation that touched Number() on the way through would return identical
      results. Against a one-wei denominator the difference is well above the output
      resolution, so exact arithmetic must keep them apart.

      (At ordinary liquidity a single wei falls below APR_SCALE's own resolution and
      rounds away — that is deliberate quantisation of the published figure, not a
      precision fault, which is why the denominator here is deliberately tiny.)
    */
    const fees = 10n ** 30n;
    assert.equal(Number(fees), Number(fees + 1n));

    const a = historicalFeeApr({ feesWei: fees, samples: flat(2, 1n), windowSeconds: 2 * HOUR });
    const b = historicalFeeApr({ feesWei: fees + 1n, samples: flat(2, 1n), windowSeconds: 2 * HOUR });
    assert.notEqual(a.aprScaled, b.aprScaled);
  });

  it("is deterministic across repeated and reordered input", () => {
    const samples = [
      { startTimestamp: T0 + 2 * HOUR, durationSeconds: HOUR, liquidityWei: 30n * ETH },
      { startTimestamp: T0, durationSeconds: HOUR, liquidityWei: 10n * ETH },
      { startTimestamp: T0 + HOUR, durationSeconds: HOUR, liquidityWei: 20n * ETH },
    ];
    const first = historicalFeeApr({ feesWei: ETH, samples, windowSeconds: 3 * HOUR });
    const second = historicalFeeApr({ feesWei: ETH, samples: [...samples].reverse(), windowSeconds: 3 * HOUR });
    assert.equal(first.aprScaled, second.aprScaled);
    assert.equal(first.twalWei, second.twalWei);
  });

  it("treats a rolling window as a window of its own length", () => {
    // Shifting the same shape forward in time changes nothing about the result.
    const early = flat(168, 100n * ETH);
    const later = early.map((s) => ({ ...s, startTimestamp: s.startTimestamp + 50 * HOUR }));
    const a = historicalFeeApr({ feesWei: ETH, samples: early, windowSeconds: WEEK });
    const b = historicalFeeApr({ feesWei: ETH, samples: later, windowSeconds: WEEK });
    assert.equal(a.aprScaled, b.aprScaled);
  });

  it("handles a newly created pool whose early hours held nothing", () => {
    // Half the window at zero, half at 100 ETH: the average is 50, not 100.
    const samples = [...flat(84, 0n), ...flat(84, 100n * ETH)];
    const result = historicalFeeApr({ feesWei: ETH, samples, windowSeconds: WEEK });
    assert.equal(result.twalWei, 50n * ETH);
    assert.equal(result.reason, "ok");
  });

  it("computes 7D and 30D independently of one another", () => {
    // Different fees and different liquidity: neither result may borrow from the other.
    const week = historicalFeeApr({ feesWei: 2n * ETH, samples: flat(168, 50n * ETH), windowSeconds: WEEK });
    const month = historicalFeeApr({ feesWei: 9n * ETH, samples: flat(720, 300n * ETH), windowSeconds: MONTH });

    const weekExpected =
      (2n * ETH * BigInt(168 * HOUR) * BigInt(YEAR_SECONDS) * 100n * APR_SCALE) /
      (50n * ETH * BigInt(168 * HOUR) * BigInt(WEEK));
    const monthExpected =
      (9n * ETH * BigInt(720 * HOUR) * BigInt(YEAR_SECONDS) * 100n * APR_SCALE) /
      (300n * ETH * BigInt(720 * HOUR) * BigInt(MONTH));

    assert.equal(week.aprScaled, weekExpected);
    assert.equal(month.aprScaled, monthExpected);
    assert.notEqual(week.aprScaled, month.aprScaled);
  });

  it("cannot pair one window's fees with another window's liquidity", () => {
    /*
      The guard is structural: windowSeconds is supplied alongside the samples, so a 30D
      fee total measured against 7D of samples annualizes over 7 days and is visibly
      wrong rather than quietly plausible. This pins that they differ.
    */
    const honest = historicalFeeApr({ feesWei: 9n * ETH, samples: flat(720, 100n * ETH), windowSeconds: MONTH });
    const mismatched = historicalFeeApr({ feesWei: 9n * ETH, samples: flat(168, 100n * ETH), windowSeconds: WEEK });
    assert.notEqual(honest.aprScaled, mismatched.aprScaled);
    // And the mismatch inflates by exactly the annualization ratio, never silently agrees.
    const ratio = Number(mismatched.aprScaled) / Number(honest.aprScaled);
    assert.equal(Math.abs(ratio - 30 / 7) < 0.0001, true);
  });
});

describe("formatting", () => {
  it("shows two decimals for an ordinary value", () => {
    assert.equal(formatApr(12_840_000n), "12.84%");
    assert.equal(formatApr(10_910_000n), "10.91%");
  });

  it("returns null for unavailable rather than a zero", () => {
    assert.equal(formatApr(null), null);
  });

  it("shows enough precision for a very small non-zero value", () => {
    // 0.000123% would read as "0.00%" at two decimals, losing the only information.
    const formatted = formatApr(123n);
    assert.equal(formatted, "0.000123%");
    assert.notEqual(formatted, "0.00%");
  });

  it("groups thousands and never uses scientific notation", () => {
    const formatted = formatApr(1_812_990_000_000n);
    assert.equal(formatted, "1,812,990.00%");
    assert.equal(formatted.includes("e"), false);
  });

  it("rounds rather than truncating, carrying into the whole part", () => {
    assert.equal(formatApr(1_999_000n), "2.00%");
    assert.equal(formatApr(12_845_000n), "12.85%");
  });

  it("renders an exact zero plainly", () => {
    assert.equal(formatApr(0n), "0.00%");
  });
});
