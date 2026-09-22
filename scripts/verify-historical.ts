/*
  Independent check of the historical volume buckets.

    npm run verify:historical

  Re-queries a sample of persisted buckets straight from HyperSync with its own inline
  decoding and its own pair classification, then compares against what was stored. It
  imports neither history-window.ts nor history-math.ts nor swap-math.ts, so none of them
  can validate itself.

  It also audits the stored block ranges for the two faults that totals alone cannot
  reveal: overlapping ranges, which double-count swaps, and gaps, which drop them.

  The API token is read from the environment and never printed.
*/

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { createPublicClient, getAddress, http, parseAbi } from "viem";

import { poolixConfig } from "@/config/poolix";

const HYPERSYNC_URL = "https://4663.hypersync.xyz/query";
const HEIGHT_URL = "https://4663.hypersync.xyz/height";
const SWAP_TOPIC0 = "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822";
/** Buckets re-queried per timeframe. Each is a full hour, so this is not free. */
const SAMPLE_SIZE = 3;

const pairAbi = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
]);

const client = createPublicClient({ transport: http(poolixConfig.rpcUrl, { batch: { wait: 16 } }) });
const apiToken = () => process.env.ENVIO_API_TOKEN?.trim() ?? "";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = String(actual) === String(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"} ${label.padEnd(42)} ${String(actual)}${ok ? "" : `  != ${String(expected)}`}`);
}

interface StoredBucket {
  startTimestamp: number;
  endTimestamp: number;
  fromBlock: number;
  toBlock: number;
  volumeWei: string;
  swaps: number;
  ignoredNonWeth: number;
  unresolvedSwaps: number;
}

interface State {
  buckets: Record<string, StoredBucket>;
  boundaries: Record<string, number>;
  swapsProcessed: number;
  updatedAt: number;
}

/** Inline decode of a Swap event's four uint256 words. */
function decode(data: string): { a0In: bigint; a1In: bigint; a0Out: bigint; a1Out: bigint } | null {
  if (typeof data !== "string" || !data.startsWith("0x") || data.length !== 2 + 4 * 64) return null;
  const body = data.slice(2);
  if (!/^[0-9a-fA-F]+$/.test(body)) return null;
  return {
    a0In: BigInt(`0x${body.slice(0, 64)}`),
    a1In: BigInt(`0x${body.slice(64, 128)}`),
    a0Out: BigInt(`0x${body.slice(128, 192)}`),
    a1Out: BigInt(`0x${body.slice(192, 256)}`),
  };
}

const sideCache = new Map<string, "token0" | "token1" | "none">();

/** Which side of a pair holds WETH, resolved independently of the service's cache. */
async function wethSide(pair: string): Promise<"token0" | "token1" | "none"> {
  const key = pair.toLowerCase();
  const cached = sideCache.get(key);
  if (cached !== undefined) return cached;

  const weth = getAddress(poolixConfig.contracts.weth);
  try {
    const [token0, token1] = await Promise.all([
      client.readContract({ address: getAddress(pair), abi: pairAbi, functionName: "token0" }),
      client.readContract({ address: getAddress(pair), abi: pairAbi, functionName: "token1" }),
    ]);
    const side = getAddress(token0) === weth ? "token0" : getAddress(token1) === weth ? "token1" : "none";
    sideCache.set(key, side);
    return side;
  } catch {
    sideCache.set(key, "none");
    return "none";
  }
}

interface Recount {
  volumeWei: bigint;
  swaps: number;
  ignored: number;
  logs: number;
  duplicateKeys: number;
}

/**
 * Re-reads one block range and recomputes its volume.
 *
 * Every log is keyed by block number plus its position, so a duplicate delivered across
 * page boundaries would be counted here and reported — the one fault a matching total
 * could still be hiding.
 */
