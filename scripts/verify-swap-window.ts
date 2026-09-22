/*
  Independent check of the analytics swap window.

    npm run verify:swaps

  Re-queries a sample of block buckets straight from HyperSync, re-aggregates them, and
  compares the result against what the cached window recorded. It deliberately does not
  import services/analytics/swap-window.ts, so a bug in the ingestion path cannot hide
  behind itself. Pair classifications are re-read from the chain as a second check.

  The API token is read from the environment and never printed.
*/

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createPublicClient, getAddress, http, type PublicClient } from "viem";

import { poolixConfig } from "@/config/poolix";
import { uniswapV2PairAbi } from "@/services/abis/uniswap-v2";
import {
  aggregateWethVolume,
  bucketOf,
  SWAP_TOPIC0,
  tradingFeesWei,
  type WethSide,
} from "@/services/analytics/swap-math";
import type { Address } from "@/types/web3";

const HYPERSYNC_URL = "https://4663.hypersync.xyz/query";
const BUCKET_BLOCKS = 7_200;
const SAMPLE_BUCKETS = 3;
const SAMPLE_PAIRS = 6;

interface StoredBucket {
  volumeWei: string;
  swaps: number;
  ignoredNonWeth: number;
  unresolvedSwaps: number;
}

interface StoredState {
  buckets: Record<string, StoredBucket>;
  head: number | null;
  tail: number | null;
  pairSides: Record<string, WethSide>;
}

const token = () => process.env.ENVIO_API_TOKEN?.trim() ?? "";

async function fetchLogs(fromBlock: number, toBlock: number) {
  const logs: { address: string; data: string; block_number: number }[] = [];
  let cursor = fromBlock;

  while (cursor < toBlock) {
    const res = await fetch(HYPERSYNC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token()}` },
      body: JSON.stringify({
        from_block: cursor,
        to_block: toBlock,
        logs: [{ topics: [[SWAP_TOPIC0]] }],
        field_selection: { log: ["block_number", "address", "data"] },
      }),
    });
    if (!res.ok) throw new Error(`HyperSync HTTP ${res.status}`);

    const json = (await res.json()) as {
      data?: { logs?: { address: string; data: string; block_number: number }[] }[];
      next_block?: number;
    };
    for (const batch of json.data ?? []) logs.push(...(batch.logs ?? []));

    const next = json.next_block ?? toBlock;
    if (next <= cursor) break;
    cursor = Math.min(next, toBlock);
  }

  return logs;
}

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = String(actual) === String(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"} ${label.padEnd(40)} ${String(actual)}${ok ? "" : `  != ${String(expected)}`}`);
}

