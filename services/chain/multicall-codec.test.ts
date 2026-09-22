import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { decodeAggregate3, decodeAggregate3Bytes } from "@/services/chain/multicall-codec";

/*
  The decoder is the one place a batched read could quietly invent a balance.

  aggregate3 returns (bool success, bytes returnData)[], and every failure mode below has
  to come out as null — the caller's "unanswered" case, which keeps the address queued.
  A null that became 0n would be a positive claim that an address holds nothing, which is
  precisely what a failed call did not establish.
*/

const word = (value: string | number | bigint) =>
  (typeof value === "string" ? value.replace(/^0x/, "") : value.toString(16)).padStart(64, "0");

/** Builds a well-formed aggregate3 response for the given entries. */
function encodeResponse(entries: readonly { success: boolean; data: string | null }[]): string {
  const elements = entries.map((entry) => {
    const payload = entry.data === null ? "" : entry.data.replace(/^0x/, "");
    const byteLength = payload.length / 2;
    const padded = payload.padEnd(Math.ceil(byteLength / 32) * 64, "0");
    // success, offset-to-bytes (0x40), length, data
    return [word(entry.success ? 1 : 0), word(0x40), word(byteLength), padded].join("");
  });

  let running = 32 * entries.length;
  const offsets: string[] = [];
  for (const element of elements) {
    offsets.push(word(running));
    running += element.length / 2;
  }

  return `0x${word(0x20)}${word(entries.length)}${offsets.join("")}${elements.join("")}`;
}

const balance = (value: bigint) => `0x${word(value)}`;

describe("aggregate3 decoding", () => {
  it("decodes a successful balance", () => {
    const response = encodeResponse([{ success: true, data: balance(1234n) }]);
    const decoded = decodeAggregate3(response, 1);
    assert.equal(decoded.length, 1);
    assert.equal(BigInt(decoded[0]!), 1234n);
  });

  it("decodes a genuine zero balance as zero, not as unanswered", () => {
    // The contract positively said "holds nothing". That is knowledge.
    const response = encodeResponse([{ success: true, data: balance(0n) }]);
    assert.equal(BigInt(decodeAggregate3(response, 1)[0]!), 0n);
  });

  it("returns null for a call that reverted", () => {
    // The critical case: a failure must never become a zero balance.
    const response = encodeResponse([{ success: false, data: null }]);
    assert.equal(decodeAggregate3(response, 1)[0], null);
  });

  it("returns null for a success carrying no return data", () => {
    const response = encodeResponse([{ success: true, data: null }]);
    assert.equal(decodeAggregate3(response, 1)[0], null);
  });

  it("returns null for a short return that is not a full word", () => {
    const response = encodeResponse([{ success: true, data: "0xdeadbeef" }]);
    assert.equal(decodeAggregate3(response, 1)[0], null);
  });

  it("keeps successes and failures in their original positions", () => {
    const response = encodeResponse([
      { success: true, data: balance(11n) },
      { success: false, data: null },
      { success: true, data: balance(33n) },
    ]);
    const decoded = decodeAggregate3(response, 3);
    assert.equal(BigInt(decoded[0]!), 11n);
    assert.equal(decoded[1], null);
    assert.equal(BigInt(decoded[2]!), 33n);
  });

  it("returns all nulls when the response is truncated", () => {
    assert.deepEqual(decodeAggregate3("0x", 2), [null, null]);
    assert.deepEqual(decodeAggregate3(`0x${word(0x20)}`, 2), [null, null]);
  });

  it("returns all nulls when the array length disagrees with what was asked", () => {
    // A response describing a different number of calls cannot be matched to addresses
    // positionally, so nothing in it may be trusted.
    const response = encodeResponse([{ success: true, data: balance(7n) }]);
    assert.deepEqual(decodeAggregate3(response, 2), [null, null]);
  });

  it("returns all nulls for garbage", () => {
    assert.deepEqual(decodeAggregate3("0xnonsense", 1), [null]);
  });

  it("decodes a large balance without losing precision", () => {
    const huge = 2n ** 255n - 1n;
    const response = encodeResponse([{ success: true, data: balance(huge) }]);
    assert.equal(BigInt(decodeAggregate3(response, 1)[0]!), huge);
  });

  it("never produces a zero from any failure mode", () => {
    const failures = [
      encodeResponse([{ success: false, data: null }]),
      encodeResponse([{ success: true, data: null }]),
      encodeResponse([{ success: true, data: "0xdead" }]),
      "0x",
      "0xzz",
    ];
    for (const response of failures) {
      const decoded = decodeAggregate3(response, 1);
      assert.equal(decoded[0], null, `expected null, got ${String(decoded[0])}`);
    }
  });
});