async function recount(fromBlock: number, toBlock: number): Promise<Recount | null> {
  let cursor = fromBlock;
  let volumeWei = 0n;
  let swaps = 0;
  let ignored = 0;
  let logs = 0;
  const seen = new Set<string>();
  let duplicateKeys = 0;

  while (cursor < toBlock) {
    const res = await fetch(HYPERSYNC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiToken()}` },
      body: JSON.stringify({
        from_block: cursor,
        to_block: toBlock,
        logs: [{ topics: [[SWAP_TOPIC0]] }],
        field_selection: { log: ["block_number", "log_index", "address", "data"] },
      }),
    });
    if (!res.ok) return null;

    const json = (await res.json()) as {
      data?: { logs?: { block_number: number; log_index: number; address: string; data: string }[] }[];
      next_block?: number;
    };
    const page = (json.data ?? []).flatMap((batch) => batch.logs ?? []);

    for (const log of page) {
      const key = `${log.block_number}:${log.log_index}`;
      if (seen.has(key)) { duplicateKeys++; continue; }
      seen.add(key);
      logs++;

      const side = await wethSide(log.address);
      if (side === "none") { ignored++; continue; }
      const parsed = decode(log.data);
      if (parsed === null) continue;
      volumeWei += side === "token0" ? parsed.a0In + parsed.a0Out : parsed.a1In + parsed.a1Out;
      swaps++;
    }

    const next = json.next_block ?? toBlock;
    if (next <= cursor) break;
    cursor = Math.min(next, toBlock);
  }

  return { volumeWei, swaps, ignored, logs, duplicateKeys };
}

/** Evenly spaced sample across a list, so the check is not all from one end. */
function sample<T>(items: readonly T[], count: number): T[] {
  if (items.length <= count) return [...items];
  const step = (items.length - 1) / (count - 1);
  return Array.from({ length: count }, (_, i) => items[Math.round(i * step)]!);
}

async function main(): Promise<void> {
  if (apiToken() === "") throw new Error("ENVIO_API_TOKEN is not set.");

  const path = join(process.cwd(), ".poolix-cache", `history-${poolixConfig.chain.id}.json`);
  let state: State;
  try {
    state = JSON.parse(await readFile(path, "utf8")) as State;
  } catch {
    throw new Error("No historical state yet — open /analytics (or run the bootstrap) first.");
  }

  const height = ((await (await fetch(HEIGHT_URL)).json()) as { height: number }).height;
  const stored = Object.values(state.buckets).sort((a, b) => a.startTimestamp - b.startTimestamp);

  console.log("Poolix historical volume verification");
  console.log(`network        : ${poolixConfig.chain.name} (${poolixConfig.chain.id})`);
  console.log(`chain height   : ${height.toLocaleString("en-US")}`);
  console.log(`buckets stored : ${stored.length}  (hourly)`);
  console.log(`swaps ingested : ${state.swapsProcessed.toLocaleString("en-US")}`);

  if (stored.length === 0) throw new Error("No buckets stored yet.");

  const first = stored[0]!;
  const last = stored[stored.length - 1]!;
  const spanHours = (last.endTimestamp - first.startTimestamp) / 3600;
  console.log(
    `timestamp span : ${new Date(first.startTimestamp * 1000).toISOString()} -> ` +
      `${new Date(last.endTimestamp * 1000).toISOString()}  (${spanHours.toFixed(1)}h)`,
  );
  console.log(
    `block coverage : ${first.fromBlock.toLocaleString("en-US")} -> ${last.toBlock.toLocaleString("en-US")}  ` +
      `(${(last.toBlock - first.fromBlock).toLocaleString("en-US")} blocks)`,
  );

  // --- structural audit: every stored bucket, not a sample ---
  console.log("\n-- structure --");
  let overlaps = 0;
  let gaps = 0;
  let misaligned = 0;
  for (let index = 1; index < stored.length; index++) {
    const previous = stored[index - 1]!;
    const current = stored[index]!;
    // Only adjacent hours can be compared for block contiguity.
    if (current.startTimestamp !== previous.endTimestamp) continue;
    if (current.fromBlock < previous.toBlock) overlaps++;
    else if (current.fromBlock > previous.toBlock) gaps++;
  }
  for (const bucket of stored) {
    if (bucket.endTimestamp - bucket.startTimestamp !== 3600) misaligned++;
    if (bucket.startTimestamp % 3600 !== 0) misaligned++;
    if (bucket.toBlock <= bucket.fromBlock) misaligned++;
  }
  check("block ranges overlap (double-count)", overlaps, 0);
  check("block ranges gap (dropped swaps)", gaps, 0);
  check("buckets are aligned whole hours", misaligned, 0);
  check("no duplicate bucket keys", new Set(stored.map((b) => b.startTimestamp)).size, stored.length);

  const contiguous = stored.filter((b, i) => i === 0 || b.startTimestamp === stored[i - 1]!.endTimestamp);
  console.log(`  ·    contiguous run from oldest stored      ${contiguous.length} of ${stored.length} buckets`);

  // --- independent recount of sampled buckets ---
  console.log("\n-- independent recount of sampled buckets --");
  const picks = sample(stored, SAMPLE_SIZE);
  let recounted = 0;

  for (const bucket of picks) {
    const result = await recount(bucket.fromBlock, bucket.toBlock);
    const when = new Date(bucket.startTimestamp * 1000).toISOString().slice(0, 16).replace("T", " ");
    if (result === null) {
      console.log(`  ${when}  recount failed (indexer refused)`);
      failures++;
      continue;
    }
    recounted++;

    const storedVolume = BigInt(bucket.volumeWei);
    const volumeMatch = result.volumeWei === storedVolume;
    const swapsMatch = result.swaps === bucket.swaps;
    if (!volumeMatch || !swapsMatch) failures++;

    console.log(
      `  ${when}  blocks ${bucket.fromBlock.toLocaleString("en-US")}-${bucket.toBlock.toLocaleString("en-US")}`,
    );
    console.log(
      `      ${volumeMatch ? "PASS" : "FAIL"} volume wei   stored ${storedVolume}  recount ${result.volumeWei}`,
    );
    console.log(
      `      ${swapsMatch ? "PASS" : "FAIL"} swaps        stored ${bucket.swaps}  recount ${result.swaps}`,
    );
    console.log(
      `      ·    logs ${result.logs}, token/token ignored ${result.ignored}, duplicate log keys ${result.duplicateKeys}`,
    );
    if (result.duplicateKeys > 0) failures++;
  }

  // --- totals as the page would compute them ---
  console.log("\n-- windows --");
  const nowTs = Math.floor(Date.now() / 1000);
  const hour = Math.floor(nowTs / 3600) * 3600;
  for (const [label, days] of [["7D", 7], ["30D", 30]] as const) {
    const wanted: number[] = [];
    for (let i = days * 24; i >= 1; i--) wanted.push(hour - i * 3600);
    const present = wanted.filter((start) => state.buckets[String(start)] !== undefined);
    let volume = 0n;
    let swaps = 0;
    for (const start of present) {
      const bucket = state.buckets[String(start)]!;
      volume += BigInt(bucket.volumeWei);
      swaps += bucket.swaps;
    }
    const pct = ((present.length / wanted.length) * 100).toFixed(1);
    console.log(
      `  ${label.padEnd(4)} ${String(present.length).padStart(3)}/${wanted.length} buckets (${pct}%)  ` +
        `volume ${(Number(volume) / 1e18).toFixed(4)} ETH  fees ${(Number((volume * 3n) / 1000n) / 1e18).toFixed(4)} ETH  ` +
        `swaps ${swaps.toLocaleString("en-US")}  ${present.length === wanted.length ? "COMPLETE" : "partial"}`,
    );
  }

  console.log(`\n  buckets recounted: ${recounted} of ${picks.length}`);
  console.log(`${failures === 0 ? "\nAll checks passed." : `\n${failures} CHECK(S) FAILED`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
