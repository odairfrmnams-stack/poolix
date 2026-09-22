import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  aggregateWethLiquidity,
  buildSnapshots,
  BURN_TOPIC0,
  compareEvents,
  decodeAmounts,
  decodeSync,
  eventKey,
  MAX_UINT112,
  MINT_TOPIC0,
  orderEvents,
  reconstruct,
  SYNC_TOPIC0,
  type BucketBoundary,
  type PairEvent,
  type WethSide,
} from "@/services/analytics/liquidity-math";

const PAIR_A = "0xaaaa000000000000000000000000000000000001";
const PAIR_B = "0xbbbb000000000000000000000000000000000002";
/** Token/token pair: must never contribute to ETH liquidity. */
const PAIR_T = "0xcccc000000000000000000000000000000000003";

const word = (value: bigint) => value.toString(16).padStart(64, "0");
const twoWords = (a: bigint, b: bigint) => `0x${word(a)}${word(b)}`;

const sync = (pair: string, block: number, logIndex: number, r0: bigint, r1: bigint): PairEvent => ({
  pair,
  blockNumber: block,
  logIndex,
  topic0: SYNC_TOPIC0,
  data: twoWords(r0, r1),
});

const mint = (pair: string, block: number, logIndex: number, a0: bigint, a1: bigint): PairEvent => ({
  pair,
  blockNumber: block,
  logIndex,
  topic0: MINT_TOPIC0,
  data: twoWords(a0, a1),
});

const burn = (pair: string, block: number, logIndex: number, a0: bigint, a1: bigint): PairEvent => ({
  pair,
  blockNumber: block,
  logIndex,
  topic0: BURN_TOPIC0,
  data: twoWords(a0, a1),
});

const sides = new Map<string, WethSide>([
  [PAIR_A, "token0"],
  [PAIR_B, "token1"],
  [PAIR_T, "none"],
]);
const sideOf = (pair: string) => sides.get(pair);

const boundary = (startTimestamp: number, toBlock: number): BucketBoundary => ({ startTimestamp, toBlock });

describe("decoding", () => {
  it("reads absolute reserves from a Sync", () => {
    assert.deepEqual(decodeSync(twoWords(100n, 200n)), { reserve0: 100n, reserve1: 200n });
  });

  it("reads amounts from a Mint or Burn", () => {
    assert.deepEqual(decodeAmounts(twoWords(7n, 9n)), { amount0: 7n, amount1: 9n });
  });

  it("rejects a reserve above uint112, which cannot be real", () => {
    assert.equal(decodeSync(twoWords(MAX_UINT112 + 1n, 1n)), null);
    assert.notEqual(decodeSync(twoWords(MAX_UINT112, MAX_UINT112)), null);
  });

  it("returns null for malformed data instead of throwing", () => {
    assert.equal(decodeSync("0x"), null);
    assert.equal(decodeSync("0x1234"), null);
    assert.equal(decodeSync(`0x${"z".repeat(128)}`), null);
  });

  it("keeps a full uint112 exact", () => {
    const decoded = decodeSync(twoWords(MAX_UINT112, 1n));
    assert.equal(decoded?.reserve0, MAX_UINT112);
    // Why bigint: as a double this value collapses into its neighbour.
    assert.equal(Number(MAX_UINT112), Number(MAX_UINT112 - 1n));
  });
});

describe("event ordering", () => {
  it("orders by block, then by log index", () => {
    const events = [
      sync(PAIR_A, 10, 5, 1n, 1n),
      sync(PAIR_A, 9, 99, 2n, 2n),
      sync(PAIR_A, 10, 1, 3n, 3n),
    ];
    const ordered = orderEvents(events);
    assert.deepEqual(
      ordered.map((e) => [e.blockNumber, e.logIndex]),
      [[9, 99], [10, 1], [10, 5]],
    );
  });

  it("breaks a same-block tie by log index, never arbitrarily", () => {
    // Blocks here are ~0.1s apart and several share a timestamp, so log index is what
    // makes "last state before the boundary" deterministic.
    const a = sync(PAIR_A, 100, 2, 1n, 1n);
    const b = sync(PAIR_A, 100, 7, 2n, 2n);
    assert.equal(compareEvents(a, b) < 0, true);
    assert.equal(compareEvents(b, a) > 0, true);
  });

  it("is a total order, so reconstruction is deterministic", () => {
    const events = [
      sync(PAIR_A, 5, 3, 1n, 1n),
      sync(PAIR_A, 5, 1, 2n, 2n),
      sync(PAIR_A, 4, 9, 3n, 3n),
      sync(PAIR_A, 6, 0, 4n, 4n),
    ];
    const forward = orderEvents(events).map(eventKey);
    const shuffled = orderEvents([...events].reverse()).map(eventKey);
    assert.deepEqual(forward, shuffled);
  });
});

