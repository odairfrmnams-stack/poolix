import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { classifyError } from "@/lib/errors";
import { uniswapV2RevertReasons } from "@/services/liquidity/uniswap-v2/revert-reasons";

function namedError(name: string, message: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), { name }, extra);
}

describe("classifyError", () => {
  it("detects wallet rejection by EIP-1193 code or error name, including nested causes", () => {
    assert.equal(classifyError({ code: 4001, message: "User rejected" }).kind, "transactionRejected");
    const wrapped = new Error("Contract call failed", {
      cause: namedError("UserRejectedRequestError", "User rejected the request."),
    });
    assert.equal(classifyError(wrapped).kind, "transactionRejected");
  });

  it("detects wrong network", () => {
    assert.equal(classifyError(namedError("ChainMismatchError", "mismatch")).kind, "wrongNetwork");
    assert.equal(classifyError({ code: 4902 }).kind, "wrongNetwork");
  });

  it("detects insufficient native balance", () => {
    assert.equal(
      classifyError(namedError("InsufficientFundsError", "insufficient funds for gas * price + value")).kind,
      "insufficientBalance",
    );
  });

  it("maps Uniswap v2 revert reasons before the generic revert", () => {
    const revert = new Error("Execution reverted", {
      cause: namedError("ContractFunctionRevertedError", "reverted", {
        reason: "UniswapV2Router: INSUFFICIENT_OUTPUT_AMOUNT",
      }),
    });
    assert.equal(classifyError(revert, uniswapV2RevertReasons).kind, "slippageExceeded");
    assert.equal(classifyError(revert).kind, "transactionReverted");

    const expired = namedError("ContractFunctionRevertedError", "reverted", { reason: "UniswapV2Router: EXPIRED" });
    assert.equal(classifyError(expired, uniswapV2RevertReasons).kind, "deadlineExpired");
  });

  it("detects RPC failures", () => {
    assert.equal(classifyError(namedError("HttpRequestError", "HTTP request failed.")).kind, "rpcUnavailable");
    assert.equal(classifyError(new TypeError("Failed to fetch")).kind, "rpcUnavailable");
  });

  it("returns human-readable copy for unknown values, including cyclic causes", () => {
    const cyclic: Record<string, unknown> = { message: "loop" };
    cyclic.cause = cyclic;
    const result = classifyError(cyclic);
    assert.equal(result.kind, "unexpected");
    assert.equal(result.title, "Unexpected Error");
    assert.equal(classifyError(undefined).kind, "unexpected");
  });
});
