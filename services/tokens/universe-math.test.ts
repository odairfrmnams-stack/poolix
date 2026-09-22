import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  acceptVerified,
  dedupeCandidates,
  isUsableAddress,
  mayQualify,
  orderCandidates,
  preferReading,
  qualifyPair,
  selectTokens,
  stillQualifies,
  ZERO_ADDRESS,
  type TokenCandidate,
  type TokenVerification,
} from "@/services/tokens/universe-math";

const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const MIN = 10n ** 14n;

const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const pair = (n: number) => `0xaa${n.toString(16).padStart(38, "0")}`;

const candidate = (token: string, wethReserve: bigint, from = pair(1)): TokenCandidate => ({
  token,
  pair: from,
  wethReserve,
});

/** `count` candidates with strictly decreasing reserves, so ordering is unambiguous. */
const many = (count: number): TokenCandidate[] =>
  Array.from({ length: count }, (_, i) => candidate(address(i + 1), BigInt(count - i) * MIN, pair(i + 1)));

const verifyAll = (tokens: readonly TokenCandidate[]): Map<string, TokenVerification> =>
  new Map(tokens.map((t) => [t.token, { decimals: 18, balanceReadable: true }]));

describe("address validity", () => {
  it("accepts a well-formed address", () => {
    assert.equal(isUsableAddress(address(1)), true);
  });

  it("rejects the zero address", () => {
    assert.equal(isUsableAddress(ZERO_ADDRESS), false);
  });

  it("rejects malformed values", () => {
    assert.equal(isUsableAddress("0x123"), false);
    assert.equal(isUsableAddress("not an address"), false);
    assert.equal(isUsableAddress(""), false);
    assert.equal(isUsableAddress(`${address(1)}00`), false);
  });
});

describe("cheap pre-filter", () => {
  it("rejects an empty pair without reading its tokens", () => {
    assert.equal(mayQualify(0n, 0n, MIN), false);
    assert.equal(mayQualify(MIN, 0n, MIN), false);
  });

  it("rejects a pair where neither side reaches the minimum", () => {
    assert.equal(mayQualify(MIN - 1n, MIN - 1n, MIN), false);
  });

  it("keeps a pair when either side could be the WETH side", () => {
    assert.equal(mayQualify(MIN, 1n, MIN), true);
    assert.equal(mayQualify(1n, MIN, MIN), true);
  });

  it("never rejects a pair that would actually qualify", () => {
    // The pre-filter must be a necessary condition, never a stricter one.
    const qualifying = qualifyPair(
      { pair: pair(1), token0: WETH, token1: address(7), reserve0: MIN, reserve1: 5n },
      WETH,
      MIN,
    );
    assert.notEqual(qualifying, null);
    assert.equal(mayQualify(MIN, 5n, MIN), true);
  });
});

describe("pair qualification", () => {
  it("takes the non-WETH side when WETH is token0", () => {
    const result = qualifyPair(
      { pair: pair(1), token0: WETH, token1: address(7), reserve0: MIN * 3n, reserve1: 99n },
      WETH,
      MIN,
    );
    assert.deepEqual(result, { token: address(7), pair: pair(1), wethReserve: MIN * 3n });
  });

  it("takes the non-WETH side when WETH is token1", () => {
    const result = qualifyPair(
      { pair: pair(2), token0: address(8), token1: WETH, reserve0: 99n, reserve1: MIN * 2n },
      WETH,
      MIN,
    );
    assert.deepEqual(result, { token: address(8), pair: pair(2), wethReserve: MIN * 2n });
  });

  it("excludes WETH itself from ever being tracked", () => {
    const result = qualifyPair(
      { pair: pair(3), token0: WETH, token1: WETH, reserve0: MIN * 9n, reserve1: MIN * 9n },
      WETH,
      MIN,
    );
    assert.equal(result, null);
  });

  it("rejects a pair with no WETH side", () => {
    const result = qualifyPair(
      { pair: pair(4), token0: address(1), token1: address(2), reserve0: MIN * 9n, reserve1: MIN * 9n },
      WETH,
      MIN,
    );
    assert.equal(result, null);
  });

  it("rejects an empty pair and one below the minimum", () => {
    const base = { pair: pair(5), token0: WETH, token1: address(3) };
    assert.equal(qualifyPair({ ...base, reserve0: 0n, reserve1: 5n }, WETH, MIN), null);
    assert.equal(qualifyPair({ ...base, reserve0: MIN - 1n, reserve1: 5n }, WETH, MIN), null);
  });

  it("rejects a pair whose other side is the zero address", () => {
    const result = qualifyPair(
      { pair: pair(6), token0: WETH, token1: ZERO_ADDRESS, reserve0: MIN * 4n, reserve1: 7n },
      WETH,
      MIN,
    );
    assert.equal(result, null);
  });

  it("normalises case, so the same token is never two tokens", () => {
    const result = qualifyPair(
      { pair: pair(7), token0: WETH.toUpperCase().replace("0X", "0x"), token1: address(9).toUpperCase().replace("0X", "0x"), reserve0: MIN, reserve1: 1n },
      WETH,
      MIN,
    );
    assert.equal(result?.token, address(9));
  });
});

