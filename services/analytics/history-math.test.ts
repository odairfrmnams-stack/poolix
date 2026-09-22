import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BUCKET_SECONDS,
  bucketStartFor,
  DAY_SECONDS,
  estimateBlockAt,
  findRangeFaults,
  retainedStarts,
  toSeries,
  totalWindow,
  windowBuckets,
  type HistoryBucket,
} from "@/services/analytics/history-math";
import { aggregateWethVolume, tradingFeesWei, type WethSide } from "@/services/analytics/swap-math";

const HOUR = BUCKET_SECONDS;
/** A round hour boundary, so arithmetic in the assertions stays readable. */
const T0 = 1_700_000_000 - (1_700_000_000 % HOUR);

const bucket = (start: number, volumeWei: bigint, swaps = 1, from = 0, to = 0): HistoryBucket => ({
  startTimestamp: start,
  endTimestamp: start + HOUR,
  fromBlock: from,
  toBlock: to,
  volumeWei,
  swaps,
  ignoredNonWeth: 0,
  unresolvedSwaps: 0,
});

const mapOf = (list: readonly HistoryBucket[]) =>
  new Map(list.map((entry) => [entry.startTimestamp, entry]));

describe("bucket boundaries", () => {
  it("floors a timestamp to its hour", () => {
    assert.equal(bucketStartFor(T0), T0);
    assert.equal(bucketStartFor(T0 + 1), T0);
    assert.equal(bucketStartFor(T0 + HOUR - 1), T0);
    assert.equal(bucketStartFor(T0 + HOUR), T0 + HOUR);
  });

  it("puts a timestamp exactly on a boundary in the later bucket", () => {
    // Ranges are half-open, so the boundary second belongs to the hour it opens.
    assert.equal(bucketStartFor(T0 + HOUR), T0 + HOUR);
    assert.notEqual(bucketStartFor(T0 + HOUR), T0);
  });

  it("asks for 168 hours over 7 days and 720 over 30", () => {
    assert.equal(windowBuckets(T0, 7).length, 168);
    assert.equal(windowBuckets(T0, 30).length, 720);
  });

  it("ends at the last complete hour, never the one still filling", () => {
    const starts = windowBuckets(T0 + HOUR + 900, 7);
    const last = starts[starts.length - 1];
    // Now is 15 minutes into the hour starting at T0+HOUR, so that hour is excluded.
    assert.equal(last, T0);
  });

  it("returns buckets oldest first, contiguous, with no repeats", () => {
    const starts = windowBuckets(T0, 7);
    assert.equal(new Set(starts).size, starts.length);
    for (let index = 1; index < starts.length; index++) {
      assert.equal(starts[index]! - starts[index - 1]!, HOUR);
    }
    assert.equal(starts[starts.length - 1]! + HOUR, T0);
  });
});

describe("block estimation from timestamps", () => {
  it("projects forward and backward at the measured block time", () => {
    // 0.1007s per block, the rate measured on this chain.
    assert.equal(estimateBlockAt(T0 + 100.7, 1_000_000, T0, 0.1007), 1_001_000);
    assert.equal(estimateBlockAt(T0 - 100.7, 1_000_000, T0, 0.1007), 999_000);
  });

  it("never returns a negative block", () => {
    assert.equal(estimateBlockAt(T0 - 10_000_000, 100, T0, 0.1007), 0);
  });
});

