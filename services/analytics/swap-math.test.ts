import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  aggregateWethVolume,
  bucketOf,
  bucketRangeCovered,
  bucketTotalsFrom,
  needsReconciliation,
  reconciliationTargets,
  decodeSwapData,
  FEE_DENOMINATOR,
  FEE_NUMERATOR,
  tradingFeesWei,
  wethAmountOfSwap,
  type WethSide,
} from "@/services/analytics/swap-math";

/*
  A real Swap log read from Robinhood Chain mainnet on 2026-09-17, pair
  0xca86742cfed90f9e3d68ec2e76a94da3f8c197d8 at block 65,441,757.
  0.030222 WETH in, token out — WETH is token0 on that pair.
*/
const LIVE_SWAP_DATA =
  "0x000000000000000000000000000000000000000000000000006b5ebfb666e000" +
  "0000000000000000000000000000000000000000000000000000000000000000" +
  "0000000000000000000000000000000000000000000000000000000000000000" +
  "000000000000000000000000000000000000000000048a1ef3f7c3cc867377e7";

const LIVE_PAIR = "0xca86742cfed90f9e3d68ec2e76a94da3f8c197d8";
const WETH_IN = 30_222_000_000_000_000n; // 0.030222 ETH

/** Builds a Swap data field from four amounts. */
function encodeSwap(a0In: bigint, a1In: bigint, a0Out: bigint, a1Out: bigint): string {
  const word = (v: bigint) => v.toString(16).padStart(64, "0");
  return `0x${word(a0In)}${word(a1In)}${word(a0Out)}${word(a1Out)}`;
}

describe("decodeSwapData", () => {
  it("decodes a real mainnet Swap log", () => {
    const decoded = decodeSwapData(LIVE_SWAP_DATA);
    assert.ok(decoded);
    assert.equal(decoded.amount0In, WETH_IN);
    assert.equal(decoded.amount1In, 0n);
    assert.equal(decoded.amount0Out, 0n);
    assert.equal(decoded.amount1Out, 5_487_960_835_151_692_685_342_695n);
  });

  it("round-trips through the encoder", () => {
    const decoded = decodeSwapData(encodeSwap(1n, 2n, 3n, 4n));
    assert.deepEqual(decoded, { amount0In: 1n, amount1In: 2n, amount0Out: 3n, amount1Out: 4n });
  });

  it("returns null for malformed input instead of throwing", () => {
    for (const bad of [
      "",
      "0x",
      "not hex",
      "0xzz",
      `0x${"0".repeat(255)}`, // one character short
      `0x${"0".repeat(257)}`, // one character long
      `0x${"g".repeat(256)}`, // non-hex characters
    ]) {
      assert.equal(decodeSwapData(bad), null, `expected null for ${JSON.stringify(bad.slice(0, 16))}`);
    }
    assert.equal(decodeSwapData(undefined as unknown as string), null);
  });
});

describe("wethAmountOfSwap", () => {
  const buyWeth = { amount0In: 0n, amount1In: 500n, amount0Out: 100n, amount1Out: 0n };
  const sellWeth = { amount0In: 100n, amount1In: 0n, amount0Out: 0n, amount1Out: 500n };

  it("takes the WETH side whichever direction the trade went", () => {
    // WETH is token0: 100 crosses the pool either way.
    assert.equal(wethAmountOfSwap(buyWeth, "token0"), 100n);
    assert.equal(wethAmountOfSwap(sellWeth, "token0"), 100n);
  });

  it("reads the other side when WETH is token1", () => {
    assert.equal(wethAmountOfSwap(buyWeth, "token1"), 500n);
    assert.equal(wethAmountOfSwap(sellWeth, "token1"), 500n);
  });

  it("contributes nothing for a pair without a WETH side", () => {
    assert.equal(wethAmountOfSwap(buyWeth, "none"), 0n);
    assert.equal(wethAmountOfSwap(sellWeth, "none"), 0n);
  });

  it("matches the live log when applied through the decoder", () => {
    const decoded = decodeSwapData(LIVE_SWAP_DATA);
    assert.ok(decoded);
    assert.equal(wethAmountOfSwap(decoded, "token0"), WETH_IN);
    // The same log on a hypothetical token1 pairing would read the token side instead.
    assert.equal(wethAmountOfSwap(decoded, "token1"), 5_487_960_835_151_692_685_342_695n);
  });
});

