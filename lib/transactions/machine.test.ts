import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createPoolixError } from "@/lib/errors";
import {
  initialTransactionState,
  transactionReducer,
  transactionStatusLabel,
  type TransactionEvent,
  type TransactionState,
} from "@/lib/transactions/machine";

const approvalHash = "0xaaaa" as const;
const swapHash = "0xbbbb" as const;
const staleHash = "0xcccc" as const;

function run(events: readonly TransactionEvent[], from: TransactionState = initialTransactionState) {
  return events.reduce(transactionReducer, from);
}

describe("transactionReducer", () => {
  it("runs the full approval and swap flow", () => {
    const labels: (string | null)[] = [];
    let state = initialTransactionState;
    const events: TransactionEvent[] = [
      { type: "PREPARE" },
      { type: "REQUEST_APPROVAL" },
      { type: "APPROVAL_SUBMITTED", hash: approvalHash },
      { type: "APPROVAL_CONFIRMED", hash: approvalHash },
      { type: "REQUEST_CONFIRMATION" },
      { type: "SUBMITTED", hash: swapHash },
      { type: "CONFIRMED", hash: swapHash },
    ];
    for (const event of events) {
      state = transactionReducer(state, event);
      labels.push(transactionStatusLabel(state));
    }
    assert.deepEqual(state, { status: "confirmed", hash: swapHash });
    assert.deepEqual(labels, [
      "Preparing",
      "Awaiting Approval",
      "Approving",
      "Approved",
      "Confirming",
      "Pending",
      "Confirmed",
    ]);
  });

  it("skips approval when no allowance is needed", () => {
    const state = run([
      { type: "PREPARE" },
      { type: "REQUEST_CONFIRMATION" },
      { type: "SUBMITTED", hash: swapHash },
      { type: "CONFIRMED", hash: swapHash },
    ]);
    assert.equal(state.status, "confirmed");
  });

  it("ignores a receipt for a different transaction", () => {
    const pending = run([{ type: "PREPARE" }, { type: "REQUEST_CONFIRMATION" }, { type: "SUBMITTED", hash: swapHash }]);
    assert.equal(transactionReducer(pending, { type: "CONFIRMED", hash: staleHash }), pending);
  });

  it("returns the same object for events that do not apply", () => {
    assert.equal(transactionReducer(initialTransactionState, { type: "SUBMITTED", hash: swapHash }), initialTransactionState);
  });

  it("allows rejection only while a wallet prompt can be open", () => {
    const awaitingApproval = run([{ type: "PREPARE" }, { type: "REQUEST_APPROVAL" }]);
    assert.deepEqual(transactionReducer(awaitingApproval, { type: "REJECTED" }), { status: "rejected" });

    const approvalSubmitted = transactionReducer(awaitingApproval, { type: "APPROVAL_SUBMITTED", hash: approvalHash });
    assert.equal(transactionReducer(approvalSubmitted, { type: "REJECTED" }), approvalSubmitted);
  });

  it("fails with approval copy when the approval reverts", () => {
    const state = run([
      { type: "PREPARE" },
      { type: "REQUEST_APPROVAL" },
      { type: "APPROVAL_SUBMITTED", hash: approvalHash },
      { type: "APPROVAL_REVERTED", hash: approvalHash },
    ]);
    assert.equal(state.status, "failed");
    assert.equal(state.status === "failed" && state.error.kind, "approvalFailed");
    assert.equal(state.status === "failed" && state.hash, approvalHash);
  });

  it("keeps the hash when tracking fails so the explorer link stays available", () => {
    const pending = run([{ type: "PREPARE" }, { type: "REQUEST_CONFIRMATION" }, { type: "SUBMITTED", hash: swapHash }]);
    const failed = transactionReducer(pending, { type: "FAILED", error: createPoolixError("rpcUnavailable") });
    assert.deepEqual(failed, { status: "failed", hash: swapHash, error: createPoolixError("rpcUnavailable") });
  });

  it("does not reset while a transaction is still pending", () => {
    const pending = run([{ type: "PREPARE" }, { type: "REQUEST_CONFIRMATION" }, { type: "SUBMITTED", hash: swapHash }]);
    assert.equal(transactionReducer(pending, { type: "RESET" }), pending);
  });

  it("allows retry and reset after settling", () => {
    const rejected = run([{ type: "PREPARE" }, { type: "REQUEST_CONFIRMATION" }, { type: "REJECTED" }]);
    assert.deepEqual(transactionReducer(rejected, { type: "PREPARE" }), { status: "preparing" });
    assert.equal(transactionReducer(rejected, { type: "RESET" }), initialTransactionState);
  });
});
