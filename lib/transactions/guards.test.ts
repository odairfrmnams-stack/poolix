import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { maxUint256 } from "viem";

import {
  checkApproval,
  checkCalldata,
  checkDeadline,
  checkTransactionIntent,
  MAX_DEADLINE_SECONDS,
  type GuardResult,
} from "@/lib/transactions/guards";
import type { Address } from "@/types/web3";

const ROUTER = "0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f" as Address;
const FACTORY = "0x2aC03e14Cfe755426DaAEe0a4994184Ce81482F8" as Address;
const TOKEN = "0xdebf427d12b5dafc8dd7ecfa869e62c6840119d3" as Address;
const ATTACKER = "0x1111111111111111111111111111111111111111" as Address;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;

const CHAIN = 4663;
const NOW = 1_700_000_000;
/** A real swapExactTokensForTokens selector plus a word of arguments. */
const CALLDATA = `0x38ed1739${"0".repeat(64)}`;

function reasonOf(result: GuardResult): string {
  return result.ok ? "ok" : result.reason;
}

// --------------------------------------------------------------------- deadline

describe("checkDeadline", () => {
  it("accepts a deadline inside the window", () => {
    assert.equal(reasonOf(checkDeadline(BigInt(NOW + 20 * 60), NOW)), "ok");
  });

  it("rejects a deadline that has already passed", () => {
    assert.equal(reasonOf(checkDeadline(BigInt(NOW - 1), NOW)), "deadline-expired");
    assert.equal(reasonOf(checkDeadline(BigInt(NOW), NOW)), "deadline-expired");
  });

  it("rejects the far-future estimation sentinel", () => {
    // swap-card uses 2^48 to estimate gas. It must never reach a signature: a swap with an
    // effectively unbounded deadline can be executed long after the quote it was signed
    // against stopped being true.
    assert.equal(reasonOf(checkDeadline(2n ** 48n, NOW)), "deadline-too-far");
  });

  it("rejects a deadline just past the maximum and accepts one just inside it", () => {
    assert.equal(reasonOf(checkDeadline(BigInt(NOW + MAX_DEADLINE_SECONDS + 1), NOW)), "deadline-too-far");
    assert.equal(reasonOf(checkDeadline(BigInt(NOW + MAX_DEADLINE_SECONDS), NOW)), "ok");
  });

  it("rejects zero and negative timestamps", () => {
    assert.equal(reasonOf(checkDeadline(0n, NOW)), "deadline-not-finite");
    assert.equal(reasonOf(checkDeadline(-1n, NOW)), "deadline-not-finite");
  });

  it("rejects when the clock itself is not a number", () => {
    assert.equal(reasonOf(checkDeadline(BigInt(NOW + 60), Number.NaN)), "deadline-not-finite");
    assert.equal(reasonOf(checkDeadline(BigInt(NOW + 60), Number.POSITIVE_INFINITY)), "deadline-not-finite");
  });

  it("accepts a fractional clock, because Date.now()/1000 is not an integer", () => {
    assert.equal(reasonOf(checkDeadline(BigInt(NOW + 600), NOW + 0.456)), "ok");
  });
});

// --------------------------------------------------------------------- calldata

describe("checkCalldata", () => {
  it("accepts a selector with arguments", () => {
    assert.equal(reasonOf(checkCalldata(CALLDATA)), "ok");
  });

  it("rejects calldata with no selector", () => {
    assert.equal(reasonOf(checkCalldata("0x")), "empty-calldata");
    assert.equal(reasonOf(checkCalldata("0x38ed17")), "empty-calldata");
  });

  it("rejects anything that is not a hex string", () => {
    assert.equal(reasonOf(checkCalldata("38ed1739")), "malformed-calldata");
    assert.equal(reasonOf(checkCalldata("0xZZZZZZZZ")), "malformed-calldata");
    assert.equal(reasonOf(checkCalldata(undefined)), "malformed-calldata");
    assert.equal(reasonOf(checkCalldata(null)), "malformed-calldata");
    assert.equal(reasonOf(checkCalldata(12345678)), "malformed-calldata");
  });

  it("rejects an odd number of hex digits, which cannot be bytes", () => {
    assert.equal(reasonOf(checkCalldata("0x38ed17390")), "malformed-calldata");
  });
});