describe("de-duplication", () => {
  it("counts a token found in several pools once, keeping the deepest", () => {
    const deduped = dedupeCandidates([
      candidate(address(1), MIN * 2n, pair(1)),
      candidate(address(1), MIN * 9n, pair(2)),
      candidate(address(1), MIN * 5n, pair(3)),
    ]);
    assert.equal(deduped.length, 1);
    assert.equal(deduped[0]?.wethReserve, MIN * 9n);
    assert.equal(deduped[0]?.pair, pair(2));
  });

  it("de-duplicates case-insensitively", () => {
    const upper = address(1).toUpperCase().replace("0X", "0x");
    const deduped = dedupeCandidates([candidate(address(1), MIN), candidate(upper, MIN * 2n)]);
    assert.equal(deduped.length, 1);
    assert.equal(deduped[0]?.token, address(1));
  });

  it("drops the zero address", () => {
    assert.equal(dedupeCandidates([candidate(ZERO_ADDRESS, MIN * 9n)]).length, 0);
  });
});

describe("deterministic selection", () => {
  it("returns nothing when nothing was discovered", () => {
    assert.deepEqual(selectTokens([], 10), []);
  });

  it("returns 2 when only 2 were discovered", () => {
    assert.equal(selectTokens(many(2), 10).length, 2);
  });

  it("returns 5 when only 5 were discovered", () => {
    assert.equal(selectTokens(many(5), 10).length, 5);
  });

  it("returns 10 when exactly 10 were discovered", () => {
    assert.equal(selectTokens(many(10), 10).length, 10);
  });

  it("selects exactly 10 from 20 discovered", () => {
    const selected = selectTokens(many(20), 10);
    assert.equal(selected.length, 10);
    // The deepest ten, not an arbitrary ten.
    assert.deepEqual(selected.map((t) => t.token), many(20).slice(0, 10).map((t) => t.token));
  });

  it("orders by reserve descending", () => {
    const ordered = orderCandidates([
      candidate(address(1), MIN),
      candidate(address(2), MIN * 5n),
      candidate(address(3), MIN * 3n),
    ]);
    assert.deepEqual(ordered.map((t) => t.token), [address(2), address(3), address(1)]);
  });

  it("breaks reserve ties by address, so the order cannot drift", () => {
    const ordered = orderCandidates([
      candidate(address(3), MIN),
      candidate(address(1), MIN),
      candidate(address(2), MIN),
    ]);
    assert.deepEqual(ordered.map((t) => t.token), [address(1), address(2), address(3)]);
  });

  it("is stable across repeated runs on shuffled input", () => {
    const base = many(20);
    const shuffled = [...base].reverse();
    const first = selectTokens(base, 10).map((t) => t.token);
    const second = selectTokens(shuffled, 10).map((t) => t.token);
    assert.deepEqual(first, second);
  });

  it("treats the limit as a ceiling, never as a result", () => {
    assert.equal(selectTokens(many(3), 10).length, 3);
    assert.equal(selectTokens([], 10).length, 0);
    assert.equal(selectTokens(many(5), 0).length, 0);
  });
});