describe("window totals", () => {
  it("sums only the buckets the window asks for", () => {
    const starts = windowBuckets(T0, 7);
    const inside = starts[0]!;
    const outside = starts[0]! - HOUR;
    const buckets = mapOf([bucket(inside, 10n), bucket(outside, 999n)]);

    const totals = totalWindow(buckets, starts);
    assert.equal(totals.volumeWei, 10n);
    assert.equal(totals.bucketsPresent, 1);
  });

  it("applies the same 0.30% fee rule as the 24h figure", () => {
    const starts = windowBuckets(T0, 7);
    const buckets = mapOf(starts.map((start) => bucket(start, 1_000n)));
    const totals = totalWindow(buckets, starts);

    assert.equal(totals.volumeWei, 168_000n);
    assert.equal(totals.feesWei, tradingFeesWei(168_000n));
    assert.equal(totals.feesWei, 504n); // 0.3% of 168,000
  });

  it("reports a fully covered window as complete", () => {
    const starts = windowBuckets(T0, 7);
    const totals = totalWindow(mapOf(starts.map((s) => bucket(s, 1n))), starts);
    assert.equal(totals.complete, true);
    assert.deepEqual(totals.missing, []);
  });

  it("never treats a missing bucket as zero volume", () => {
    // Four of seven days present: the total is real but the window is not, and saying
    // so is the whole point — a sum over holes looks identical to a quiet week.
    const starts = windowBuckets(T0, 7);
    const present = starts.slice(0, 96); // 4 days of hours
    const totals = totalWindow(mapOf(present.map((s) => bucket(s, 5n))), starts);

    assert.equal(totals.complete, false);
    assert.equal(totals.bucketsPresent, 96);
    assert.equal(totals.bucketsExpected, 168);
    assert.equal(totals.missing.length, 72);
    assert.equal(totals.volumeWei, 480n);
  });

  it("distinguishes an empty bucket from an absent one", () => {
    const starts = windowBuckets(T0, 7);
    const withZero = mapOf(starts.map((s) => bucket(s, 0n, 0)));
    const totals = totalWindow(withZero, starts);
    // A real hour with no trades: present, complete, and zero.
    assert.equal(totals.complete, true);
    assert.equal(totals.volumeWei, 0n);
    assert.equal(totals.bucketsPresent, 168);
  });

  it("returns an incomplete window for an empty store", () => {
    const starts = windowBuckets(T0, 30);
    const totals = totalWindow(new Map(), starts);
    assert.equal(totals.complete, false);
    assert.equal(totals.bucketsPresent, 0);
    assert.equal(totals.volumeWei, 0n);
  });

  it("is deterministic regardless of insertion order", () => {
    const starts = windowBuckets(T0, 7);
    const entries = starts.map((s, i) => bucket(s, BigInt(i + 1)));
    const forward = totalWindow(mapOf(entries), starts);
    const reversed = totalWindow(mapOf([...entries].reverse()), starts);
    assert.equal(forward.volumeWei, reversed.volumeWei);
    assert.equal(forward.swaps, reversed.swaps);
  });
});

describe("rolling window expiry", () => {
  it("drops a bucket once it ages past the window", () => {
    const starts = windowBuckets(T0, 7);
    const oldest = starts[0]!;
    const buckets = mapOf(starts.map((s) => bucket(s, 1n)));

    // One hour later the oldest bucket is no longer asked for.
    const later = windowBuckets(T0 + HOUR, 7);
    assert.equal(later.includes(oldest), false);
    assert.equal(totalWindow(buckets, later).bucketsPresent, 167);
  });

  it("keeps 30 days plus a buffer and no more", () => {
    const cutoff = retainedStarts(T0, 30, 6);
    assert.equal(cutoff, T0 - 30 * DAY_SECONDS - 6 * HOUR);
    // A bucket inside 30 days survives; one well outside does not.
    assert.equal(T0 - 29 * DAY_SECONDS > cutoff, true);
    assert.equal(T0 - 31 * DAY_SECONDS > cutoff, false);
  });
});

describe("chart series", () => {
  it("groups 30 days of hours into 30 daily points", () => {
    const starts = windowBuckets(T0, 30);
    const points = toSeries(mapOf(starts.map((s) => bucket(s, 1n))), starts, DAY_SECONDS);
    assert.equal(points.length, 30);
    const first = points[0];
    assert.notEqual(first, undefined);
    assert.equal(first?.volumeWei, 24n);
    assert.equal((first?.endTimestamp ?? 0) - (first?.startTimestamp ?? 0), DAY_SECONDS);
  });

  it("keeps 7 days at hourly resolution", () => {
    const starts = windowBuckets(T0, 7);
    const points = toSeries(mapOf(starts.map((s) => bucket(s, 2n))), starts, HOUR);
    assert.equal(points.length, 168);
    assert.equal(points[0]?.volumeWei, 2n);
  });

  it("flags a point whose hours are not all present", () => {
    const starts = windowBuckets(T0, 30);
    const partial = starts.filter((_, index) => index % 24 !== 0); // drop one hour a day
    const points = toSeries(mapOf(partial.map((s) => bucket(s, 1n))), starts, DAY_SECONDS);
    assert.equal(points.every((point) => !point.complete), true);
    assert.equal(points[0]?.volumeWei, 23n);
  });

  it("returns nothing for an empty window", () => {
    assert.deepEqual(toSeries(new Map(), [], DAY_SECONDS), []);
  });

  it("orders points oldest first", () => {
    const starts = windowBuckets(T0, 7);
    const points = toSeries(mapOf(starts.map((s) => bucket(s, 1n))), starts, DAY_SECONDS);
    for (let index = 1; index < points.length; index++) {
      assert.equal(points[index]!.startTimestamp > points[index - 1]!.startTimestamp, true);
    }
  });
});