describe("reserve reconstruction", () => {
  it("takes the last Sync as absolute state", () => {
    const result = reconstruct([
      sync(PAIR_A, 1, 0, 100n, 200n),
      sync(PAIR_A, 2, 0, 150n, 180n),
    ]);
    assert.deepEqual(result.reserves.get(PAIR_A), { reserve0: 150n, reserve1: 180n });
    assert.equal(result.syncsApplied, 2);
  });

  it("applies Syncs in order regardless of input order", () => {
    const later = sync(PAIR_A, 9, 0, 999n, 999n);
    const earlier = sync(PAIR_A, 1, 0, 1n, 1n);
    assert.deepEqual(reconstruct([later, earlier]).reserves.get(PAIR_A), { reserve0: 999n, reserve1: 999n });
    assert.deepEqual(reconstruct([earlier, later]).reserves.get(PAIR_A), { reserve0: 999n, reserve1: 999n });
  });

  it("counts a Mint without needing it for reserves", () => {
    // The Sync that follows a mint already carries the resulting reserves.
    const result = reconstruct([
      sync(PAIR_A, 1, 0, 100n, 100n),
      mint(PAIR_A, 2, 0, 50n, 50n),
      sync(PAIR_A, 2, 1, 150n, 150n),
    ]);
    assert.equal(result.mintsSeen, 1);
    assert.deepEqual(result.reserves.get(PAIR_A), { reserve0: 150n, reserve1: 150n });
  });

  it("counts a Burn without needing it for reserves", () => {
    const result = reconstruct([
      sync(PAIR_A, 1, 0, 100n, 100n),
      burn(PAIR_A, 2, 0, 40n, 40n),
      sync(PAIR_A, 2, 1, 60n, 60n),
    ]);
    assert.equal(result.burnsSeen, 1);
    assert.deepEqual(result.reserves.get(PAIR_A), { reserve0: 60n, reserve1: 60n });
  });

  it("drops duplicate events and reports them", () => {
    const duplicate = sync(PAIR_A, 1, 0, 100n, 100n);
    const result = reconstruct([duplicate, duplicate, sync(PAIR_A, 2, 0, 200n, 200n)]);
    assert.equal(result.duplicates, 1);
    assert.equal(result.syncsApplied, 2);
    assert.deepEqual(result.reserves.get(PAIR_A), { reserve0: 200n, reserve1: 200n });
  });

  it("keeps the last valid state when a Sync is undecodable", () => {
    const broken: PairEvent = { pair: PAIR_A, blockNumber: 2, logIndex: 0, topic0: SYNC_TOPIC0, data: "0xzz" };
    const result = reconstruct([sync(PAIR_A, 1, 0, 100n, 100n), broken]);
    assert.equal(result.invalid, 1);
    assert.deepEqual(result.reserves.get(PAIR_A), { reserve0: 100n, reserve1: 100n });
  });

  it("tracks pairs independently", () => {
    const result = reconstruct([sync(PAIR_A, 1, 0, 10n, 20n), sync(PAIR_B, 1, 1, 30n, 40n)]);
    assert.deepEqual(result.reserves.get(PAIR_A), { reserve0: 10n, reserve1: 20n });
    assert.deepEqual(result.reserves.get(PAIR_B), { reserve0: 30n, reserve1: 40n });
  });

  it("leaves a pair with no Sync absent, not zero", () => {
    const result = reconstruct([sync(PAIR_A, 1, 0, 10n, 20n)]);
    assert.equal(result.reserves.has(PAIR_B), false);
  });
});

