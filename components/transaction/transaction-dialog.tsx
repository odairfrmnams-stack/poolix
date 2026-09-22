"use client";

import { CheckCircle2, ExternalLink, XCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { poolixConfig } from "@/config/poolix";
import { copy } from "@/lib/copy";
import { explorerUrl } from "@/lib/format";
import { isSettled, transactionStatusLabel, type TransactionState } from "@/lib/transactions/machine";
import type { Hash } from "@/types/web3";

interface TransactionDialogProps {
  state: TransactionState;
  onClose: () => void;
  onRetry?: () => void;
  /** What is being confirmed, e.g. "Swap" or "Add Liquidity". */
  action: string;
}

function activeHash(state: TransactionState): Hash | null {
  switch (state.status) {
    case "approving":
      return state.approvalHash;
    case "approved":
      return state.approvalHash;
    case "pending":
    case "confirmed":
      return state.hash;
    case "failed":
      return state.hash;
    default:
      return null;
  }
}

export function TransactionDialog({ state, onClose, onRetry, action }: TransactionDialogProps) {
  const open = state.status !== "idle";
  const hash = activeHash(state);
  const settled = isSettled(state);

  const { title, message } = describe(state, action);

  return (
    <Dialog
      open={open}
      // A transaction in flight keeps running; closing only dismisses the dialog.
      onClose={onClose}
      title={title}
      hideTitle
      className="sm:max-w-[400px]"
    >
      <div className="px-6 py-8 text-center">
        <div className="flex justify-center" aria-hidden="true">
          {state.status === "confirmed" ? (
            <CheckCircle2 className="size-11 text-accent" strokeWidth={1.4} />
          ) : state.status === "failed" || state.status === "rejected" ? (
            <XCircle className="size-11 text-negative" strokeWidth={1.4} />
          ) : (
            <Spinner />
          )}
        </div>

        <h2 className="mt-5 text-[17px] font-medium text-fg">{title}</h2>
        <p className="mx-auto mt-2 max-w-[19rem] text-[13px] leading-relaxed text-muted">{message}</p>

        {!settled ? (
          <p className="mt-4 text-[11.5px] tracking-wide text-subtle uppercase" aria-live="polite">
            {transactionStatusLabel(state)}
          </p>
        ) : null}

        <div className="mt-7 flex flex-col gap-2">
          {hash !== null ? (
            <a
              href={explorerUrl(poolixConfig.explorerUrl, "tx", hash)}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex h-10 items-center justify-center gap-2 rounded-poolix border border-line text-[13.5px] text-muted transition-colors hover:border-line-strong hover:text-fg"
            >
              {copy.transaction.viewOnExplorer}
              <ExternalLink className="size-3.5" aria-hidden="true" />
            </a>
          ) : null}

          {state.status === "confirmed" ? (
            <Button onClick={onClose} full>
              {copy.transaction.done}
            </Button>
          ) : null}

          {(state.status === "failed" || state.status === "rejected") && onRetry ? (
            <Button onClick={onRetry} full>
              {copy.transaction.tryAgain}
            </Button>
          ) : null}
        </div>
      </div>
    </Dialog>
  );
}

function describe(state: TransactionState, action: string): { title: string; message: string } {
  switch (state.status) {
    case "preparing":
      return { title: copy.loading.preparingTransaction, message: `Checking the ${action.toLowerCase()} before you sign.` };
    case "approving":
      return state.approvalHash === null
        ? { title: copy.transaction.status.awaitingApproval, message: "Confirm the token approval in your wallet." }
        : { title: copy.transaction.status.approving, message: copy.transaction.pendingMessage };
    case "approved":
      return { title: copy.transaction.status.approved, message: `Preparing the ${action.toLowerCase()}.` };
    case "confirming":
      return { title: copy.transaction.status.confirming, message: `Confirm the ${action.toLowerCase()} in your wallet.` };
    case "pending":
      return { title: copy.transaction.pendingTitle, message: copy.transaction.pendingMessage };
    case "confirmed":
      return { title: copy.transaction.confirmedTitle, message: copy.transaction.confirmedMessage };
    case "failed":
      return { title: state.error.title, message: state.error.message };
    case "rejected":
      return { title: copy.errors.transactionRejected.title, message: copy.errors.transactionRejected.message };
    case "idle":
      return { title: "", message: "" };
  }
}

function Spinner() {
  return (
    <span className="size-11 animate-spin rounded-full border-2 border-line-strong border-t-accent" role="status">
      <span className="sr-only">{copy.loading.waitingForConfirmation}</span>
    </span>
  );
}
