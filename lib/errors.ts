import { copy } from "@/lib/copy";

export type PoolixErrorKind = keyof typeof copy.errors;

export interface PoolixError {
  readonly kind: PoolixErrorKind;
  readonly title: string;
  readonly message: string;
}

export interface RevertReasonMatcher {
  readonly pattern: string;
  readonly kind: PoolixErrorKind;
}

const EIP1193_USER_REJECTED = 4001;
const UNRECOGNIZED_CHAIN = 4902;
const MAX_CAUSE_DEPTH = 10;

const REJECTION_NAMES = ["UserRejectedRequestError"];
const WRONG_NETWORK_NAMES = ["ChainMismatchError", "SwitchChainError", "ConnectorChainMismatchError"];
const NOT_CONNECTED_NAMES = ["ConnectorNotConnectedError", "ConnectorAccountNotFoundError"];
const INSUFFICIENT_FUNDS_NAMES = ["InsufficientFundsError"];
const REVERT_NAMES = ["ContractFunctionRevertedError", "ExecutionRevertedError"];
const RPC_FAILURE_NAMES = ["HttpRequestError", "TimeoutError", "WebSocketRequestError"];

export function createPoolixError(kind: PoolixErrorKind): PoolixError {
  const { title, message } = copy.errors[kind];
  return { kind, title, message };
}

interface ErrorFacts {
  readonly names: ReadonlySet<string>;
  readonly codes: ReadonlySet<number>;
  readonly text: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function collectFacts(error: unknown): ErrorFacts {
  const names = new Set<string>();
  const codes = new Set<number>();
  const texts: string[] = [];
  const visited = new Set<unknown>();

  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && isRecord(current) && !visited.has(current); depth++) {
    visited.add(current);
    if (typeof current.name === "string") names.add(current.name);
    if (typeof current.code === "number") codes.add(current.code);
    for (const key of ["reason", "shortMessage", "details", "message"]) {
      const value = current[key];
      if (typeof value === "string") texts.push(value);
    }
    current = current.cause;
  }

  return { names, codes, text: texts.join("\n") };
}

function hasAnyName(facts: ErrorFacts, candidates: readonly string[]): boolean {
  return candidates.some((name) => facts.names.has(name));
}

export function classifyError(
  error: unknown,
  revertReasons: readonly RevertReasonMatcher[] = [],
): PoolixError {
  const facts = collectFacts(error);

  if (facts.codes.has(EIP1193_USER_REJECTED) || hasAnyName(facts, REJECTION_NAMES)) {
    return createPoolixError("transactionRejected");
  }
  if (facts.codes.has(UNRECOGNIZED_CHAIN) || hasAnyName(facts, WRONG_NETWORK_NAMES)) {
    return createPoolixError("wrongNetwork");
  }
  if (hasAnyName(facts, NOT_CONNECTED_NAMES)) {
    return createPoolixError("walletNotConnected");
  }
  if (hasAnyName(facts, INSUFFICIENT_FUNDS_NAMES) || /insufficient funds/i.test(facts.text)) {
    return createPoolixError("insufficientBalance");
  }

  const matchedReason = revertReasons.find(({ pattern }) => facts.text.includes(pattern));
  if (matchedReason) return createPoolixError(matchedReason.kind);

  if (hasAnyName(facts, REVERT_NAMES)) {
    return createPoolixError("transactionReverted");
  }
  if (hasAnyName(facts, RPC_FAILURE_NAMES) || /failed to fetch/i.test(facts.text)) {
    return createPoolixError("rpcUnavailable");
  }
  return createPoolixError("unexpected");
}
