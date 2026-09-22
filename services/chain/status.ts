import "server-only";

import { unstable_cache } from "next/cache";

import { poolixConfig } from "@/config/poolix";

export interface ChainStatus {
  readonly chainId: number | null;
  readonly blockNumber: number | null;
}

function rpcUrl(): string {
  const configured = process.env.RPC_URL?.trim();
  return configured && configured.length > 0 ? configured : poolixConfig.rpcUrl;
}

/** Returns nulls rather than throwing, so the page can render `--` for an unreachable node. */
async function readStatus(): Promise<ChainStatus> {
  try {
    const response = await fetch(rpcUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([
        { jsonrpc: "2.0", id: 0, method: "eth_chainId", params: [] },
        { jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] },
      ]),
    });
    if (!response.ok) return { chainId: null, blockNumber: null };

    const json: unknown = await response.json();
    if (!Array.isArray(json)) return { chainId: null, blockNumber: null };

    const byId = new Map<number, string>();
    for (const entry of json) {
      if (typeof entry === "object" && entry !== null && "id" in entry && "result" in entry) {
        const record = entry as { id: number; result?: string };
        if (typeof record.result === "string") byId.set(record.id, record.result);
      }
    }

    const chainId = byId.get(0);
    const blockNumber = byId.get(1);
    return {
      chainId: chainId === undefined ? null : Number(BigInt(chainId)),
      blockNumber: blockNumber === undefined ? null : Number(BigInt(blockNumber)),
    };
  } catch {
    return { chainId: null, blockNumber: null };
  }
}

const cachedStatus = unstable_cache(readStatus, ["poolix:chain-status"], {
  revalidate: 30,
  tags: ["chain-status"],
});

/**
 * Chain id and tip, cached for 30 seconds inside a request and read directly outside one.
 *
 * `unstable_cache` needs Next's incremental cache, which exists during a render and not in
 * a plain Node process — a verifier importing this module used to die on an "incrementalCache
 * missing" invariant before it could check anything. Falling back to the uncached read keeps
 * the caching where it pays for itself and makes the function callable from a script, which
 * is what lets the dashboard be verified through the same code path the page uses rather
 * than through a copy of it.
 *
 * The fallback is narrow on purpose: only the missing-cache invariant is swallowed. A real
 * failure inside readStatus is already handled there by returning nulls.
 */
export async function fetchChainStatus(): Promise<ChainStatus> {
  try {
    return await cachedStatus();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("incrementalCache")) throw error;
    return readStatus();
  }
}