describe("aggregateWethVolume", () => {
  const sides: Record<string, WethSide> = {
    "0xaaa": "token0",
    "0xbbb": "token1",
    "0xccc": "none", // a token/token pair
  };
  const sideOf = (pair: string) => sides[pair];

  it("sums only the WETH side across a batch", () => {
    const result = aggregateWethVolume(
      [
        { address: "0xAAA", data: encodeSwap(10n, 0n, 0n, 999n) }, // 10 WETH in
        { address: "0xaaa", data: encodeSwap(0n, 999n, 5n, 0n) }, //  5 WETH out
        { address: "0xbbb", data: encodeSwap(0n, 7n, 999n, 0n) }, //  7 WETH in (token1)
      ],
      sideOf,
    );
    assert.equal(result.volumeWei, 22n);
    assert.equal(result.counted, 3);
    assert.equal(result.ignoredNonWeth, 0);
  });

  it("ignores token/token pairs rather than guessing their value", () => {
    const result = aggregateWethVolume(
      [
        { address: "0xaaa", data: encodeSwap(10n, 0n, 0n, 1n) },
        { address: "0xccc", data: encodeSwap(500n, 0n, 0n, 900n) }, // must not count
        { address: "0xccc", data: encodeSwap(0n, 800n, 700n, 0n) },
      ],
      sideOf,
    );
    assert.equal(result.volumeWei, 10n);
    assert.equal(result.counted, 1);
    assert.equal(result.ignoredNonWeth, 2);
  });

  it("reports unclassified pairs separately and never counts them", () => {
    const result = aggregateWethVolume(
      [
        { address: "0xaaa", data: encodeSwap(10n, 0n, 0n, 1n) },
        { address: "0xunknown", data: encodeSwap(9_999n, 0n, 0n, 1n) },
      ],
      sideOf,
    );
    assert.equal(result.volumeWei, 10n);
    assert.equal(result.unresolvedPairs, 1);
    assert.equal(result.counted, 1);
  });

  it("counts the live mainnet log end to end", () => {
    const result = aggregateWethVolume([{ address: LIVE_PAIR, data: LIVE_SWAP_DATA }], (pair) =>
      pair === LIVE_PAIR ? "token0" : undefined,
    );
    assert.equal(result.volumeWei, WETH_IN);
    assert.equal(result.counted, 1);
    // 0.030222 ETH of volume implies 0.000090666 ETH of fees.
    assert.equal(tradingFeesWei(result.volumeWei), 90_666_000_000_000n);
  });

  it("survives an undecodable log without losing the rest of the batch", () => {
    const result = aggregateWethVolume(
      [
        { address: "0xaaa", data: "0xdeadbeef" },
        { address: "0xaaa", data: encodeSwap(4n, 0n, 0n, 1n) },
      ],
      sideOf,
    );
    assert.equal(result.volumeWei, 4n);
    assert.equal(result.undecodable, 1);
    assert.equal(result.counted, 1);
  });

  it("returns a zeroed result for an empty batch", () => {
    const result = aggregateWethVolume([], sideOf);
    assert.equal(result.volumeWei, 0n);
    assert.equal(result.counted, 0);
  });

  it("aggregates a 24h-sized batch without overflow", () => {
    // 117,006 swaps was the measured 24h count; each of 1 ETH keeps the maths honest.
    const one = encodeSwap(10n ** 18n, 0n, 0n, 1n);
    const logs = Array.from({ length: 117_006 }, () => ({ address: "0xaaa", data: one }));
    const result = aggregateWethVolume(logs, sideOf);
    assert.equal(result.counted, 117_006);
    assert.equal(result.volumeWei, 117_006n * 10n ** 18n);
  });
});

describe("tradingFeesWei", () => {
  it("takes 0.30% of volume", () => {
    assert.equal(FEE_NUMERATOR, 3n);
    assert.equal(FEE_DENOMINATOR, 1_000n);
    assert.equal(tradingFeesWei(1_000n), 3n);
    assert.equal(tradingFeesWei(10n ** 18n), 3n * 10n ** 15n); // 1 ETH -> 0.003 ETH
  });

  it("never invents a fee from absent volume", () => {
    assert.equal(tradingFeesWei(0n), 0n);
    assert.equal(tradingFeesWei(-5n), 0n);
  });

  it("floors rather than rounds up, so fees are never overstated", () => {
    assert.equal(tradingFeesWei(1n), 0n);
    assert.equal(tradingFeesWei(999n), 2n); // 2.997 -> 2
  });

  it("holds at the measured 24h scale", () => {
    const volume = 4_000n * 10n ** 18n;
    assert.equal(tradingFeesWei(volume), 12n * 10n ** 18n); // 4,000 ETH -> 12 ETH
  });
});

