"use client";

import { useCallback, useReducer } from "react";
import { encodeFunctionData, erc20Abi } from "viem";
import { usePublicClient, useSendTransaction } from "wagmi";

import { classifyError, createPoolixError, type RevertReasonMatcher } from "@/lib/errors";
import {
  checkApproval,
  checkDeadline,
  checkTransactionIntent,
  type GuardResult,
} from "@/lib/transactions/guards";
import {
  initialTransactionState,
  transactionReducer,
  type TransactionState,
} from "@/lib/transactions/machine";
import { poolixChain } from "@/lib/wagmi";
import type { PreparedCall } from "@/services/liquidity/types";
import type { Address } from "@/types/web3";

export interface ApprovalRequest {
  readonly token: Address;
  readonly spender: Address;
  readonly amount: bigint;
  readonly currentAllowance: bigint;
}

export interface TransactionRequest {
  readonly account: Address;
  /** Checked in order; those already covered by an allowance are skipped. */
  readonly approvals: readonly ApprovalRequest[];
  readonly call: PreparedCall;
  readonly revertReasons?: readonly RevertReasonMatcher[];
  /**
   * The contracts this request is permitted to touch — the router for the call, and the
   * same router as the approval spender. Required, so adding a caller means stating what
   * it is allowed to reach rather than inheriting a default.
   */
  readonly allowedTargets: readonly Address[];
  /**
   * The deadline encoded in `call.data`, passed alongside it so the flow can check it.
   *
   * The flow cannot decode calldata to find it, and the deadline is the one transaction
   * parameter with no on-chain guard of its own: a router accepts any future timestamp,
   * so an effectively unbounded one lets a signed swap be executed much later at a price
   * the user never saw. Checking it here puts it under the same refusal as the target and
   * the approval, at the only point every signature passes through.
   */
  readonly deadline: bigint;
}

export interface TransactionFlow {
  readonly state: TransactionState;
  readonly execute: (request: TransactionRequest) => Promise<boolean>;
  readonly reset: () => void;
}

/**
 * Runs approvals then a contract call, reporting progress through the shared
 * transaction machine. Every path ends in a settled state, so the UI never sits on a
 * spinner after a rejection or a revert. Resolves true only when the call confirmed.
 */
export function useTransactionFlow(): TransactionFlow {
  const [state, dispatch] = useReducer(transactionReducer, initialTransactionState);
  const publicClient = usePublicClient();
  const { sendTransactionAsync } = useSendTransaction();

  const reset = useCallback(() => dispatch({ type: "RESET" }), []);

  const execute = useCallback(
    async ({
      account,
      approvals,
      call,
      revertReasons,
      allowedTargets,
      deadline,
    }: TransactionRequest): Promise<boolean> => {
      dispatch({ type: "PREPARE" });

      if (publicClient === undefined) {
        dispatch({ type: "FAILED", error: createPoolixError("rpcUnavailable") });
        return false;
      }

      /*
        Refuse before the wallet is ever opened.

        A guard failure here is a defect in Poolix, not a user error and not a chain
        condition — so the response is to stop, not to warn and continue. The user sees a
        blocked transaction; they do not see a signature request for something this code
        could not vouch for.
      */
      const blocked = (guard: GuardResult): boolean => {
        if (guard.ok) return false;
        // Visible in the console for diagnosis; the user gets the stable message.
        console.error(`[poolix] transaction blocked: ${guard.reason} — ${guard.detail}`);
        dispatch({ type: "FAILED", error: createPoolixError("unsafeTransaction") });
        return true;
      };

      if (blocked(checkDeadline(deadline, Date.now() / 1000))) return false;

      if (
        blocked(
          checkTransactionIntent({
            chainId: poolixChain.id,
            expectedChainId: poolixChain.id,
            to: call.to,
            allowedTargets,
            data: call.data,
            value: call.value,
          }),
        )
      ) {
        return false;
      }

      for (const approval of approvals) {
        if (
          blocked(
            checkApproval({
              token: approval.token,
              spender: approval.spender,
              amount: approval.amount,
              allowedSpenders: allowedTargets,
            }),
          )
        ) {
          return false;
        }
      }

      const approve = (token: Address, spender: Address, amount: bigint) =>
        sendTransactionAsync({
          chainId: poolixChain.id,
          to: token,
          data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] }),
        });

      try {
        const outstanding = approvals.filter((approval) => approval.currentAllowance < approval.amount);

        if (outstanding.length > 0) {
          dispatch({ type: "REQUEST_APPROVAL" });

          for (const [index, approval] of outstanding.entries()) {
            // Only the final approval is tracked by the machine; the earlier ones are
            // steps on the way to it and share the same "Awaiting Approval" state.
            const isLast = index === outstanding.length - 1;

            /*
              Some ERC-20s reject a non-zero to non-zero allowance change, so clear
              first when one is already set.
            */
            if (approval.currentAllowance > 0n) {
              const clearHash = await approve(approval.token, approval.spender, 0n);
              await publicClient.waitForTransactionReceipt({ hash: clearHash });
            }

            // Exactly what is being spent, so no standing allowance is left behind.
            const hash = await approve(approval.token, approval.spender, approval.amount);
            if (isLast) dispatch({ type: "APPROVAL_SUBMITTED", hash });

            const receipt = await publicClient.waitForTransactionReceipt({ hash });
            if (receipt.status !== "success") {
              if (isLast) dispatch({ type: "APPROVAL_REVERTED", hash });
              else dispatch({ type: "FAILED", error: createPoolixError("approvalFailed") });
              return false;
            }
            if (isLast) dispatch({ type: "APPROVAL_CONFIRMED", hash });
          }
        }

        /*
          Simulate before prompting the wallet. A revert caught here surfaces the real
          reason — slippage, an expired deadline, missing liquidity — rather than an
          opaque wallet estimation failure.
        */
        await publicClient.call({ account, to: call.to, data: call.data, value: call.value });

        dispatch({ type: "REQUEST_CONFIRMATION" });

        const hash = await sendTransactionAsync({
          chainId: poolixChain.id,
          to: call.to,
          data: call.data,
          value: call.value,
        });
        dispatch({ type: "SUBMITTED", hash });

        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        if (receipt.status === "success") {
          dispatch({ type: "CONFIRMED", hash });
          return true;
        }
        dispatch({ type: "REVERTED", hash });
        return false;
      } catch (error) {
        const poolixError = classifyError(error, revertReasons);
        if (poolixError.kind === "transactionRejected") dispatch({ type: "REJECTED" });
        else dispatch({ type: "FAILED", error: poolixError });
        return false;
      }
    },
    [publicClient, sendTransactionAsync],
  );

  return { state, execute, reset };
}
