import { copy } from "@/lib/copy";
import { createPoolixError, type PoolixError } from "@/lib/errors";
import type { Hash } from "@/types/web3";

export type TransactionState =
  | { readonly status: "idle" }
  | { readonly status: "preparing" }
  | { readonly status: "approving"; readonly approvalHash: Hash | null }
  | { readonly status: "approved"; readonly approvalHash: Hash }
  | { readonly status: "confirming" }
  | { readonly status: "pending"; readonly hash: Hash }
  | { readonly status: "confirmed"; readonly hash: Hash }
  | { readonly status: "failed"; readonly hash: Hash | null; readonly error: PoolixError }
  | { readonly status: "rejected" };

export type TransactionStatus = TransactionState["status"];

export type TransactionEvent =
  | { readonly type: "PREPARE" }
  | { readonly type: "REQUEST_APPROVAL" }
  | { readonly type: "APPROVAL_SUBMITTED"; readonly hash: Hash }
  | { readonly type: "APPROVAL_CONFIRMED"; readonly hash: Hash }
  | { readonly type: "APPROVAL_REVERTED"; readonly hash: Hash }
  | { readonly type: "REQUEST_CONFIRMATION" }
  | { readonly type: "SUBMITTED"; readonly hash: Hash }
  | { readonly type: "CONFIRMED"; readonly hash: Hash }
  | { readonly type: "REVERTED"; readonly hash: Hash }
  | { readonly type: "REJECTED" }
  | { readonly type: "FAILED"; readonly error: PoolixError }
  | { readonly type: "RESET" };

export const initialTransactionState: TransactionState = { status: "idle" };

export function isSettled(state: TransactionState): boolean {
  return state.status === "confirmed" || state.status === "failed" || state.status === "rejected";
}

function trackedHash(state: TransactionState): Hash | null {
  if (state.status === "pending") return state.hash;
  if (state.status === "approving") return state.approvalHash;
  return null;
}

function isInFlight(state: TransactionState): boolean {
  return state.status !== "idle" && !isSettled(state);
}

/**
 * Events that do not apply to the current state return the same state object,
 * so stale wallet or receipt callbacks cannot move a newer transaction.
 */
export function transactionReducer(state: TransactionState, event: TransactionEvent): TransactionState {
  switch (event.type) {
    case "PREPARE":
      return state.status === "idle" || isSettled(state) ? { status: "preparing" } : state;
    case "REQUEST_APPROVAL":
      return state.status === "preparing" ? { status: "approving", approvalHash: null } : state;
    case "APPROVAL_SUBMITTED":
      return state.status === "approving" && state.approvalHash === null
        ? { status: "approving", approvalHash: event.hash }
        : state;
    case "APPROVAL_CONFIRMED":
      return state.status === "approving" && state.approvalHash === event.hash
        ? { status: "approved", approvalHash: event.hash }
        : state;
    case "APPROVAL_REVERTED":
      return state.status === "approving" && state.approvalHash === event.hash
        ? { status: "failed", hash: event.hash, error: createPoolixError("approvalFailed") }
        : state;
    case "REQUEST_CONFIRMATION":
      return state.status === "preparing" || state.status === "approved" ? { status: "confirming" } : state;
    case "SUBMITTED":
      return state.status === "confirming" ? { status: "pending", hash: event.hash } : state;
    case "CONFIRMED":
      return state.status === "pending" && state.hash === event.hash
        ? { status: "confirmed", hash: event.hash }
        : state;
    case "REVERTED":
      return state.status === "pending" && state.hash === event.hash
        ? { status: "failed", hash: event.hash, error: createPoolixError("transactionReverted") }
        : state;
    case "REJECTED":
      return (state.status === "approving" && state.approvalHash === null) || state.status === "confirming"
        ? { status: "rejected" }
        : state;
    case "FAILED":
      return isInFlight(state) ? { status: "failed", hash: trackedHash(state), error: event.error } : state;
    case "RESET":
      return isSettled(state) ? initialTransactionState : state;
  }
}

export function transactionStatusLabel(state: TransactionState): string | null {
  const labels = copy.transaction.status;
  switch (state.status) {
    case "idle":
      return null;
    case "approving":
      return state.approvalHash === null ? labels.awaitingApproval : labels.approving;
    default:
      return labels[state.status];
  }
}
