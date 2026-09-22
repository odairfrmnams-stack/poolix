import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { APR_SCALE } from "@/services/analytics/apr-math";
import {
  ethLiquidityOf,
  groupPoolPoints,
  latestObservedLiquidity,
  maskPreCreation,
  poolWindowStarts,
  POOL_TIMEFRAME_HOURS,
  normalizeAddress,
  otherReserveOf,
  poolPrice,
  priceInQuoteWei,
  sameAddress,
  totalPoolWindow,
  wethReserveOf,
  wethSideOf,
  windowPredatesPool,
  type PoolBucket,
} from "@/services/pools/pool-analytics-math";

const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const TOKEN_A = "0xaaaa000000000000000000000000000000000001";
const TOKEN_B = "0xbbbb000000000000000000000000000000000002";

const HOUR = 3_600;
const ETH = 10n ** 18n;
const T0 = 1_700_000_000 - (1_700_000_000 % HOUR);

const starts = (count: number) => Array.from({ length: count }, (_, i) => T0 + i * HOUR);

const bucket = (
  startTimestamp: number,
  over: Partial<Omit<PoolBucket, "startTimestamp">> = {},
): PoolBucket => ({
  startTimestamp,
  volumeWei: 0n,
  swaps: 0,
  transactions: 0,
  liquidityWei: null,
  ...over,
});

const mapOf = (list: readonly PoolBucket[]) => new Map(list.map((b) => [b.startTimestamp, b]));

describe("address handling", () => {
  it("normalises case so one pool is one key", () => {
    assert.equal(normalizeAddress(TOKEN_A.toUpperCase()), TOKEN_A);
    assert.equal(normalizeAddress(`  ${TOKEN_A}  `), TOKEN_A);
    assert.equal(sameAddress(TOKEN_A.toUpperCase(), TOKEN_A), true);
  });

  it("does not treat different addresses as equal", () => {
    assert.equal(sameAddress(TOKEN_A, TOKEN_B), false);
  });
});

describe("token0 / token1 ordering", () => {
  it("finds WETH on token0", () => {
    assert.equal(wethSideOf(WETH, TOKEN_A, WETH), "token0");
  });

  it("finds WETH on token1", () => {
    // The case an implementation that assumes token0 would silently get wrong.
    assert.equal(wethSideOf(TOKEN_A, WETH, WETH), "token1");
  });

  it("reports a token/token pair as having no WETH side", () => {
    assert.equal(wethSideOf(TOKEN_A, TOKEN_B, WETH), "none");
  });

  it("matches WETH regardless of the case it is written in", () => {
    assert.equal(wethSideOf(WETH.toUpperCase(), TOKEN_A, WETH), "token0");
    assert.equal(wethSideOf(TOKEN_A, WETH, WETH.toUpperCase()), "token1");
  });

  it("takes the correct reserve for each side", () => {
    const reserves = { reserve0: 5n, reserve1: 900n };
    assert.equal(wethReserveOf(reserves, "token0"), 5n);
    assert.equal(otherReserveOf(reserves, "token0"), 900n);
    assert.equal(wethReserveOf(reserves, "token1"), 900n);
    assert.equal(otherReserveOf(reserves, "token1"), 5n);
  });

  it("gives no reserve at all for a token/token pair", () => {
    const reserves = { reserve0: 5n, reserve1: 900n };
    assert.equal(wethReserveOf(reserves, "none"), null);
    assert.equal(otherReserveOf(reserves, "none"), null);
  });
});

describe("ETH liquidity", () => {
  it("doubles the WETH side, whichever side that is", () => {
    assert.equal(ethLiquidityOf({ reserve0: 3n * ETH, reserve1: 1n }, "token0"), 6n * ETH);
    assert.equal(ethLiquidityOf({ reserve0: 1n, reserve1: 3n * ETH }, "token1"), 6n * ETH);
  });

  it("returns null for a token/token pair rather than zero", () => {
    // "Not denominated in ETH" is not "holds no ETH".
    assert.equal(ethLiquidityOf({ reserve0: 9n, reserve1: 9n }, "none"), null);
  });

  it("is zero when the WETH side is genuinely empty", () => {
    assert.equal(ethLiquidityOf({ reserve0: 0n, reserve1: 5n }, "token0"), 0n);
  });
});