describe("bucketOf", () => {
  it("groups blocks into fixed windows for ageing out", () => {
    assert.equal(bucketOf(65_441_757, 7_200), 65_440_800);
    assert.equal(bucketOf(65_440_800, 7_200), 65_440_800);
    assert.equal(bucketOf(65_440_799, 7_200), 65_433_600);
    assert.equal(bucketOf(0, 7_200), 0);
  });
});

describe("reconciling a bucket whose pairs were not yet classified", () => {
  /*
    The regression this guards: a pair whose classification read was refused leaves its
    swaps unattributed, the bucket is persisted as a floor, and nothing ever goes back for
    it. The repair re-reads the range and REPLACES the totals, which is only safe because
    totals depend on the logs and the classification map and on nothing else.
  */
  const PAIR_A = "0xaaaa000000000000000000000000000000000001";
  const PAIR_B = "0xbbbb000000000000000000000000000000000002";
  const PAIR_TT = "0xcccc000000000000000000000000000000000003";

  /** One WETH-in swap of `amount` wei on `pair`. */
  const swap = (pair: string, amount: bigint) => ({
    address: pair,
    data:
      "0x" +
      amount.toString(16).padStart(64, "0") +
      "0".repeat(64) +
      "0".repeat(64) +
      "0".repeat(64),
  });

  const logs = [swap(PAIR_A, 10n), swap(PAIR_B, 20n), swap(PAIR_TT, 30n)];

  const sides = (map: Record<string, WethSide>) => (pair: string) => map[pair.toLowerCase()];

  const NONE_KNOWN = sides({});
  const A_ONLY = sides({ [PAIR_A]: "token0" });
  const ALL_KNOWN = sides({ [PAIR_A]: "token0", [PAIR_B]: "token0", [PAIR_TT]: "none" });

  it("records swaps as unattributed while their pair is unknown", () => {
    const totals = bucketTotalsFrom(logs, NONE_KNOWN);
    assert.equal(totals.swaps, 0);
    assert.equal(totals.volumeWei, 0n);
    assert.equal(totals.unresolvedSwaps, 3);
  });

  it("counts an unresolved pair once it becomes classified", () => {
    const before = bucketTotalsFrom(logs, NONE_KNOWN);
    const after = bucketTotalsFrom(logs, ALL_KNOWN);

    assert.equal(before.swaps, 0);
    assert.equal(after.swaps, 2); // the token/token pair is excluded by design
    assert.equal(after.volumeWei, 30n);
    assert.equal(after.unresolvedSwaps, 0);
    assert.equal(after.ignoredNonWeth, 1);
  });

  it("handles several unresolved pairs resolving at different times", () => {
    const partial = bucketTotalsFrom(logs, A_ONLY);
    assert.equal(partial.swaps, 1);
    assert.equal(partial.volumeWei, 10n);
    assert.equal(partial.unresolvedSwaps, 2);

    const full = bucketTotalsFrom(logs, ALL_KNOWN);
    assert.equal(full.swaps, 2);
    assert.equal(full.volumeWei, 30n);
    assert.equal(full.unresolvedSwaps, 0);
  });

  it("is idempotent: reconciling twice changes nothing", () => {
    const once = bucketTotalsFrom(logs, ALL_KNOWN);
    const twice = bucketTotalsFrom(logs, ALL_KNOWN);
    assert.deepEqual(twice, once);
  });

  it("cannot double-count, because totals never read the previous value", () => {
    // Replacing a stored bucket with this result is the whole operation; there is no
    // accumulator for a second pass to add to.
    const stored = { volumeWei: 10n, swaps: 1, ignoredNonWeth: 0, unresolvedSwaps: 2 };
    const recomputed = bucketTotalsFrom(logs, ALL_KNOWN);
    assert.equal(recomputed.volumeWei, 30n);
    assert.notEqual(recomputed.volumeWei, stored.volumeWei + 30n);
  });

  it("leaves a fully resolved bucket exactly as it was", () => {
    const first = bucketTotalsFrom(logs, ALL_KNOWN);
    assert.equal(first.unresolvedSwaps, 0);
    assert.deepEqual(bucketTotalsFrom(logs, ALL_KNOWN), first);
  });

  it("survives a persistence round trip", () => {
    // The store keeps wei as a decimal string; reloading must reproduce the same totals.
    const totals = bucketTotalsFrom(logs, ALL_KNOWN);
    const persisted = JSON.parse(
      JSON.stringify({ ...totals, volumeWei: totals.volumeWei.toString() }),
    ) as { volumeWei: string; swaps: number; ignoredNonWeth: number; unresolvedSwaps: number };

    assert.deepEqual({ ...persisted, volumeWei: BigInt(persisted.volumeWei) }, totals);
  });

  it("treats an undecodable log as unattributed, not as zero volume", () => {
    const broken = [{ address: PAIR_A, data: "0xdeadbeef" }];
    const totals = bucketTotalsFrom(broken, ALL_KNOWN);
    assert.equal(totals.unresolvedSwaps, 1);
    assert.equal(totals.swaps, 0);
  });

  it("produces empty totals for an empty range rather than throwing", () => {
    const totals = bucketTotalsFrom([], ALL_KNOWN);
    assert.deepEqual(totals, { volumeWei: 0n, swaps: 0, ignoredNonWeth: 0, unresolvedSwaps: 0 });
  });
});

