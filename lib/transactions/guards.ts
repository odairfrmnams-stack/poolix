import { maxUint256 } from "viem";

import { sameAddress, toAddress } from "@/lib/address";
import type { Address } from "@/types/web3";

/*
  Last-line checks on a transaction before a wallet is asked to sign it.

  Every one of these properties is already true by construction today: the swap adapter
  always targets the configured router, approvals are always the exact spend, the deadline
  always comes from a UI control clamped to three hours. This file exists because "true by
  construction" is a statement about the three callers that exist right now, and the cost
  of it becoming false is a user's funds.

  So the properties are asserted at the one point every signature passes through, where a
  new caller cannot avoid them.

  These guards are pure and take the expected values as arguments rather than importing
  config, so a test can state the whole intent — chain, target, calldata, amount — and
  assert the answer without a wallet, a network or a mock.
*/

/** Matches the 180-minute ceiling the deadline control allows. */
export const MAX_DEADLINE_SECONDS = 180 * 60;

/** Below this a deadline cannot survive even one block's latency. */
const MIN_DEADLINE_SECONDS = 1;

export type TransactionRejection =
  | "wrong-chain"
  | "unknown-target"
  | "malformed-target"
  | "malformed-calldata"
  | "empty-calldata"
  | "negative-value"
  | "deadline-not-finite"
  | "deadline-expired"
  | "deadline-too-far"
  | "zero-amount"
  | "unlimited-approval"
  | "malformed-token"
  | "unknown-spender"
  | "self-approval";

export type GuardResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: TransactionRejection; readonly detail: string };

const pass: GuardResult = { ok: true };
const fail = (reason: TransactionRejection, detail: string): GuardResult => ({ ok: false, reason, detail });

/**
 * A deadline must be a real moment, still ahead of us, and not so far ahead that it
 * stops being a deadline.
 *
 * The far-future bound is the one worth explaining. A swap signed with an effectively
 * unbounded deadline can be held by a block producer and executed much later, at whatever
 * price then prevails — the transaction stays valid, the quote it was signed against does
 * not. That is the same class of harm as unbounded slippage, and it is why the estimation
 * constant (2^48 seconds) must never reach a signature.
 */
export function checkDeadline(deadline: bigint, nowSeconds: number): GuardResult {
  if (!Number.isFinite(nowSeconds)) return fail("deadline-not-finite", "the current time is not a number");

  const now = BigInt(Math.floor(nowSeconds));
  if (deadline <= 0n) return fail("deadline-not-finite", "the deadline is not a positive timestamp");
  if (deadline < now + BigInt(MIN_DEADLINE_SECONDS)) {
    return fail("deadline-expired", "the deadline has already passed");
  }
  if (deadline > now + BigInt(MAX_DEADLINE_SECONDS)) {
    return fail(
      "deadline-too-far",
      `the deadline is more than ${String(MAX_DEADLINE_SECONDS / 60)} minutes away`,
    );
  }
  return pass;
}

/** Calldata must be a 0x-prefixed even-length hex string carrying at least a selector. */
export function checkCalldata(data: unknown): GuardResult {
  if (typeof data !== "string" || !data.startsWith("0x")) {
    return fail("malformed-calldata", "calldata is not a hex string");
  }
  // "0x" + 8 selector characters.
  if (data.length < 10) return fail("empty-calldata", "calldata carries no function selector");
  if (data.length % 2 !== 0) return fail("malformed-calldata", "calldata has an odd number of hex digits");
  if (!/^0x[0-9a-fA-F]+$/.test(data)) return fail("malformed-calldata", "calldata contains non-hex characters");
  return pass;
}

export interface TransactionIntent {
  readonly chainId: number;
  readonly expectedChainId: number;
  readonly to: unknown;
  /** The only contracts this application ever asks a wallet to call. */
  readonly allowedTargets: readonly Address[];
  readonly data: unknown;
  readonly value: bigint;
}

/**
 * Everything that must hold before a wallet is asked to sign a contract call.
 *
 * `allowedTargets` is the important argument. Poolix calls exactly one contract for swaps
 * and liquidity — the configured router — so an intent aimed anywhere else is a defect,
 * and the only safe response to a defect in a signing path is to refuse.
 */
export function checkTransactionIntent(intent: TransactionIntent): GuardResult {
  if (intent.chainId !== intent.expectedChainId) {
    return fail(
      "wrong-chain",
      `chain ${String(intent.chainId)} is not the configured chain ${String(intent.expectedChainId)}`,
    );
  }

  const to = toAddress(intent.to);
  if (to === null) return fail("malformed-target", "the destination is not a valid address");

  if (intent.allowedTargets.length === 0) {
    return fail("unknown-target", "no destination contract is configured");
  }
  if (!intent.allowedTargets.some((allowed) => sameAddress(allowed, to))) {
    return fail("unknown-target", "the destination is not a Poolix contract");
  }

  const calldata = checkCalldata(intent.data);
  if (!calldata.ok) return calldata;

  if (intent.value < 0n) return fail("negative-value", "the value is negative");

  return pass;
}

export interface ApprovalIntent {
  readonly token: unknown;
  readonly spender: unknown;
  readonly amount: bigint;
  /** The only contracts this application ever asks for an allowance. */
  readonly allowedSpenders: readonly Address[];
}

/**
 * Everything that must hold before a wallet is asked to sign an approval.
 *
 * The unlimited-approval check is not a style preference. An exact approval leaves nothing
 * behind after the trade; `maxUint256` leaves a standing permission over the user's entire
 * balance of that token, indefinitely, redeemable by whoever controls the spender — which
 * is the single most common way funds are lost long after a transaction the user has
 * forgotten. Poolix has never issued one, and this is what keeps it that way.
 */
export function checkApproval(intent: ApprovalIntent): GuardResult {
  const token = toAddress(intent.token);
  if (token === null) return fail("malformed-token", "the token is not a valid address");

  const spender = toAddress(intent.spender);
  if (spender === null) return fail("unknown-spender", "the spender is not a valid address");

  if (sameAddress(token, spender)) {
    return fail("self-approval", "a token cannot be its own spender");
  }
  if (!intent.allowedSpenders.some((allowed) => sameAddress(allowed, spender))) {
    return fail("unknown-spender", "the spender is not a Poolix contract");
  }
  if (intent.amount === maxUint256) {
    return fail("unlimited-approval", "an unlimited allowance was requested");
  }
  /*
    Zero is legitimate — it is the clearing step for tokens that refuse a non-zero to
    non-zero allowance change — so it is checked by the caller, which knows which step it
    is on, rather than banned here.
  */
  if (intent.amount < 0n) return fail("zero-amount", "the amount is negative");

  return pass;
}