describe("price from reserves", () => {
  it("prices one whole token in the quote asset", () => {
    // 100 tokens (18dp) against 5 WETH => 0.05 WETH per token.
    const price = priceInQuoteWei(100n * ETH, 18, 5n * ETH);
    assert.equal(price, ETH / 20n);
  });

  it("respects a token's own decimals", () => {
    // 100 tokens at 6dp against 5 WETH is the same price as at 18dp.
    const six = priceInQuoteWei(100n * 10n ** 6n, 6, 5n * ETH);
    assert.equal(six, ETH / 20n);
  });

  it("returns null for zero reserves instead of dividing", () => {
    assert.equal(priceInQuoteWei(0n, 18, 5n * ETH), null);
    assert.equal(priceInQuoteWei(100n * ETH, 18, 0n), null);
  });

  it("prices the non-WETH token when WETH is token1", () => {
    const result = poolPrice({ reserve0: 100n * ETH, reserve1: 5n * ETH }, "token1", 18, null);
    assert.equal(result.tokenInWethWei, ETH / 20n);
  });

  it("gives no price at all for a token/token pair", () => {
    const result = poolPrice({ reserve0: 100n * ETH, reserve1: 5n * ETH }, "none", 18, null);
    assert.equal(result.tokenInWethWei, null);
    assert.equal(result.usdCents, null);
  });

  it("converts to USD only when an oracle reading is supplied", () => {
    const reserves = { reserve0: 5n * ETH, reserve1: 100n * ETH };
    // 0.05 WETH per token at $2,000/ETH = $100.00 = 10,000 cents.
    const withOracle = poolPrice(reserves, "token0", 18, { answer: 2_000n * 10n ** 8n, decimals: 8 });
    assert.equal(withOracle.usdCents, 10_000n);

    const withoutOracle = poolPrice(reserves, "token0", 18, null);
    assert.equal(withoutOracle.tokenInWethWei, ETH / 20n);
    assert.equal(withoutOracle.usdCents, null);
  });

  it("refuses a USD price from a non-positive oracle answer", () => {
    const result = poolPrice({ reserve0: 5n * ETH, reserve1: 100n * ETH }, "token0", 18, {
      answer: 0n,
      decimals: 8,
    });
    assert.equal(result.usdCents, null);
  });

  it("keeps very small liquidity exact rather than rounding to nothing", () => {
    const price = priceInQuoteWei(1_000_000n, 18, 1n);
    assert.equal(price, 10n ** 12n);
  });
});

