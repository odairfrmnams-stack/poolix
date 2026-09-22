import "server-only";

import { encodeFunctionData, erc20Abi } from "viem";

import {
  aggregate3,
  multicallAvailable,
  MULTICALL_BATCH_SIZE,
} from "@/services/chain/multicall";
import { pacedCalls, type RpcCall } from "@/services/chain/rpc";
import type { Address, Hex } from "@/types/web3";

/*
  Confirms reconstructed balances against the token contract itself.

  Replaying Transfer events gives a balance that is only as truthful as the events. It was
  not a theoretical worry here: a token in the scanned universe emits Transfer events that
  move no state — one address alone "sent" about 135x the entire supply — which inflated
  the replayed holder count for that token from 30 to 918, and the chain-wide count by
  roughly 60%.

  So the replay is demoted to what it is genuinely good at: finding every address that
  could possibly hold the token, cheaply, from one indexed source. `balanceOf` then decides
  which of them actually do. That is the contract's own answer, and there is no more
  authoritative one.

  The remaining limit is stated rather than hidden: an address that holds a token without
  ever appearing in one of its Transfer events is invisible to the candidate sweep, because
  nothing on chain points to it.
*/

/**
 * Candidates per eth_call batch.
 *
 * 400 came from measuring allPairs/getReserves, where the endpoint answered 800 calls in
 * one request at 1.1ms each. balanceOf is not that workload — it runs contract code per
 * call — and re-measuring it against this very endpoint gives the opposite answer:
 *
 *     batch    5    58.1 ms/call        batch   50    49.8 ms/call
 *     batch   10    29.5 ms/call        batch  100    47.4 ms/call
 *     batch   15    58.6 ms/call        batch  200    50.0 ms/call
 *     batch   25    12.0-20.6 ms/call   batch  400    49.9 ms/call
 *
 * Per-request latency grows faster than the batch does, so bundling harder makes the
 * whole pass slower. 25 was the fastest in every trial, by roughly 2.4x over 400.
 * Latency on this endpoint is noisy, hence the range.
 */
const BATCH_SIZE = 25;
const PAUSE_MS = 120;
/**
 * Passes over the candidates, retrying only the ones that came back unanswered.
 *
 * A confirmation is published only when every candidate answered, so without this a
 * single throttled call discards the whole pass — and under sustained load that repeats
 * every tick and the figure never appears at all. Retrying the gaps keeps the strictness
 * (nothing is assumed to be zero) while letting the pass actually finish.
 */
const PASSES = 3;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface ConfirmedBalances {
  /** Confirmed balance per address. Absent when the call could not be answered. */
  readonly balances: Map<string, bigint>;
  /** True when every candidate was answered; a partial result must not be published. */
  readonly complete: boolean;
  /** Candidates the endpoint did not answer within the deadline. */
  readonly unanswered: number;
}

/**
 * Reads a whole pass through Multicall3, or null when this chain cannot.
 *
 * Null means "use the other path" and never "these addresses hold nothing" — it is
 * returned only when the contract is absent or a request did not come back at all, so no
 * address is ever decided by this function failing.
 */
async function batchedBalances(
  calls: readonly RpcCall[],
  deadline: number,
): Promise<(Hex | null)[] | null> {
  if (!(await multicallAvailable())) return null;

  const results: (Hex | null)[] = [];
  for (let index = 0; index < calls.length; index += MULTICALL_BATCH_SIZE) {
    // Past the deadline the rest are unanswered, exactly as pacedCalls reports them.
    if (Date.now() >= deadline) {
      results.push(...Array<Hex | null>(calls.length - results.length).fill(null));
      return results;
    }

    const slice = calls.slice(index, index + MULTICALL_BATCH_SIZE);
    const batch = await aggregate3(slice);
    // One refused request is not evidence the chain lacks multicall; leave those addresses
    // unanswered and carry on, so a transient failure costs a retry rather than the pass.
    results.push(...(batch ?? Array<Hex | null>(slice.length).fill(null)));
    if (index + MULTICALL_BATCH_SIZE < calls.length) await sleep(PAUSE_MS);
  }
  return results;
}

function decodeBalance(value: Hex | null): bigint | null {
  // A balance is one uint256 word. Anything else — a revert, an empty return from a
  // non-token address, a truncated response — is unknown, and unknown is not zero.
  if (value === null || value.length !== 66) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

/**
 * Reads `balanceOf` for every candidate address of one token.
 *
 * Addresses whose call went unanswered are left out of the map entirely rather than
 * recorded as zero, and `complete` says whether that happened, so a throttled read can
 * never quietly shrink the holder count.
 */
export async function confirmBalances(
  token: string,
  candidates: readonly string[],
  deadline: number,
): Promise<ConfirmedBalances> {
  if (candidates.length === 0) return { balances: new Map(), complete: true, unanswered: 0 };

  const balances = new Map<string, bigint>();
  let pending = [...candidates];

  for (let pass = 0; pass < PASSES && pending.length > 0; pass++) {
    if (Date.now() >= deadline) break;

    const calls: RpcCall[] = pending.map((address) => ({
      to: token as Address,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [address as Address] }),
    }));

    /*
      aggregate3 when the chain has it, the per-call path when it does not.

      Identical question either way: same targets, same calldata, same `latest` tag, same
      order. Only the number posted per request differs — measured 1.34 ms/call batched
      against 12-25 ms/call individually on this endpoint, which is the difference between
      minutes and hours for a token with tens of thousands of candidates.

      A batch that fails falls through to the existing path rather than being assumed, and
      within a batch `allowFailure` means a reverting call decodes to null. Null is this
      function's existing "unanswered": the address stays out of the map and stays queued.
    */
    const results = (await batchedBalances(calls, deadline)) ?? (await pacedCalls(calls, {
      deadline,
      batchSize: BATCH_SIZE,
      pauseMs: PAUSE_MS,
    }));

    const failed: string[] = [];
    for (const [index, address] of pending.entries()) {
      const balance = decodeBalance(results[index] ?? null);
      // Unanswered stays unanswered: a refused read is unknown, and unknown is not zero.
      if (balance === null) failed.push(address);
      else balances.set(address, balance);
    }

    pending = failed;
  }

  return { balances, complete: pending.length === 0, unanswered: pending.length };
}