// ------------------------------------------------------------------ transaction

const intent = (overrides: Partial<Parameters<typeof checkTransactionIntent>[0]> = {}) =>
  checkTransactionIntent({
    chainId: CHAIN,
    expectedChainId: CHAIN,
    to: ROUTER,
    allowedTargets: [ROUTER],
    data: CALLDATA,
    value: 0n,
    ...overrides,
  });

describe("checkTransactionIntent", () => {
  it("accepts a call to the configured router", () => {
    assert.equal(reasonOf(intent()), "ok");
  });

  it("rejects a different chain", () => {
    assert.equal(reasonOf(intent({ chainId: 1 })), "wrong-chain");
    assert.equal(reasonOf(intent({ chainId: 4662 })), "wrong-chain");
  });

  it("rejects a destination that is not an allowed contract", () => {
    assert.equal(reasonOf(intent({ to: ATTACKER })), "unknown-target");
    // The factory is a real Poolix contract, but not one a transaction may be sent to.
    assert.equal(reasonOf(intent({ to: FACTORY })), "unknown-target");
  });

  it("compares the destination without regard to checksum casing", () => {
    assert.equal(reasonOf(intent({ to: ROUTER.toLowerCase() })), "ok");
    assert.equal(reasonOf(intent({ allowedTargets: [ROUTER.toLowerCase() as Address] })), "ok");
  });

  it("rejects a malformed or missing destination", () => {
    assert.equal(reasonOf(intent({ to: "0xnope" })), "malformed-target");
    assert.equal(reasonOf(intent({ to: undefined })), "malformed-target");
    assert.equal(reasonOf(intent({ to: ZERO })), "malformed-target");
  });

  it("refuses when no target is configured at all", () => {
    // An unconfigured deployment must not fall through to signing anything.
    assert.equal(reasonOf(intent({ allowedTargets: [] })), "unknown-target");
  });

  it("rejects malformed calldata", () => {
    assert.equal(reasonOf(intent({ data: "0x" })), "empty-calldata");
    assert.equal(reasonOf(intent({ data: "not calldata" })), "malformed-calldata");
  });

  it("rejects a negative value", () => {
    assert.equal(reasonOf(intent({ value: -1n })), "negative-value");
  });

  it("accepts a positive value, which is how a native swap pays", () => {
    assert.equal(reasonOf(intent({ value: 10n ** 18n })), "ok");
  });
});

// --------------------------------------------------------------------- approval

const approval = (overrides: Partial<Parameters<typeof checkApproval>[0]> = {}) =>
  checkApproval({
    token: TOKEN,
    spender: ROUTER,
    amount: 1_000n,
    allowedSpenders: [ROUTER],
    ...overrides,
  });

describe("checkApproval", () => {
  it("accepts an exact approval to the router", () => {
    assert.equal(reasonOf(approval()), "ok");
  });

  it("rejects an unlimited allowance", () => {
    // The single most common way funds are lost long after a forgotten transaction.
    assert.equal(reasonOf(approval({ amount: maxUint256 })), "unlimited-approval");
  });

  it("accepts maxUint256 minus one, so the check is the value and not the magnitude", () => {
    assert.equal(reasonOf(approval({ amount: maxUint256 - 1n })), "ok");
  });

  it("allows zero, which is the clearing step for USDT-style tokens", () => {
    assert.equal(reasonOf(approval({ amount: 0n })), "ok");
  });

  it("rejects a spender that is not an allowed contract", () => {
    assert.equal(reasonOf(approval({ spender: ATTACKER })), "unknown-spender");
  });

  it("rejects a token approving itself", () => {
    assert.equal(reasonOf(approval({ token: ROUTER, spender: ROUTER })), "self-approval");
  });

  it("rejects malformed token and spender addresses", () => {
    assert.equal(reasonOf(approval({ token: "0x00" })), "malformed-token");
    assert.equal(reasonOf(approval({ spender: "" })), "unknown-spender");
    assert.equal(reasonOf(approval({ token: ZERO })), "malformed-token");
  });

  it("rejects a negative amount", () => {
    assert.equal(reasonOf(approval({ amount: -1n })), "zero-amount");
  });
});