describe("per-pool window totals", () => {
  const week = starts(168);

  it("sums volume, swaps and transactions for the pool", () => {
    const totals = totalPoolWindow(
      mapOf(week.map((s) => bucket(s, { volumeWei: ETH, swaps: 2, transactions: 1, liquidityWei: 100n * ETH }))),
      week,
      HOUR,
    );
    assert.equal(totals.volumeWei, 168n * ETH);
    assert.equal(totals.swaps, 336);
    assert.equal(totals.transactions, 168);
  });

  it("applies the same 0.30% fee rule as the global series", () => {
    const totals = totalPoolWindow(
      mapOf(week.map((s) => bucket(s, { volumeWei: 1_000n, liquidityWei: ETH }))),
      week,
      HOUR,
    );
    assert.equal(totals.feesWei, (168_000n * 3n) / 1_000n);
  });

  it("computes APR from this pool's own fees and liquidity", () => {
    // 1 ETH of fees on 100 ETH over 7 days: 0.01 x (365/7) x 100 = 52.142857%.
    const volumePerHour = (1_000n * ETH) / 3n / 168n; // fees ~= 1 ETH across the window
    const totals = totalPoolWindow(
      mapOf(week.map((s) => bucket(s, { volumeWei: volumePerHour, liquidityWei: 100n * ETH }))),
      week,
      HOUR,
    );
    assert.equal(totals.aprReason, "ok");
    const percent = Number(totals.aprScaled) / Number(APR_SCALE);
    assert.equal(Math.abs(percent - 52.142857) < 0.01, true);
  });

  it("withholds APR when volume coverage is incomplete", () => {
    const partial = week.slice(0, 100);
    const totals = totalPoolWindow(
      mapOf(partial.map((s) => bucket(s, { volumeWei: ETH, liquidityWei: ETH }))),
      week,
      HOUR,
    );
    assert.equal(totals.aprScaled, null);
    assert.equal(totals.aprReason, "volume-incomplete");
    assert.equal(totals.bucketsPresent, 100);
    assert.equal(totals.bucketsExpected, 168);
  });

  it("withholds APR when liquidity coverage is incomplete", () => {
    // Every hour present, but some have no observed liquidity.
    const buckets = week.map((s, i) =>
      bucket(s, { volumeWei: ETH, liquidityWei: i < 100 ? ETH : null }),
    );
    const totals = totalPoolWindow(mapOf(buckets), week, HOUR);
    assert.equal(totals.aprScaled, null);
    assert.equal(totals.aprReason, "liquidity-incomplete");
    assert.equal(totals.liquidityPoints, 100);
  });

  it("never treats a missing hour as a zero hour", () => {
    const half = week.slice(0, 84);
    const totals = totalPoolWindow(
      mapOf(half.map((s) => bucket(s, { volumeWei: ETH, liquidityWei: ETH }))),
      week,
      HOUR,
    );
    // The sum is real but the window is not, and only the coverage says so.
    assert.equal(totals.volumeWei, 84n * ETH);
    assert.equal(totals.volumeComplete, false);
  });

  it("reports zero volume as a genuine zero when every hour is present", () => {
    const totals = totalPoolWindow(
      mapOf(week.map((s) => bucket(s, { volumeWei: 0n, liquidityWei: 100n * ETH }))),
      week,
      HOUR,
    );
    assert.equal(totals.volumeWei, 0n);
    assert.equal(totals.feesWei, 0n);
    assert.equal(totals.aprScaled, 0n);
    assert.equal(totals.aprReason, "ok");
  });

  it("withholds APR when the pool held no liquidity at all", () => {
    const totals = totalPoolWindow(
      mapOf(week.map((s) => bucket(s, { volumeWei: ETH, liquidityWei: 0n }))),
      week,
      HOUR,
    );
    assert.equal(totals.aprScaled, null);
    assert.equal(totals.aprReason, "zero-liquidity");
  });

  it("handles a 30D window independently of a 7D one", () => {
    /*
      Trading concentrated in the final week over liquidity held all month. The 7D window
      sees all of the volume against that week's liquidity; the 30D window sees the same
      volume spread over four times the period, so its rate must be lower.

      (With uniform volume and liquidity the two windows agree exactly, and correctly so:
      a constant rate annualizes to the same figure whatever window measures it.)
    */
    const month = starts(720);
    const lastWeek = new Set(month.slice(-168));
    const buckets = mapOf(
      month.map((s) =>
        bucket(s, { volumeWei: lastWeek.has(s) ? ETH : 0n, liquidityWei: 100n * ETH }),
      ),
    );

    const weekTotals = totalPoolWindow(buckets, month.slice(-168), HOUR);
    const monthTotals = totalPoolWindow(buckets, month, HOUR);

    assert.equal(weekTotals.volumeWei, 168n * ETH);
    assert.equal(monthTotals.volumeWei, 168n * ETH);
    assert.equal(weekTotals.aprScaled !== null && monthTotals.aprScaled !== null, true);
    // Same fees, same average liquidity, but spread over 30 days instead of 7.
    assert.equal((monthTotals.aprScaled ?? 0n) < (weekTotals.aprScaled ?? 0n), true);
  });

  it("gives the same APR for both windows when the rate is genuinely constant", () => {
    const month = starts(720);
    const buckets = mapOf(month.map((s) => bucket(s, { volumeWei: ETH, liquidityWei: 100n * ETH })));
    const weekTotals = totalPoolWindow(buckets, month.slice(-168), HOUR);
    const monthTotals = totalPoolWindow(buckets, month, HOUR);
    assert.equal(weekTotals.volumeWei, 168n * ETH);
    assert.equal(monthTotals.volumeWei, 720n * ETH);
    assert.equal(weekTotals.aprScaled, monthTotals.aprScaled);
  });

  it("keeps a very large volume exact", () => {
    const huge = 10n ** 30n;
    const totals = totalPoolWindow(
      mapOf(week.map((s) => bucket(s, { volumeWei: huge, liquidityWei: ETH }))),
      week,
      HOUR,
    );
    assert.equal(totals.volumeWei, 168n * huge);
    // A double would have collapsed this long before here.
    assert.equal(totals.volumeWei > BigInt(Number.MAX_SAFE_INTEGER), true);
  });

  it("is deterministic regardless of insertion order", () => {
    const entries = week.map((s, i) => bucket(s, { volumeWei: BigInt(i + 1), liquidityWei: ETH }));
    const forward = totalPoolWindow(mapOf(entries), week, HOUR);
    const reversed = totalPoolWindow(mapOf([...entries].reverse()), week, HOUR);
    assert.equal(forward.volumeWei, reversed.volumeWei);
    assert.equal(forward.aprScaled, reversed.aprScaled);
  });

  it("returns an incomplete window for a pool with no data", () => {
    const totals = totalPoolWindow(new Map(), week, HOUR);
    assert.equal(totals.volumeWei, 0n);
    assert.equal(totals.aprScaled, null);
    assert.equal(totals.volumeComplete, false);
  });
});