describe("choosing which buckets to reconcile", () => {
  const SIZE = 7_200;

  it("only considers a bucket whose whole range has been ingested", () => {
    assert.equal(bucketRangeCovered(14_400, SIZE, 14_400, 21_600), true);
    // The newest bucket is still filling forwards.
    assert.equal(bucketRangeCovered(14_400, SIZE, 14_400, 18_000), false);
    // The oldest is only half covered by the backward walk.
    assert.equal(bucketRangeCovered(14_400, SIZE, 16_000, 21_600), false);
  });

  it("skips a bucket with nothing unattributed", () => {
    assert.equal(needsReconciliation({ unresolvedSwaps: 0 }, 14_400, SIZE, 0, 100_000), false);
  });

  it("selects a bucket that has unattributed swaps and is fully covered", () => {
    assert.equal(needsReconciliation({ unresolvedSwaps: 5 }, 14_400, SIZE, 0, 100_000), true);
  });

  it("refuses a partially covered bucket even when it has unattributed swaps", () => {
    // Replacing it with a partial re-read would trade one undercount for another.
    assert.equal(needsReconciliation({ unresolvedSwaps: 5 }, 14_400, SIZE, 0, 18_000), false);
  });

  it("picks the oldest first, so a bucket about to age out is repaired before it is lost", () => {
    const buckets = new Map([
      [28_800, { unresolvedSwaps: 9 }],
      [14_400, { unresolvedSwaps: 1 }],
      [21_600, { unresolvedSwaps: 4 }],
    ]);
    assert.deepEqual(reconciliationTargets(buckets, SIZE, 0, 100_000, 10), [14_400, 21_600, 28_800]);
  });

  it("is bounded, so reconciliation cannot starve the forward catch-up", () => {
    const buckets = new Map([
      [14_400, { unresolvedSwaps: 1 }],
      [21_600, { unresolvedSwaps: 1 }],
      [28_800, { unresolvedSwaps: 1 }],
    ]);
    assert.deepEqual(reconciliationTargets(buckets, SIZE, 0, 100_000, 2), [14_400, 21_600]);
    assert.deepEqual(reconciliationTargets(buckets, SIZE, 0, 100_000, 0), []);
  });

  it("is deterministic: the same state selects the same work", () => {
    const buckets = new Map([
      [21_600, { unresolvedSwaps: 4 }],
      [14_400, { unresolvedSwaps: 1 }],
    ]);
    assert.deepEqual(
      reconciliationTargets(buckets, SIZE, 0, 100_000, 5),
      reconciliationTargets(buckets, SIZE, 0, 100_000, 5),
    );
  });

  it("excludes the boundary buckets and keeps the ones between them", () => {
    // tail and head cut the oldest and newest; everything whole in between is eligible.
    const buckets = new Map([
      [7_200, { unresolvedSwaps: 3 }],
      [14_400, { unresolvedSwaps: 3 }],
      [21_600, { unresolvedSwaps: 3 }],
    ]);
    assert.deepEqual(reconciliationTargets(buckets, SIZE, 10_000, 25_000, 10), [14_400]);
  });

  it("returns nothing when every bucket is fully attributed", () => {
    const buckets = new Map([[14_400, { unresolvedSwaps: 0 }]]);
    assert.deepEqual(reconciliationTargets(buckets, SIZE, 0, 100_000, 5), []);
  });
});