describe("verification gate", () => {
  it("keeps tokens whose contract answered", () => {
    const selected = selectTokens(many(3), 10);
    assert.equal(acceptVerified(selected, verifyAll(selected)).length, 3);
  });

  it("drops a token whose decimals could not be read", () => {
    const selected = selectTokens(many(3), 10);
    const verifications = verifyAll(selected);
    verifications.set(selected[1]!.token, { decimals: null, balanceReadable: true });

    const accepted = acceptVerified(selected, verifications);
    assert.equal(accepted.length, 2);
    assert.equal(accepted.some((t) => t.token === selected[1]!.token), false);
  });

  it("drops a token whose balanceOf could not be read", () => {
    const selected = selectTokens(many(3), 10);
    const verifications = verifyAll(selected);
    verifications.set(selected[0]!.token, { decimals: 18, balanceReadable: false });
    assert.equal(acceptVerified(selected, verifications).length, 2);
  });

  it("drops a token that was never verified at all", () => {
    const selected = selectTokens(many(3), 10);
    const verifications = verifyAll(selected);
    verifications.delete(selected[2]!.token);
    assert.equal(acceptVerified(selected, verifications).length, 2);
  });

  it("keeps the deterministic order after filtering", () => {
    const selected = selectTokens(many(5), 10);
    const verifications = verifyAll(selected);
    verifications.set(selected[2]!.token, { decimals: null, balanceReadable: true });

    const accepted = acceptVerified(selected, verifications);
    assert.deepEqual(
      accepted.map((t) => t.token),
      [selected[0]!.token, selected[1]!.token, selected[3]!.token, selected[4]!.token],
    );
  });

  it("reports 6 when 10 were selected but only 6 verified", () => {
    // The case the UI must never round up: a ceiling of 10 with 6 real tokens.
    const selected = selectTokens(many(10), 10);
    const verifications = verifyAll(selected);
    for (const failing of selected.slice(6)) {
      verifications.set(failing.token, { decimals: null, balanceReadable: false });
    }
    assert.equal(acceptVerified(selected, verifications).length, 6);
  });
});

describe("re-reading a stored pair", () => {
  const pairA = address(0xa1);
  const pairB = address(0xb2);

  it("accepts the first reading a token has", () => {
    assert.equal(preferReading(undefined, { pair: pairA, wethReserve: 5n }), true);
  });

  it("takes a lower reading of the SAME pair, so a drained pool stops ranking high", () => {
    const stored = { pair: pairA, wethReserve: 65n * 10n ** 18n };
    const fresh = { pair: pairA, wethReserve: 1n };
    assert.equal(preferReading(stored, fresh), true);
  });

  it("takes a higher reading of the same pair too", () => {
    const stored = { pair: pairA, wethReserve: 1n };
    assert.equal(preferReading(stored, { pair: pairA, wethReserve: 99n }), true);
  });

  it("compares case-insensitively, so one pair is one pair", () => {
    const stored = { pair: pairA.toUpperCase(), wethReserve: 100n };
    assert.equal(preferReading(stored, { pair: pairA, wethReserve: 2n }), true);
  });

  it("keeps the deeper pool when a DIFFERENT pair is shallower", () => {
    const stored = { pair: pairA, wethReserve: 100n };
    assert.equal(preferReading(stored, { pair: pairB, wethReserve: 2n }), false);
  });

  it("switches to a different pair that is genuinely deeper", () => {
    const stored = { pair: pairA, wethReserve: 2n };
    assert.equal(preferReading(stored, { pair: pairB, wethReserve: 100n }), true);
  });

  it("does not switch pairs on an equal reading, which would make order unstable", () => {
    const stored = { pair: pairA, wethReserve: 50n };
    assert.equal(preferReading(stored, { pair: pairB, wethReserve: 50n }), false);
  });
});

describe("dropping a drained pair", () => {
  it("keeps a pair still holding the minimum", () => {
    assert.equal(stillQualifies(MIN, 1_000n, MIN, MIN), true);
  });

  it("drops a pair that has fallen below the threshold it entered under", () => {
    assert.equal(stillQualifies(MIN - 1n, 1_000n, MIN - 1n, MIN), false);
  });

  it("drops a fully drained pair", () => {
    assert.equal(stillQualifies(0n, 0n, 0n, MIN), false);
  });

  it("drops a pair whose other side is empty, which cannot be traded", () => {
    assert.equal(stillQualifies(10n ** 18n, 0n, 10n ** 18n, MIN), false);
  });

  it("uses the same threshold qualifyPair admits on", () => {
    const state = {
      pair: address(0xc3),
      token0: WETH,
      token1: address(0xd4),
      reserve0: MIN,
      reserve1: 1_000n,
    };
    const admitted = qualifyPair(state, WETH, MIN) !== null;
    assert.equal(admitted, stillQualifies(state.reserve0, state.reserve1, MIN, MIN));
  });
});