// --------------------------------------------------- variable-length decoder

describe("aggregate3Bytes decoding", () => {
  it("decodes a single 32-byte word, same as the strict decoder", () => {
    const response = encodeResponse([{ success: true, data: balance(42n) }]);
    const decoded = decodeAggregate3Bytes(response, 1);
    assert.equal(decoded.length, 1);
    assert.equal(BigInt(decoded[0]!), 42n);
  });

  it("decodes a 96-byte getReserves response (3 words)", () => {
    const reserve0 = word(1000n);
    const reserve1 = word(2000n);
    const blockTs = word(1700000000n);
    const data = `0x${reserve0}${reserve1}${blockTs}`;
    const response = encodeResponse([{ success: true, data }]);
    const decoded = decodeAggregate3Bytes(response, 1);
    assert.notEqual(decoded[0], null);
    const body = decoded[0]!.slice(2);
    assert.equal(BigInt(`0x${body.slice(0, 64)}`), 1000n);
    assert.equal(BigInt(`0x${body.slice(64, 128)}`), 2000n);
  });

  it("handles mixed return lengths: address (32B) + address (32B) + reserves (96B)", () => {
    const addr = `0x${word("0x1234567890abcdef1234567890abcdef12345678")}`;
    const reserves = `0x${word(500n)}${word(600n)}${word(99n)}`;
    const response = encodeResponse([
      { success: true, data: addr },
      { success: true, data: addr },
      { success: true, data: reserves },
    ]);
    const decoded = decodeAggregate3Bytes(response, 3);
    assert.notEqual(decoded[0], null);
    assert.equal(decoded[0]!.length, 66);
    assert.notEqual(decoded[1], null);
    assert.notEqual(decoded[2], null);
    assert.equal(decoded[2]!.length, 2 + 64 * 3);
  });

  it("returns null for a failed subcall, not zero", () => {
    const response = encodeResponse([{ success: false, data: null }]);
    assert.equal(decodeAggregate3Bytes(response, 1)[0], null);
  });

  it("returns null for empty return data on success", () => {
    const response = encodeResponse([{ success: true, data: null }]);
    assert.equal(decodeAggregate3Bytes(response, 1)[0], null);
  });

  it("keeps successes and failures in position with mixed lengths", () => {
    const addr = `0x${word("0xaaaa567890abcdef1234567890abcdef12345678")}`;
    const reserves = `0x${word(100n)}${word(200n)}${word(1n)}`;
    const response = encodeResponse([
      { success: true, data: addr },
      { success: false, data: null },
      { success: true, data: reserves },
    ]);
    const decoded = decodeAggregate3Bytes(response, 3);
    assert.notEqual(decoded[0], null);
    assert.equal(decoded[1], null);
    assert.notEqual(decoded[2], null);
  });

  it("returns all nulls when array length disagrees with expected", () => {
    const response = encodeResponse([{ success: true, data: balance(7n) }]);
    assert.deepEqual(decodeAggregate3Bytes(response, 2), [null, null]);
  });

  it("returns all nulls for truncated response", () => {
    assert.deepEqual(decodeAggregate3Bytes("0x", 1), [null]);
  });

  it("returns all nulls for garbage", () => {
    assert.deepEqual(decodeAggregate3Bytes("0xnonsense", 1), [null]);
  });

  it("the strict decoder rejects 96-byte data, the bytes decoder accepts it", () => {
    const data = `0x${word(1n)}${word(2n)}${word(3n)}`;
    const response = encodeResponse([{ success: true, data }]);
    assert.equal(decodeAggregate3(response, 1)[0], null);
    assert.notEqual(decodeAggregate3Bytes(response, 1)[0], null);
  });

  it("never produces a value from any failure mode", () => {
    const failures = [
      encodeResponse([{ success: false, data: null }]),
      encodeResponse([{ success: true, data: null }]),
      "0x",
      "0xzz",
    ];
    for (const response of failures) {
      const decoded = decodeAggregate3Bytes(response, 1);
      assert.equal(decoded[0], null, `expected null, got ${String(decoded[0])}`);
    }
  });
});