describe("pool creation and window overlap", () => {
  const week = starts(168);

  it("detects a pool created during the window", () => {
    const creation = { blockNumber: 1, timestamp: week[80]!, fromPairCreated: true };
    assert.equal(windowPredatesPool(week, creation), true);
  });

  it("accepts a pool that predates the window", () => {
    const creation = { blockNumber: 1, timestamp: week[0]! - 10 * HOUR, fromPairCreated: true };
    assert.equal(windowPredatesPool(week, creation), false);
  });

  it("detects a pool created after the window started", () => {
    const creation = { blockNumber: 1, timestamp: week[167]! + HOUR, fromPairCreated: true };
    assert.equal(windowPredatesPool(week, creation), true);
  });

  it("reports nothing when creation is unknown", () => {
    assert.equal(windowPredatesPool(week, null), false);
  });

  it("flags inferred creation separately from PairCreated", () => {
    const inferred = { blockNumber: 1, timestamp: week[0]!, fromPairCreated: false };
    assert.equal(inferred.fromPairCreated, false);
  });
});

describe("pool timeframes", () => {
  it("offers 1H, 24H, 7D and 30D", () => {
    assert.deepEqual(Object.keys(POOL_TIMEFRAME_HOURS), ["1H", "24H", "7D", "30D"]);
  });

  it("asks for exactly as many hourly buckets as the frame names", () => {
    const now = T0 + 1_000 * HOUR + 1_234;
    for (const [frame, hours] of Object.entries(POOL_TIMEFRAME_HOURS)) {
      const found = poolWindowStarts(now, frame as keyof typeof POOL_TIMEFRAME_HOURS);
      assert.equal(found.length, hours, frame);
    }
  });

  it("ends at the last complete hour, never the one still filling", () => {
    const now = T0 + 1_000 * HOUR + 1_234;
    const day = poolWindowStarts(now, "24H");
    const currentHour = now - (now % HOUR);
    assert.equal(day[day.length - 1], currentHour - HOUR);
  });

  it("nests: every 24H hour is also a 7D hour", () => {
    const now = T0 + 1_000 * HOUR;
    const day = new Set(poolWindowStarts(now, "24H"));
    const week = new Set(poolWindowStarts(now, "7D"));
    for (const hour of day) assert.equal(week.has(hour), true);
  });
});

