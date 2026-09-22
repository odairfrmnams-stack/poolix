import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  describeRejection,
  isExpectedChain,
  isSafeAddress,
  parseAddress,
  sameAddress,
  toAddress,
} from "@/lib/address";

const CHECKSUMMED = "0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f";
const LOWER = CHECKSUMMED.toLowerCase();
const ZERO = "0x0000000000000000000000000000000000000000";
const BURN = "0x000000000000000000000000000000000000dEaD";

function reason(value: unknown, options?: Parameters<typeof parseAddress>[1]): string {
  const result = parseAddress(value, options);
  return result.ok ? "ok" : result.reason;
}

describe("parseAddress", () => {
  it("accepts a checksummed address and returns it unchanged", () => {
    const result = parseAddress(CHECKSUMMED);
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.address, CHECKSUMMED);
  });

  it("normalises casing rather than rejecting it", () => {
    // A lowercase address and a checksummed one name the same account. Rejecting the
    // former would reject most hand-typed input for no security gain; what matters is
    // that the OUTPUT is canonical so two references can never compare unequal.
    const lower = parseAddress(LOWER);
    const upper = parseAddress(`0x${CHECKSUMMED.slice(2).toUpperCase()}`);
    assert.equal(lower.ok && lower.address, CHECKSUMMED);
    assert.equal(upper.ok && upper.address, CHECKSUMMED);
  });

  it("trims surrounding whitespace, which pasting produces", () => {
    const result = parseAddress(`  ${CHECKSUMMED}\n`);
    assert.equal(result.ok && result.address, CHECKSUMMED);
  });

  it("rejects non-strings with a distinct reason", () => {
    assert.equal(reason(undefined), "not-a-string");
    assert.equal(reason(null), "not-a-string");
    assert.equal(reason(42), "not-a-string");
    assert.equal(reason({ address: CHECKSUMMED }), "not-a-string");
    assert.equal(reason([CHECKSUMMED]), "not-a-string");
  });

  it("rejects empty and whitespace-only input", () => {
    assert.equal(reason(""), "empty");
    assert.equal(reason("   "), "empty");
  });

  it("rejects oversized input on its length, before any pattern matching", () => {
    assert.equal(reason(`0x${"a".repeat(10_000)}`), "too-long");
    assert.equal(reason("x".repeat(1_000_000)), "too-long");
  });

  it("rejects malformed addresses", () => {
    assert.equal(reason("0x123"), "malformed");
    assert.equal(reason(CHECKSUMMED.slice(0, -1)), "malformed");
    assert.equal(reason(`${CHECKSUMMED}00`), "malformed");
    assert.equal(reason(LOWER.replace("a", "z")), "malformed");
    assert.equal(reason(CHECKSUMMED.slice(2)), "malformed");
  });

  it("rejects the zero address by default and admits it on request", () => {
    assert.equal(reason(ZERO), "zero-address");
    assert.equal(reason(ZERO, { allowZero: true }), "ok");
  });

  it("rejects the burn address by default and admits it on request", () => {
    assert.equal(reason(BURN), "burn-address");
    assert.equal(reason(BURN, { allowBurn: true }), "ok");
  });

  it("is deterministic across repeated calls", () => {
    for (let i = 0; i < 100; i++) {
      const result = parseAddress(LOWER);
      assert.equal(result.ok, true);
      assert.equal(result.ok && result.address, CHECKSUMMED);
    }
  });

  it("gives every rejection a message", () => {
    const reasons = [
      "not-a-string",
      "empty",
      "too-long",
      "malformed",
      "zero-address",
      "burn-address",
    ] as const;
    for (const value of reasons) {
      assert.equal(typeof describeRejection(value), "string");
      assert.ok(describeRejection(value).length > 0);
    }
  });
});

describe("toAddress and isSafeAddress", () => {
  it("agree with parseAddress", () => {
    assert.equal(toAddress(LOWER), CHECKSUMMED);
    assert.equal(toAddress("nonsense"), null);
    assert.equal(isSafeAddress(LOWER), true);
    assert.equal(isSafeAddress(ZERO), false);
    assert.equal(isSafeAddress(ZERO, { allowZero: true }), true);
  });
});

describe("sameAddress", () => {
  it("matches the same account whatever its casing", () => {
    assert.equal(sameAddress(LOWER, CHECKSUMMED), true);
  });

  it("does not match different accounts", () => {
    assert.equal(sameAddress(CHECKSUMMED, ZERO), false);
  });

  it("never reports two invalid values as equal", () => {
    // The trap this avoids: normalising to a sentinel and then comparing sentinels.
    assert.equal(sameAddress("garbage", "garbage"), false);
    assert.equal(sameAddress(undefined, undefined), false);
    assert.equal(sameAddress("", ""), false);
  });
});

describe("isExpectedChain", () => {
  it("accepts the configured chain as a number", () => {
    assert.equal(isExpectedChain(4663, 4663), true);
  });

  it("accepts a hex chain id, which is what a wallet reports", () => {
    assert.equal(isExpectedChain("0x1237", 4663), true);
    assert.equal(isExpectedChain("4663", 4663), true);
  });

  it("rejects any other chain", () => {
    assert.equal(isExpectedChain(1, 4663), false);
    assert.equal(isExpectedChain("0x1", 4663), false);
    assert.equal(isExpectedChain(4662, 4663), false);
  });

  it("rejects absent or unparseable values rather than defaulting to true", () => {
    assert.equal(isExpectedChain(undefined, 4663), false);
    assert.equal(isExpectedChain(null, 4663), false);
    assert.equal(isExpectedChain("", 4663), false);
    assert.equal(isExpectedChain("mainnet", 4663), false);
    assert.equal(isExpectedChain(Number.NaN, 4663), false);
    assert.equal(isExpectedChain(4663.5, 4663), false);
  });
});
