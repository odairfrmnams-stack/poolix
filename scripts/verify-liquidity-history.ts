/*
  Independent check of the historical liquidity series.

    npm run verify:liquidity-history

  Re-queries pair events straight from HyperSync with its own inline decoding, replays
  them in its own ordering, and rebuilds the snapshot at six sampled boundaries — the
  beginning, middle and end of both the 7D and 30D windows. It imports neither
  liquidity-history.ts nor liquidity-math.ts, so neither can validate itself.

  It also audits the whole stored series for the faults a matching total would hide:
  duplicate event keys, mis-ordered events, boundary drift against the volume grid, and
  reserves outside what a uint112 pair can hold.

  The API token is read from the environment and never printed.
*/

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { createPublicClient, getAddress, http, parseAbi } from "viem";

import { poolixConfig } from "@/config/poolix";

const HYPERSYNC_URL = "https://4663.hypersync.xyz/query";
const SYNC = "0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1";
const MAX_UINT112 = 2n ** 112n - 1n;

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
  console.log(`  ${ok ? "PASS" : "FAIL"} ${label.padEnd(44)} ${String(actual)}${ok ? "" : `  != ${String(expected)}`}`);
}

interface StoredPoint {
  startTimestamp: number;
  wethReserveWei: string;
  liquidityWei: string;
  pairsCounted: number;
  complete: boolean;
}

interface LiquidityState {
  points: Record<string, StoredPoint>;
  pairs: string[];
  pairSides: Record<string, "token0" | "token1" | "none">;
  syncsProcessed: number;
  mintsSeen: number;
  burnsSeen: number;
  duplicates: number;
}

interface VolumeState {
  buckets: Record<string, { startTimestamp: number; fromBlock: number; toBlock: number }>;
}

interface RawLog {
  address: string;
  block_number: number;
  log_index: number;
  data: string;
}