describe("series shaping", () => {
  const point = (
    startTimestamp: number,
    volumeWei: bigint,
    liquidityWei: bigint | null,
    swaps = 1,
    transactions = 1,
  ) => ({
    startTimestamp,
    volumeWei: volumeWei.toString(),
    liquidityWei: liquidityWei === null ? null : liquidityWei.toString(),
    swaps,
    transactions,
  });

  const creationAt = (timestamp: number) => ({
    blockNumber: 1,
    timestamp,
    fromPairCreated: true,
  });

  it("drops liquidity from hours before the pool existed", () => {
    const points = [
      point(T0, 0n, 0n),
      point(T0 + HOUR, 0n, 0n),
      point(T0 + 2 * HOUR, ETH, 5n * ETH),
    ];
    const masked = maskPreCreation(points, creationAt(T0 + 2 * HOUR + 60));
    assert.deepEqual(
      masked.map((p) => p.liquidityWei),
      [null, null, (5n * ETH).toString()],
    );
  });

  it("keeps the creation hour itself, which the pool did live through", () => {
    const points = [point(T0, 0n, 0n), point(T0 + HOUR, 0n, 3n * ETH)];
    // Created 30 minutes into the second hour: that hour is the pool's own.
    const masked = maskPreCreation(points, creationAt(T0 + HOUR + 1_800));
    assert.equal(masked[1]?.liquidityWei, (3n * ETH).toString());
  });

  it("never touches volume, which is genuinely zero before a pool exists", () => {
    const points = [point(T0, 0n, 0n), point(T0 + HOUR, 7n * ETH, ETH)];
    const masked = maskPreCreation(points, creationAt(T0 + HOUR));
    assert.deepEqual(
      masked.map((p) => p.volumeWei),
      ["0", (7n * ETH).toString()],
    );
  });

  it("leaves the series alone when creation is unknown", () => {
    const points = [point(T0, 0n, 0n), point(T0 + HOUR, ETH, ETH)];
    assert.deepEqual(maskPreCreation(points, null), points);
  });

  it("sums volume and swaps when grouping, because both are sums", () => {
    const points = [
      point(T0, ETH, ETH, 2, 2),
      point(T0 + HOUR, 2n * ETH, 2n * ETH, 3, 3),
    ];
    const grouped = groupPoolPoints(points, 2);
    assert.equal(grouped.length, 1);
    assert.equal(grouped[0]?.volumeWei, (3n * ETH).toString());
    assert.equal(grouped[0]?.swaps, 5);
    assert.equal(grouped[0]?.transactions, 5);
  });

  it("takes the group's closing liquidity, not its average", () => {
    const points = [
      point(T0, 0n, 10n * ETH),
      point(T0 + HOUR, 0n, 2n * ETH),
    ];
    const grouped = groupPoolPoints(points, 2);
    // An average would report 6 ETH, a level the pool never held.
    assert.equal(grouped[0]?.liquidityWei, (2n * ETH).toString());
  });

  it("carries a gap through grouping rather than smoothing it away", () => {
    const points = [point(T0, 0n, null), point(T0 + HOUR, 0n, null)];
    assert.equal(groupPoolPoints(points, 2)[0]?.liquidityWei, null);
  });

  it("keeps a group's last real reading when only part of it is a gap", () => {
    const points = [point(T0, 0n, 4n * ETH), point(T0 + HOUR, 0n, null)];
    assert.equal(groupPoolPoints(points, 2)[0]?.liquidityWei, (4n * ETH).toString());
  });

  it("returns the series unchanged when there is nothing to group", () => {
    const points = [point(T0, ETH, ETH)];
    assert.deepEqual(groupPoolPoints(points, 1), points);
  });

  it("takes the most recent observed liquidity, skipping trailing gaps", () => {
    const points = [
      point(T0, 0n, 9n * ETH),
      point(T0 + HOUR, 0n, null),
      point(T0 + 2 * HOUR, 0n, null),
    ];
    assert.equal(latestObservedLiquidity(points), (9n * ETH).toString());
  });

  it("reports nothing when no hour was ever observed", () => {
    assert.equal(latestObservedLiquidity([point(T0, 0n, null)]), null);
  });

  it("distinguishes an observed zero from an unobserved hour", () => {
    assert.equal(latestObservedLiquidity([point(T0, 0n, 0n)]), "0");
    assert.equal(latestObservedLiquidity([point(T0, 0n, null)]), null);
  });
});