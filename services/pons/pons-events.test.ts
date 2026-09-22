import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  PONS_LAUNCH_TOPIC_A,
  PONS_LAUNCH_TOPIC_B,
  V3_SWAP_TOPIC,
} from "@/services/pons/pons-config";
import { decodeLaunchA, decodeLaunchB, decodeV3Swap, pairLaunches, type RawLog } from "@/services/pons/pons-events";

/*
  Fixtures taken from the first real launch in the active factory's history, block
  9,019,252, tx 0x92476c6f…, verified during the Phase 9A audit:
    token   0x055650555be80649397084cd3f8a09b4350e8612  (BUNEE)
    creator 0xb6e60e418e198aad0360be847863e0477420239a  (EOA)
    pool    0x8f4f723f10fc7bad28742d25c91158c728557c4c  (confirmed by v3Factory.getPool)
*/
const TOKEN = "0x055650555be80649397084cd3f8a09b4350e8612";
const CREATOR = "0xb6e60e418e198aad0360be847863e0477420239a";
const V3_FACTORY = "0x1f7d7550b1b028f7571e69a784071f0205fd2efa";
const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const POOL = "0x8f4f723f10fc7bad28742d25c91158c728557c4c";
const TX = `0x${"92476c6f".repeat(8)}`;
const ZERO_WORD = `0x${"0".repeat(64)}`;

const word = (address: string) => `0x${address.replace("0x", "").toLowerCase().padStart(64, "0")}`;
const uint = (value: bigint) => value.toString(16).padStart(64, "0");

const launchA = (overrides: Partial<RawLog> = {}): RawLog => ({
  topic0: PONS_LAUNCH_TOPIC_A,
  topic1: word(TOKEN),
  topic2: word(CREATOR),
  topic3: word(V3_FACTORY),
  data: `0x${word(WETH).slice(2)}${"0".repeat(64)}${"0".repeat(64)}`,
  block_number: 9_019_252,
  transaction_hash: TX,
  ...overrides,
});

const launchB = (overrides: Partial<RawLog> = {}): RawLog => ({
  topic0: PONS_LAUNCH_TOPIC_B,
  topic1: word(TOKEN),
  topic2: word(CREATOR),
  topic3: word(V3_FACTORY),
  data:
    `0x${word(WETH).slice(2)}${word(POOL).slice(2)}${"0".repeat(64)}${"0".repeat(64)}` +
    `${uint(109_858n)}${uint(25_526_999n)}${uint(10_000_000_000_000_000n)}`,
  block_number: 9_019_252,
  transaction_hash: TX,
  ...overrides,
});

describe("decodeLaunchA", () => {
  it("decodes a real launch event", () => {
    const result = decodeLaunchA(launchA());
    assert.ok(result !== null);
    assert.equal(result.token, TOKEN);
    assert.equal(result.creator, CREATOR);
    assert.equal(result.v3Factory, V3_FACTORY);
    assert.equal(result.quoteToken, WETH);
    assert.equal(result.blockNumber, 9_019_252);
  });

  it("ignores a log with a different topic0", () => {
    assert.equal(decodeLaunchA(launchA({ topic0: PONS_LAUNCH_TOPIC_B })), null);
    assert.equal(decodeLaunchA(launchA({ topic0: undefined })), null);
  });

  it("rejects a zero token or creator", () => {
    assert.equal(decodeLaunchA(launchA({ topic1: ZERO_WORD })), null);
    assert.equal(decodeLaunchA(launchA({ topic2: ZERO_WORD })), null);
  });

  it("rejects a topic whose address padding is dirty", () => {
    // A non-zero high byte means the word is not an address; truncating it would
    // silently invent a different address.
    const dirty = `0x01${word(TOKEN).slice(4)}`;
    assert.equal(decodeLaunchA(launchA({ topic1: dirty })), null);
  });

  it("rejects the wrong number of data words", () => {
    assert.equal(decodeLaunchA(launchA({ data: `0x${word(WETH).slice(2)}` })), null);
    assert.equal(decodeLaunchA(launchA({ data: "0x" })), null);
    assert.equal(decodeLaunchA(launchA({ data: undefined })), null);
  });

  it("rejects non-hex data", () => {
    assert.equal(decodeLaunchA(launchA({ data: `0x${"z".repeat(192)}` })), null);
  });

  it("rejects a token that is also the creator or the quote asset", () => {
    assert.equal(decodeLaunchA(launchA({ topic2: word(TOKEN) })), null);
    assert.equal(decodeLaunchA(launchA({ topic1: word(WETH) })), null);
  });

  it("rejects a malformed or missing transaction hash", () => {
    assert.equal(decodeLaunchA(launchA({ transaction_hash: "0xdead" })), null);
    assert.equal(decodeLaunchA(launchA({ transaction_hash: undefined })), null);
  });

  it("rejects a malformed block number", () => {
    assert.equal(decodeLaunchA(launchA({ block_number: -1 })), null);
    assert.equal(decodeLaunchA(launchA({ block_number: 1.5 })), null);
    assert.equal(decodeLaunchA(launchA({ block_number: undefined })), null);
  });
});