/** Every Sync for the given pairs up to `toBlock`, from genesis. */
async function fetchSyncs(pairs: string[], toBlock: number): Promise<RawLog[] | null> {
  const logs: RawLog[] = [];
  let cursor = 0;

  while (cursor < toBlock) {
    const res = await fetch(HYPERSYNC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiToken()}` },
      body: JSON.stringify({
        from_block: cursor,
        to_block: toBlock,
        logs: [{ address: pairs, topics: [[SYNC]] }],
        field_selection: { log: ["block_number", "log_index", "address", "data"] },
      }),
    });
    if (res.status === 429) { await new Promise((r) => setTimeout(r, 3_000)); continue; }
    if (!res.ok) return null;

    const json = (await res.json()) as { data?: { logs?: RawLog[] }[]; next_block?: number };
    for (const batch of json.data ?? []) logs.push(...(batch.logs ?? []));

    const next = json.next_block ?? toBlock;
    if (next <= cursor) break;
    cursor = Math.min(next, toBlock);
  }
  return logs;
}

const sideCache = new Map<string, "token0" | "token1" | "none">();

/** WETH side, resolved independently of the service's own cache. */
async function wethSide(pair: string): Promise<"token0" | "token1" | "none"> {
  const key = pair.toLowerCase();
  const cached = sideCache.get(key);
  if (cached !== undefined) return cached;
  const weth = getAddress(poolixConfig.contracts.weth);
  try {
    const [t0, t1] = await Promise.all([
      client.readContract({ address: getAddress(pair), abi: pairAbi, functionName: "token0" }),
      client.readContract({ address: getAddress(pair), abi: pairAbi, functionName: "token1" }),
    ]);
    const side = getAddress(t0) === weth ? "token0" : getAddress(t1) === weth ? "token1" : "none";
    sideCache.set(key, side);
    return side;
  } catch {
    sideCache.set(key, "none");
    return "none";
  }
}

async function main(): Promise<void> {
  if (apiToken() === "") throw new Error("ENVIO_API_TOKEN is not set.");

  const dir = join(process.cwd(), ".poolix-cache");
  let liquidity: LiquidityState;
  let volume: VolumeState;
  try {
    liquidity = JSON.parse(await readFile(join(dir, `liquidity-history-${poolixConfig.chain.id}.json`), "utf8")) as LiquidityState;
    volume = JSON.parse(await readFile(join(dir, `history-${poolixConfig.chain.id}.json`), "utf8")) as VolumeState;
  } catch {
    throw new Error("No historical state yet — build it first, then re-run.");
  }

  const points = Object.values(liquidity.points).sort((a, b) => a.startTimestamp - b.startTimestamp);
  const pairs = liquidity.pairs;

  console.log("Poolix historical liquidity verification");
  console.log(`network          : ${poolixConfig.chain.name} (${poolixConfig.chain.id})`);
  console.log(`pairs in scope   : ${pairs.length}`);
  console.log(`points stored    : ${points.length} hourly`);
  console.log(`Sync processed   : ${liquidity.syncsProcessed.toLocaleString("en-US")}`);
  console.log(`Mint / Burn seen : ${liquidity.mintsSeen} / ${liquidity.burnsSeen}`);
  if (points.length === 0) throw new Error("No liquidity points stored.");

  const first = points[0]!;
  const last = points[points.length - 1]!;
  console.log(
    `timestamp span   : ${new Date(first.startTimestamp * 1000).toISOString()} -> ` +
      `${new Date(last.startTimestamp * 1000).toISOString()}`,
  );

  // --- structure: the whole series, not a sample ---
  console.log("\n-- structure --");
  let gaps = 0;
  for (let i = 1; i < points.length; i++) {
    if (points[i]!.startTimestamp - points[i - 1]!.startTimestamp !== 3600) gaps++;
  }
  check("hourly points contiguous (no gaps)", gaps, 0);
  check("no duplicate point keys", new Set(points.map((p) => p.startTimestamp)).size, points.length);
  check("every point complete", points.filter((p) => !p.complete).length, 0);
  check("reserves within uint112", points.filter((p) => BigInt(p.wethReserveWei) > MAX_UINT112).length, 0);
  check(
    "liquidity is exactly twice the WETH side",
    points.filter((p) => BigInt(p.liquidityWei) !== BigInt(p.wethReserveWei) * 2n).length,
    0,
  );
  check("duplicate events detected during build", liquidity.duplicates, 0);

  // Boundaries must match the volume grid exactly, or a liquidity point and the volume
  // bar drawn beside it would describe different hours.
  const volumeStarts = new Set(Object.values(volume.buckets).map((b) => b.startTimestamp));
  const offGrid = points.filter((p) => !volumeStarts.has(p.startTimestamp)).length;
  check("points align with the volume bucket grid", offGrid, 0);

  // --- independent reconstruction at six sampled boundaries ---
  console.log("\n-- independent reconstruction --");
  const ranges = Object.values(volume.buckets).sort((a, b) => a.startTimestamp - b.startTimestamp);
  const byStart = new Map(ranges.map((r) => [r.startTimestamp, r]));

  const pick = (list: StoredPoint[], label: string) => {
    const out: { point: StoredPoint; label: string }[] = [];
    if (list.length === 0) return out;
    out.push({ point: list[0]!, label: `${label} start` });
    out.push({ point: list[Math.floor(list.length / 2)]!, label: `${label} middle` });
    out.push({ point: list[list.length - 1]!, label: `${label} end` });
    return out;
  };

  const week = points.slice(-168);
  const samples = [...pick(week, "7D"), ...pick(points, "30D")];

  // One genesis fetch to the highest sampled boundary covers every sample.
  const highest = Math.max(...samples.map((s) => byStart.get(s.point.startTimestamp)?.toBlock ?? 0));
  const logs = await fetchSyncs(pairs, highest);
  if (logs === null) throw new Error("Could not re-query Sync events.");
  console.log(`  re-queried ${logs.length.toLocaleString("en-US")} Sync events up to block ${highest.toLocaleString("en-US")}`);

  // Ordering and duplicate audit over the re-queried set.
  const keys = new Set<string>();
  let duplicateKeys = 0;
  for (const log of logs) {
    const key = `${log.address.toLowerCase()}:${log.block_number}:${log.log_index}`;
    if (keys.has(key)) duplicateKeys++;
    keys.add(key);
  }
  check("duplicate event keys in re-query", duplicateKeys, 0);

  const ordered = [...logs].sort((a, b) =>
    a.block_number !== b.block_number ? a.block_number - b.block_number : a.log_index - b.log_index,
  );
  let misordered = 0;
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1]!;
    const cur = ordered[i]!;
    if (cur.block_number < prev.block_number) misordered++;
    else if (cur.block_number === prev.block_number && cur.log_index < prev.log_index) misordered++;
  }
  check("event ordering is a total order", misordered, 0);

  const sides = new Map<string, "token0" | "token1" | "none">();
  for (const pair of pairs) sides.set(pair, await wethSide(pair));

  for (const sample of samples) {
    const range = byStart.get(sample.point.startTimestamp);
    if (range === undefined) {
      console.log(`  ${sample.label}: no matching volume range`);
      failures++;
      continue;
    }

    // Replay every Sync strictly before the bucket's exclusive upper block.
    const state = new Map<string, { r0: bigint; r1: bigint }>();
    let invalid = 0;
    for (const log of ordered) {
      if (log.block_number >= range.toBlock) break;
      const body = log.data.slice(2);
      if (log.data.length !== 130 || !/^[0-9a-fA-F]+$/.test(body)) { invalid++; continue; }
      const r0 = BigInt(`0x${body.slice(0, 64)}`);
      const r1 = BigInt(`0x${body.slice(64, 128)}`);
      if (r0 > MAX_UINT112 || r1 > MAX_UINT112) { invalid++; continue; }
      state.set(log.address.toLowerCase(), { r0, r1 });
    }

    let weth = 0n;
    for (const pair of pairs) {
      const side = sides.get(pair);
      if (side === undefined || side === "none") continue;
      const reserves = state.get(pair);
      // Genesis scan: a pair with no Sync yet provably held nothing.
      if (reserves === undefined) continue;
      weth += side === "token0" ? reserves.r0 : reserves.r1;
    }

    const storedWeth = BigInt(sample.point.wethReserveWei);
    const match = weth === storedWeth;
    if (!match) failures++;
    const when = new Date(sample.point.startTimestamp * 1000).toISOString().slice(0, 16).replace("T", " ");
    console.log(
      `  ${match ? "PASS" : "FAIL"} ${sample.label.padEnd(12)} ${when}  block <${range.toBlock.toLocaleString("en-US")}`,
    );
    console.log(
      `       stored ${storedWeth} wei   recount ${weth} wei` +
        `${invalid > 0 ? `   (${invalid} undecodable skipped)` : ""}`,
    );
  }

  // --- windows ---
  console.log("\n-- windows --");
  const nowTs = Math.floor(Date.now() / 1000);
  const hour = Math.floor(nowTs / 3600) * 3600;
  for (const [label, days] of [["7D", 7], ["30D", 30]] as const) {
    const wanted: number[] = [];
    for (let i = days * 24; i >= 1; i--) wanted.push(hour - i * 3600);
    const present = wanted.filter((s) => liquidity.points[String(s)] !== undefined);
    const values = present.map((s) => BigInt(liquidity.points[String(s)]!.liquidityWei));
    const min = values.length > 0 ? values.reduce((a, b) => (b < a ? b : a)) : 0n;
    const max = values.length > 0 ? values.reduce((a, b) => (b > a ? b : a)) : 0n;
    const latest = values.length > 0 ? values[values.length - 1]! : 0n;
    const complete = present.length === wanted.length;
    console.log(
      `  ${label.padEnd(4)} ${String(present.length).padStart(3)}/${wanted.length} points  ` +
        `latest ${(Number(latest) / 1e18).toFixed(4)} ETH  range ${(Number(min) / 1e18).toFixed(4)} - ` +
        `${(Number(max) / 1e18).toFixed(4)} ETH  ${complete ? "COMPLETE" : "partial"}`,
    );
    if (!complete) failures++;
  }

  console.log(`\n${failures === 0 ? "All checks passed." : `${failures} CHECK(S) FAILED`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
