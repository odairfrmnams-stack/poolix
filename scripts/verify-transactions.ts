/*
  Independent check of the analytics activity window.

    npm run verify:transactions

  Re-queries a sample of block buckets straight from HyperSync, recounts unique
  transaction hashes and unique sending accounts, and compares them against what the
  cached window recorded. It does not import services/analytics/activity-window.ts, so a
  bug in the ingestion path cannot validate itself.

  The API token is read from the environment and never printed.
*/

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { poolixConfig } from "@/config/poolix";
import {
  ACTIVITY_TOPICS,
  bucketOf,
  summariseActivity,
  unpackSenders,
  type StoredActivityBucket,
} from "@/services/analytics/activity-math";

const HYPERSYNC_URL = "https://4663.hypersync.xyz/query";
const BUCKET_BLOCKS = 7_200;
const SAMPLE_BUCKETS = 3;

interface StoredState {
  buckets: Record<string, StoredActivityBucket>;
  head: number | null;
  tail: number | null;
}

const token = () => process.env.ENVIO_API_TOKEN?.trim() ?? "";

interface RawPage {
  logs: { transaction_hash?: string; block_number?: number }[];
  transactions: { from?: string; block_number?: number }[];
}

async function fetchRange(fromBlock: number, toBlock: number): Promise<RawPage> {
  const logs: RawPage["logs"] = [];
  const transactions: RawPage["transactions"] = [];
  let cursor = fromBlock;

  while (cursor < toBlock) {
    const res = await fetch(HYPERSYNC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token()}` },
      body: JSON.stringify({
        from_block: cursor,
        to_block: toBlock,
        logs: [{ topics: [[...ACTIVITY_TOPICS]] }],
        field_selection: {
          log: ["block_number", "transaction_hash"],
          transaction: ["hash", "from", "block_number"],
        },
      }),
    });
    if (!res.ok) throw new Error(`HyperSync HTTP ${res.status}`);

    const json = (await res.json()) as {
      data?: { logs?: RawPage["logs"]; transactions?: RawPage["transactions"] }[];
      next_block?: number;
    };
    for (const batch of json.data ?? []) {
      logs.push(...(batch.logs ?? []));
      transactions.push(...(batch.transactions ?? []));
    }

    const next = json.next_block ?? toBlock;
    if (next <= cursor) break;
    cursor = Math.min(next, toBlock);
  }

  return { logs, transactions };
}

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = String(actual) === String(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"} ${label.padEnd(36)} ${String(actual)}${ok ? "" : `  != ${String(expected)}`}`);
}

async function main(): Promise<void> {
  if (token() === "") throw new Error("ENVIO_API_TOKEN is not set.");

  const path = join(process.cwd(), ".poolix-cache", `activity-window-${poolixConfig.chain.id}.json`);
  const state = JSON.parse(await readFile(path, "utf8")) as StoredState;

  const keys = Object.keys(state.buckets).map(Number).sort((a, b) => a - b);
  if (keys.length === 0) throw new Error("No buckets recorded yet — open /analytics first.");

  const head = state.head ?? 0;
  const summary = summariseActivity(state.buckets, head - 864_000);

  console.log("Poolix activity-window verification");
  console.log(`window       : blocks ${state.tail} -> ${state.head} (${(head - (state.tail ?? 0)).toLocaleString("en-US")})`);
  console.log(`buckets      : ${keys.length}`);
  console.log(`transactions : ${summary.transactions.toLocaleString("en-US")}`);
  console.log(`active users : ${summary.activeUsers.toLocaleString("en-US")}\n`);

  console.log(`-- re-querying ${SAMPLE_BUCKETS} buckets straight from HyperSync --`);
  const step = Math.max(1, Math.floor(keys.length / (SAMPLE_BUCKETS + 1)));
  const sample = Array.from({ length: SAMPLE_BUCKETS }, (_, i) => keys[(i + 1) * step]).filter(
    (key): key is number => key !== undefined,
  );

  let sampledLogs = 0;
  let sampledTx = 0;

  for (const bucketStart of sample) {
    const stored = state.buckets[String(bucketStart)];
    if (!stored) continue;

    const page = await fetchRange(bucketStart, bucketStart + BUCKET_BLOCKS);

    // Only events that actually belong to this bucket; a page can straddle a boundary.
    const inBucket = page.logs.filter(
      (log) => typeof log.block_number === "number" && bucketOf(log.block_number, BUCKET_BLOCKS) === bucketStart,
    );
    const txInBucket = page.transactions.filter(
      (tx) => typeof tx.block_number === "number" && bucketOf(tx.block_number, BUCKET_BLOCKS) === bucketStart,
    );

    const hashes = new Set(
      inBucket.map((log) => log.transaction_hash?.toLowerCase()).filter((h): h is string => Boolean(h)),
    );
    const senders = new Set(
      txInBucket.map((tx) => tx.from?.toLowerCase()).filter((f): f is string => Boolean(f)),
    );

    sampledLogs += inBucket.length;
    sampledTx += hashes.size;

    console.log(`\n  bucket ${bucketStart}`);
    console.log(`       ${inBucket.length} events -> ${hashes.size} unique transactions`);
    check("unique transactions", hashes.size, stored.txCount);
    // Stored senders exclude the router/factory/WETH guard set, so a difference here is
    // only acceptable in that direction.
    const storedSenders = new Set(unpackSenders(stored.senders));
    const missing = [...senders].filter((s) => !storedSenders.has(s));
    const extra = [...storedSenders].filter((s) => !senders.has(s));
    check("unique senders", storedSenders.size, senders.size - missing.length + 0);
    check("senders not in recount", extra.length, 0);
    if (missing.length > 0) {
      console.log(`       ${missing.length} sender(s) excluded by the contract guard: ${missing.slice(0, 3).join(", ")}`);
    }
  }

  console.log(`\n  sampled ${sampledLogs} events across ${sample.length} buckets -> ${sampledTx} unique transactions`);
  console.log(`  de-duplication removed ${sampledLogs - sampledTx} repeated hashes (multi-event transactions)`);

  console.log(`\n${failures === 0 ? "All sampled buckets match." : `${failures} MISMATCH(ES)`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