describe("chunk boundaries", () => {
  it("accepts ranges that tile exactly", () => {
    const ranges = [
      { fromBlock: 0, toBlock: 100 },
      { fromBlock: 100, toBlock: 200 },
      { fromBlock: 200, toBlock: 350 },
    ];
    assert.deepEqual(findRangeFaults(ranges), { overlaps: 0, gaps: 0 });
  });

  it("detects an overlap, which would double-count swaps", () => {
    const ranges = [
      { fromBlock: 0, toBlock: 120 },
      { fromBlock: 100, toBlock: 200 },
    ];
    assert.equal(findRangeFaults(ranges).overlaps, 1);
  });

  it("detects a gap, which would drop swaps", () => {
    const ranges = [
      { fromBlock: 0, toBlock: 100 },
      { fromBlock: 140, toBlock: 200 },
    ];
    assert.equal(findRangeFaults(ranges).gaps, 1);
  });

  it("is order-independent", () => {
    const ranges = [
      { fromBlock: 200, toBlock: 300 },
      { fromBlock: 0, toBlock: 100 },
      { fromBlock: 100, toBlock: 200 },
    ];
    assert.deepEqual(findRangeFaults(ranges), { overlaps: 0, gaps: 0 });
  });
});

describe("volume definition matches the 24h window", () => {
  const WETH_PAIR = "0xaaaa000000000000000000000000000000000001";
  const TOKEN_PAIR = "0xbbbb000000000000000000000000000000000002";
  const sides = new Map<string, WethSide>([
    [WETH_PAIR, "token0"],
    [TOKEN_PAIR, "none"],
  ]);
  const word = (v: bigint) => v.toString(16).padStart(64, "0");
  const swapData = (a0In: bigint, a1In: bigint, a0Out: bigint, a1Out: bigint) =>
    `0x${word(a0In)}${word(a1In)}${word(a0Out)}${word(a1Out)}`;

  it("takes the ETH side of a swap, in or out", () => {
    const logs = [
      { address: WETH_PAIR, data: swapData(100n, 0n, 0n, 50n) },
      { address: WETH_PAIR, data: swapData(0n, 70n, 30n, 0n) },
    ];
    const result = aggregateWethVolume(logs, (pair) => sides.get(pair));
    assert.equal(result.volumeWei, 130n);
    assert.equal(result.counted, 2);
  });

  it("excludes token/token swaps from volume", () => {
    const logs = [
      { address: WETH_PAIR, data: swapData(100n, 0n, 0n, 50n) },
      { address: TOKEN_PAIR, data: swapData(900n, 0n, 0n, 900n) },
    ];
    const result = aggregateWethVolume(logs, (pair) => sides.get(pair));
    assert.equal(result.volumeWei, 100n);
    assert.equal(result.ignoredNonWeth, 1);
  });

  it("never counts a pair it has not classified", () => {
    const logs = [{ address: "0xcccc000000000000000000000000000000000003", data: swapData(1n, 0n, 0n, 1n) }];
    const result = aggregateWethVolume(logs, (pair) => sides.get(pair));
    assert.equal(result.volumeWei, 0n);
    assert.equal(result.unresolvedPairs, 1);
  });

  it("fees over a historical window equal 0.30% of its volume", () => {
    const starts = windowBuckets(T0, 7);
    const buckets = mapOf(starts.map((s) => bucket(s, 1_000_000_000_000_000_000n)));
    const totals = totalWindow(buckets, starts);
    assert.equal(totals.feesWei, (totals.volumeWei * 3n) / 1_000n);
  });
});