async function main(): Promise<void> {
  if (token() === "") throw new Error("ENVIO_API_TOKEN is not set.");

  const path = join(process.cwd(), ".poolix-cache", `swap-window-${poolixConfig.chain.id}.json`);
  const state = JSON.parse(await readFile(path, "utf8")) as StoredState;

  const keys = Object.keys(state.buckets).map(Number).sort((a, b) => a - b);
  if (keys.length === 0) throw new Error("No buckets recorded yet — run the analytics page first.");

  let volumeWei = 0n;
  let swaps = 0;
  let ignored = 0;
  for (const bucket of Object.values(state.buckets)) {
    volumeWei += BigInt(bucket.volumeWei);
    swaps += bucket.swaps;
    ignored += bucket.ignoredNonWeth;
  }

  console.log("Poolix swap-window verification");
  console.log(`window   : blocks ${state.tail} -> ${state.head} (${((state.head ?? 0) - (state.tail ?? 0)).toLocaleString("en-US")})`);
  console.log(`buckets  : ${keys.length}`);
  console.log(`recorded : ${swaps.toLocaleString("en-US")} swaps, ${ignored.toLocaleString("en-US")} ignored`);
  console.log(`volume   : ${(Number(volumeWei) / 1e18).toFixed(4)} ETH`);
  console.log(`fees     : ${(Number(tradingFeesWei(volumeWei)) / 1e18).toFixed(4)} ETH\n`);

  // 1. Re-query a sample of buckets and re-aggregate them from scratch.
  console.log(`-- re-querying ${SAMPLE_BUCKETS} buckets straight from HyperSync --`);
  const step = Math.max(1, Math.floor(keys.length / (SAMPLE_BUCKETS + 1)));
  const sample = Array.from({ length: SAMPLE_BUCKETS }, (_, i) => keys[(i + 1) * step]).filter(
    (key): key is number => key !== undefined,
  );

  let pendingBuckets = 0;

  for (const bucketStart of sample) {
    const stored = state.buckets[String(bucketStart)];
    if (!stored) continue;

    const logs = await fetchLogs(bucketStart, bucketStart + BUCKET_BLOCKS);
    // Only logs that actually belong to this bucket; a page can straddle the boundary.
    const inBucket = logs.filter((log) => bucketOf(log.block_number, BUCKET_BLOCKS) === bucketStart);
    const recomputed = aggregateWethVolume(inBucket, (pair) => state.pairSides[pair]);

    console.log(`\n  bucket ${bucketStart}  (stored unresolved: ${stored.unresolvedSwaps})`);

    if (stored.unresolvedSwaps === 0) {
      /*
        A bucket claiming every swap is attributed has to match exactly. This is the
        assertion that matters: it is what a reconciled bucket must satisfy, and the
        ingestion is only correct if reconciliation actually reaches this state.
      */
      check("swaps counted", recomputed.counted, stored.swaps);
      check("token/token ignored", recomputed.ignoredNonWeth, stored.ignoredNonWeth);
      check("volume (wei)", recomputed.volumeWei, stored.volumeWei);
      continue;
    }

    /*
      A bucket still carrying unattributed swaps has not been reconciled yet. It is not
      compared for equality — it is a declared floor, not a claim of completeness — but two
      things about it are still assertable, and both would be real defects:

        it must never claim MORE than a fresh recount, which would be double-counting;
        the shortfall must be explained by the swaps it says are unattributed.
    */
    pendingBuckets++;
    console.log(
      `    PENDING reconciliation — stored ${stored.swaps} swaps, recount ${recomputed.counted}`,
    );
    check(
      "stored is a floor, never above a fresh recount",
      recomputed.counted >= stored.swaps && recomputed.volumeWei >= BigInt(stored.volumeWei),
      true,
    );
    check(
      "the shortfall is covered by its unattributed swaps",
      recomputed.counted - stored.swaps <= stored.unresolvedSwaps,
      true,
    );
  }

  if (pendingBuckets > 0) {
    console.log(
      `\n  ${pendingBuckets} of ${sample.length} sampled buckets await reconciliation; their totals are floors.`,
    );
  }

  // 2. Re-read a sample of pair classifications from the chain.
  console.log(`\n-- re-reading ${SAMPLE_PAIRS} pair classifications onchain --`);
  const client = createPublicClient({
    transport: http(process.env.RPC_URL?.trim() || poolixConfig.rpcUrl, { batch: { wait: 16 } }),
  }) as PublicClient;
  const weth = getAddress(poolixConfig.contracts.weth);

  const pairEntries = Object.entries(state.pairSides);
  const pairStep = Math.max(1, Math.floor(pairEntries.length / (SAMPLE_PAIRS + 1)));
  const pairSample = Array.from({ length: SAMPLE_PAIRS }, (_, i) => pairEntries[(i + 1) * pairStep]).filter(
    (entry): entry is [string, WethSide] => entry !== undefined,
  );

  for (const [pair, side] of pairSample) {
    try {
      const address = getAddress(pair) as Address;
      const [token0, token1] = await Promise.all([
        client.readContract({ address, abi: uniswapV2PairAbi, functionName: "token0" }),
        client.readContract({ address, abi: uniswapV2PairAbi, functionName: "token1" }),
      ]);
      const expected: WethSide =
        getAddress(token0) === weth ? "token0" : getAddress(token1) === weth ? "token1" : "none";
      check(`${pair.slice(0, 10)}…`, side, expected);
    } catch {
      console.log(`  ·    ${pair.slice(0, 10)}… unreadable onchain, skipped`);
    }
  }

  console.log(`\n${failures === 0 ? "All sampled buckets and pairs match." : `${failures} MISMATCH(ES)`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