describe("hourly snapshots", () => {
  const boundaries = [boundary(3600, 100), boundary(7200, 200), boundary(10800, 300)];

  it("takes the last state at or before each boundary", () => {
    const events = [
      sync(PAIR_A, 50, 0, 10n, 10n),
      sync(PAIR_A, 150, 0, 20n, 20n),
      sync(PAIR_A, 250, 0, 30n, 30n),
    ];
    const snapshots = buildSnapshots(events, boundaries, [PAIR_A]);
    assert.equal(snapshots[0]?.perPair.get(PAIR_A)?.reserve0, 10n);
    assert.equal(snapshots[1]?.perPair.get(PAIR_A)?.reserve0, 20n);
    assert.equal(snapshots[2]?.perPair.get(PAIR_A)?.reserve0, 30n);
  });

  it("never uses an event at or after the bucket's exclusive upper block", () => {
    // Block 100 belongs to the next bucket, so the first snapshot must not see it.
    const events = [sync(PAIR_A, 99, 0, 10n, 10n), sync(PAIR_A, 100, 0, 99n, 99n)];
    const snapshots = buildSnapshots(events, boundaries, [PAIR_A]);
    assert.equal(snapshots[0]?.perPair.get(PAIR_A)?.reserve0, 10n);
    assert.equal(snapshots[1]?.perPair.get(PAIR_A)?.reserve0, 99n);
  });

  it("carries the previous state into an hour with no Sync", () => {
    // Exact, not an approximation: reserves only move when a Sync fires.
    const snapshots = buildSnapshots([sync(PAIR_A, 50, 0, 10n, 10n)], boundaries, [PAIR_A]);
    assert.equal(snapshots[0]?.perPair.get(PAIR_A)?.carried, false);
    assert.equal(snapshots[1]?.perPair.get(PAIR_A)?.carried, true);
    assert.equal(snapshots[1]?.perPair.get(PAIR_A)?.reserve0, 10n);
    assert.equal(snapshots[2]?.perPair.get(PAIR_A)?.reserve0, 10n);
  });

  it("reports a pair with no state yet as unknown, not as zero", () => {
    const snapshots = buildSnapshots([sync(PAIR_A, 150, 0, 10n, 10n)], boundaries, [PAIR_A]);
    assert.deepEqual(snapshots[0]?.unknownPairs, [PAIR_A]);
    assert.equal(snapshots[0]?.perPair.has(PAIR_A), false);
    assert.deepEqual(snapshots[1]?.unknownPairs, []);
  });

  it("accepts a seed for state established before the window", () => {
    const seed = new Map([[PAIR_A, { reserve0: 5n, reserve1: 5n }]]);
    const snapshots = buildSnapshots([], boundaries, [PAIR_A], { seed });
    assert.equal(snapshots[0]?.perPair.get(PAIR_A)?.reserve0, 5n);
    assert.deepEqual(snapshots[0]?.unknownPairs, []);
  });

  it("resolves a same-block tie by log index", () => {
    const events = [sync(PAIR_A, 50, 9, 99n, 99n), sync(PAIR_A, 50, 1, 11n, 11n)];
    const snapshots = buildSnapshots(events, boundaries, [PAIR_A]);
    // Higher log index is later, so it wins.
    assert.equal(snapshots[0]?.perPair.get(PAIR_A)?.reserve0, 99n);
  });

  it("ignores duplicate events", () => {
    const duplicate = sync(PAIR_A, 50, 0, 10n, 10n);
    const snapshots = buildSnapshots([duplicate, duplicate], boundaries, [PAIR_A]);
    assert.equal(snapshots[0]?.perPair.get(PAIR_A)?.reserve0, 10n);
  });

  it("is deterministic across shuffled input", () => {
    const events = [
      sync(PAIR_A, 250, 1, 30n, 30n),
      sync(PAIR_B, 50, 4, 7n, 7n),
      sync(PAIR_A, 50, 0, 10n, 10n),
      sync(PAIR_A, 150, 2, 20n, 20n),
    ];
    const render = (list: PairEvent[]) =>
      JSON.stringify(
        buildSnapshots(list, boundaries, [PAIR_A, PAIR_B]).map((s) => [
          s.startTimestamp,
          [...s.perPair].map(([p, r]) => [p, r.reserve0.toString(), r.reserve1.toString()]),
          s.unknownPairs,
        ]),
      );
    assert.equal(render(events), render([...events].reverse()));
  });

  it("treats silence as zero ONLY over a genesis scan", () => {
    /*
      The same input, two readings. Over a partial scan a pair with no Sync is an
      unknown, because the funding event could be sitting before the scan started. Over a
      scan from block 0 the same silence is an observation: a v2 pair starts at 0/0 and
      any funding emits Sync, so nothing was ever there.
    */
    const events = [sync(PAIR_A, 150, 0, 10n, 10n)];

    const partial = buildSnapshots(events, boundaries, [PAIR_A, PAIR_B]);
    assert.deepEqual(partial[0]?.unknownPairs, [PAIR_A, PAIR_B]);

    const genesis = buildSnapshots(events, boundaries, [PAIR_A, PAIR_B], { genesisScan: true });
    assert.deepEqual(genesis[0]?.unknownPairs, []);
    assert.equal(genesis[0]?.perPair.get(PAIR_A)?.reserve0, 0n);
    assert.equal(genesis[0]?.perPair.get(PAIR_B)?.reserve0, 0n);
    // And the real value still lands once the Sync arrives.
    assert.equal(genesis[1]?.perPair.get(PAIR_A)?.reserve0, 10n);
  });

  it("lets a genesis scan complete a window that a partial scan cannot", () => {
    const events = [sync(PAIR_A, 50, 0, 8n, 1n)];
    const partial = aggregateWethLiquidity(
      buildSnapshots(events, boundaries, [PAIR_A, PAIR_B]),
      sideOf,
    );
    const genesis = aggregateWethLiquidity(
      buildSnapshots(events, boundaries, [PAIR_A, PAIR_B], { genesisScan: true }),
      sideOf,
    );
    assert.equal(partial[0]?.complete, false);
    assert.equal(genesis[0]?.complete, true);
    // B contributes nothing because it held nothing, not because it was skipped.
    assert.equal(genesis[0]?.wethReserve, 8n);
  });

  it("returns one snapshot per boundary, in order", () => {
    const snapshots = buildSnapshots([], boundaries, [PAIR_A]);
    assert.deepEqual(snapshots.map((s) => s.startTimestamp), [3600, 7200, 10800]);
  });
});

