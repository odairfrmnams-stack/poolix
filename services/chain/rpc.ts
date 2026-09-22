import "server-only";

import { poolixConfig } from "@/config/poolix";
import type { Address, Hex } from "@/types/web3";

/*
  Batched eth_call against the configured endpoint.

  Robinhood Chain's public RPC throttles after a short burst, so reads are paced: one
  batch at a time with a pause between them, retried with backoff on 429. Batching happens
  at the JSON-RPC layer, which works for any call to any contract.

  Note that Multicall3 IS deployed on this chain and `aggregate3` does work — Phase 6
  verified it at 0xcA11bde05977b3631167028862bE2a173976CA11 and measured it about eleven
  times faster. It is used by services/chain/multicall.ts for the one workload that needed
  it. An earlier comment here claimed the opposite; it was wrong, and the probe that
  produced that conclusion was misleading because aggregate3 reverts on an empty array.

  Every call that cannot be answered decodes as `null`, which callers must treat as
  "unknown" rather than "zero" — the difference between a missing reading and a real one.
*/

export const DEFAULT_BATCH_SIZE = 40;
const BATCH_PAUSE_MS = 120;
const MAX_ATTEMPTS = 3;

/*
  Every request is bounded.

  Node's fetch has no default timeout, so a connection that opens and then stalls never
  returns. The retry ceiling does not help — a hang never reaches the retry — and neither
  does the caller's deadline, which is only consulted between batches. Without this, one
  unlucky socket holds a tick open indefinitely and, during a render, holds the page.
*/
const BLOCK_NUMBER_TIMEOUT_MS = 10_000;
const BATCH_TIMEOUT_MS = 30_000;

export interface RpcCall {
  readonly to: Address;
  readonly data: Hex;
}

export interface PacedCallOptions {
  /** Stop issuing batches once this timestamp passes; the rest decode as null. */
  readonly deadline: number;
  readonly batchSize?: number;
  readonly pauseMs?: number;
}

export function rpcUrl(): string {
  const configured = process.env.RPC_URL?.trim();
  return configured !== undefined && configured.length > 0 ? configured : poolixConfig.rpcUrl;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The block the endpoint is currently serving, or null if it cannot be asked.
 *
 * Reads here use the `latest` tag rather than a pinned height, because this endpoint
 * does not promise archive state. Callers that need to say which block a reading came
 * from ask for this first, and should treat it as the tip at the start of their reads.
 */
export async function fetchBlockNumber(): Promise<number | null> {
  try {
    const response = await fetch(rpcUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // No cache option: this is a POST, which Next never puts in the Data Cache, and
      // an explicit "no-store" would opt the whole route out of static rendering.
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
      signal: AbortSignal.timeout(BLOCK_NUMBER_TIMEOUT_MS),
    });
    if (!response.ok) return null;

    const json: unknown = await response.json();
    const result = (json as { result?: string }).result;
    if (typeof result !== "string") return null;

    const block = Number(BigInt(result));
    return Number.isSafeInteger(block) ? block : null;
  } catch {
    return null;
  }
}

/** One batched eth_call request, retried with backoff when the endpoint throttles. */
export async function batchedCall(calls: readonly RpcCall[]): Promise<readonly (Hex | null)[]> {
  if (calls.length === 0) return [];

  const payload = calls.map((call, id) => ({
    jsonrpc: "2.0",
    id,
    method: "eth_call",
    params: [{ to: call.to, data: call.data }, "latest"],
  }));

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(rpcUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        // A timeout aborts, which throws, which the catch below turns into a paced retry.
        signal: AbortSignal.timeout(BATCH_TIMEOUT_MS),
      });

      if (response.status === 429) {
        await sleep(BATCH_PAUSE_MS * 8 * (attempt + 1));
        continue;
      }
      if (!response.ok) return calls.map(() => null);

      const json: unknown = await response.json();
      if (!Array.isArray(json)) return calls.map(() => null);

      const byId = new Map<number, Hex | null>();
      for (const entry of json) {
        if (typeof entry === "object" && entry !== null && "id" in entry) {
          const record = entry as { id: number; result?: Hex };
          byId.set(record.id, record.result ?? null);
        }
      }
      return calls.map((_, id) => byId.get(id) ?? null);
    } catch {
      await sleep(BATCH_PAUSE_MS * 4 * (attempt + 1));
    }
  }
  return calls.map(() => null);
}

/**
 * Runs batches one at a time with a pause, which is what keeps the endpoint happy.
 * Stops at the deadline and pads the remainder with nulls, which decode as "skipped".
 */
export async function pacedCalls(
  calls: readonly RpcCall[],
  options: PacedCallOptions,
): Promise<readonly (Hex | null)[]> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const pauseMs = options.pauseMs ?? BATCH_PAUSE_MS;

  const results: (Hex | null)[] = [];
  for (let index = 0; index < calls.length; index += batchSize) {
    if (Date.now() > options.deadline) {
      results.push(...Array<Hex | null>(calls.length - results.length).fill(null));
      return results;
    }
    if (index > 0) await sleep(pauseMs);
    results.push(...(await batchedCall(calls.slice(index, index + batchSize))));
  }
  return results;
}