describe("decodeLaunchB", () => {
  it("decodes a real launch event including the pool and position", () => {
    const result = decodeLaunchB(launchB());
    assert.ok(result !== null);
    assert.equal(result.token, TOKEN);
    assert.equal(result.pool, POOL);
    assert.equal(result.positionTokenId, 109_858n);
    assert.equal(result.unverifiedWeiAmount, 10_000_000_000_000_000n);
  });

  it("rejects a zero pool address", () => {
    const data = launchB().data!.replace(word(POOL).slice(2), "0".repeat(64));
    assert.equal(decodeLaunchB(launchB({ data })), null);
  });

  it("rejects a position id of zero, since a launch always mints one", () => {
    const data = launchB().data!.replace(uint(109_858n), uint(0n));
    assert.equal(decodeLaunchB(launchB({ data })), null);
  });

  it("rejects a pool equal to the token or the quote asset", () => {
    const asToken = launchB().data!.replace(word(POOL).slice(2), word(TOKEN).slice(2));
    assert.equal(decodeLaunchB(launchB({ data: asToken })), null);
  });

  it("rejects the wrong data length", () => {
    assert.equal(decodeLaunchB(launchB({ data: `0x${"0".repeat(64 * 6)}` })), null);
    assert.equal(decodeLaunchB(launchB({ data: `0x${"0".repeat(64 * 8)}` })), null);
  });

  it("carries data[6] through without naming it", () => {
    // It is NOT the launch fee: the documented fee is a constant 0.0005 ETH and this
    // varies, including to zero.
    const zeroed = launchB().data!.replace(uint(10_000_000_000_000_000n), uint(0n));
    const result = decodeLaunchB(launchB({ data: zeroed }));
    assert.ok(result !== null);
    assert.equal(result.unverifiedWeiAmount, 0n);
  });
});

describe("pairLaunches", () => {
  it("pairs the two events from one transaction", () => {
    const paired = pairLaunches([launchA(), launchB()]);
    assert.equal(paired.length, 1);
    assert.equal(paired[0]?.token, TOKEN);
    assert.equal(paired[0]?.pool, POOL);
  });

  it("does not pair event B without its event A", () => {
    // Event A alone carries no pool, so a B with no matching A is an incomplete launch.
    assert.equal(pairLaunches([launchB()]).length, 0);
  });

  it("does not pair across different transactions", () => {
    const otherTx = `0x${"ab".repeat(32)}`;
    assert.equal(pairLaunches([launchA(), launchB({ transaction_hash: otherTx })]).length, 0);
  });

  it("refuses a pair whose token or creator disagree", () => {
    const otherToken = `0x${"11".repeat(20)}`;
    assert.equal(pairLaunches([launchA(), launchB({ topic1: word(otherToken) })]).length, 0);
    assert.equal(pairLaunches([launchA(), launchB({ topic2: word(otherToken) })]).length, 0);
  });

  it("deduplicates a repeated event B in the same transaction", () => {
    const paired = pairLaunches([launchA(), launchB(), launchB(), launchB()]);
    assert.equal(paired.length, 1);
  });

  it("handles a batch of distinct launches", () => {
    const second = `0x${"22".repeat(20)}`;
    const secondPool = `0x${"33".repeat(20)}`;
    const secondTx = `0x${"44".repeat(32)}`;
    const dataB =
      `0x${word(WETH).slice(2)}${word(secondPool).slice(2)}${"0".repeat(64)}${"0".repeat(64)}` +
      `${uint(1n)}${uint(2n)}${uint(3n)}`;

    const paired = pairLaunches([
      launchA(),
      launchB(),
      launchA({ topic1: word(second), transaction_hash: secondTx }),
      launchB({ topic1: word(second), transaction_hash: secondTx, data: dataB }),
    ]);
    assert.equal(paired.length, 2);
    assert.deepEqual(paired.map((p) => p.token).sort(), [TOKEN, second].sort());
  });

  it("ignores unrelated logs entirely", () => {
    assert.equal(pairLaunches([{ topic0: V3_SWAP_TOPIC }, {}, { data: "0x" }]).length, 0);
  });
});

describe("decodeV3Swap", () => {
  const swap = (overrides: Partial<RawLog> = {}): RawLog => ({
    topic0: V3_SWAP_TOPIC,
    address: POOL,
    data:
      `0x${uint(BigInt.asUintN(256, -500n))}${uint(1_000n)}` +
      `${uint(4_517_874_848_524_550_533_109_777n)}${uint(36_819_258_015_569_838_458_222n)}${uint(BigInt.asUintN(256, -195_451n))}`,
    block_number: 9_019_300,
    ...overrides,
  });

  it("decodes a swap and preserves the signs", () => {
    const result = decodeV3Swap(swap());
    assert.ok(result !== null);
    // Reading these unsigned would turn a sell into an astronomically large buy.
    assert.equal(result.amount0, -500n);
    assert.equal(result.amount1, 1_000n);
    assert.equal(result.tick, -195_451);
    assert.equal(result.pool, POOL);
  });

  it("rejects a log that is not a Swap", () => {
    assert.equal(decodeV3Swap(swap({ topic0: PONS_LAUNCH_TOPIC_A })), null);
  });

  it("rejects a swap where either amount is zero", () => {
    const zeroed = `0x${uint(0n)}${uint(1_000n)}${uint(1n)}${uint(1n)}${uint(0n)}`;
    assert.equal(decodeV3Swap(swap({ data: zeroed })), null);
  });

  it("rejects a swap whose amounts share a sign", () => {
    // Both sides in, or both out, cannot happen in a real swap.
    const bothPositive = `0x${uint(500n)}${uint(1_000n)}${uint(1n)}${uint(1n)}${uint(0n)}`;
    assert.equal(decodeV3Swap(swap({ data: bothPositive })), null);
  });

  it("rejects a malformed pool address", () => {
    assert.equal(decodeV3Swap(swap({ address: "0xnope" })), null);
    assert.equal(decodeV3Swap(swap({ address: undefined })), null);
  });

  it("rejects the wrong data length", () => {
    assert.equal(decodeV3Swap(swap({ data: `0x${uint(1n)}${uint(2n)}` })), null);
  });
});