describe("WETH-side aggregation", () => {
  const boundaries = [boundary(3600, 100)];

  it("takes reserve0 when WETH is token0 and reserve1 when it is token1", () => {
    const snapshots = buildSnapshots(
      [sync(PAIR_A, 10, 0, 5n, 500n), sync(PAIR_B, 10, 1, 700n, 9n)],
      boundaries,
      [PAIR_A, PAIR_B],
    );
    const points = aggregateWethLiquidity(snapshots, sideOf);
    assert.equal(points[0]?.wethReserve, 14n); // 5 from A (token0) + 9 from B (token1)
    assert.equal(points[0]?.pairsCounted, 2);
  });

  it("doubles the WETH side, because a pool holds equal value each side", () => {
    const snapshots = buildSnapshots([sync(PAIR_A, 10, 0, 100n, 1n)], boundaries, [PAIR_A]);
    const points = aggregateWethLiquidity(snapshots, sideOf);
    assert.equal(points[0]?.wethReserve, 100n);
    assert.equal(points[0]?.liquidityWei, 200n);
  });

  it("excludes token/token pairs entirely", () => {
    const snapshots = buildSnapshots(
      [sync(PAIR_A, 10, 0, 5n, 5n), sync(PAIR_T, 10, 1, 9_999n, 9_999n)],
      boundaries,
      [PAIR_A, PAIR_T],
    );
    const points = aggregateWethLiquidity(snapshots, sideOf);
    assert.equal(points[0]?.wethReserve, 5n);
    assert.equal(points[0]?.pairsCounted, 1);
    assert.equal(points[0]?.complete, true);
  });

  it("marks a bucket incomplete when a qualifying pair's state is unknown", () => {
    const snapshots = buildSnapshots([sync(PAIR_A, 10, 0, 5n, 5n)], boundaries, [PAIR_A, PAIR_B]);
    const points = aggregateWethLiquidity(snapshots, sideOf);
    assert.equal(points[0]?.complete, false);
    // The sum is real but partial, so it must not be published as the window's liquidity.
    assert.equal(points[0]?.wethReserve, 5n);
  });

  it("stays complete when the only unknown pair is token/token", () => {
    const snapshots = buildSnapshots([sync(PAIR_A, 10, 0, 5n, 5n)], boundaries, [PAIR_A, PAIR_T]);
    const points = aggregateWethLiquidity(snapshots, sideOf);
    assert.equal(points[0]?.complete, true);
  });

  it("marks a bucket incomplete when a pair is unclassified", () => {
    const unknownPair = "0xdddd000000000000000000000000000000000004";
    const snapshots = buildSnapshots([sync(unknownPair, 10, 0, 5n, 5n)], boundaries, [unknownPair]);
    const points = aggregateWethLiquidity(snapshots, sideOf);
    assert.equal(points[0]?.complete, false);
  });

  it("sums exactly at uint112 scale", () => {
    const snapshots = buildSnapshots(
      [sync(PAIR_A, 10, 0, MAX_UINT112, 1n), sync(PAIR_B, 10, 1, 1n, MAX_UINT112)],
      boundaries,
      [PAIR_A, PAIR_B],
    );
    const points = aggregateWethLiquidity(snapshots, sideOf);
    assert.equal(points[0]?.wethReserve, MAX_UINT112 * 2n);
  });
});
