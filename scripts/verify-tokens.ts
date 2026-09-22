/*
  Independent check of the tracked token universe.

    npm run verify:tokens

  Walks the pair space itself, with its own inline decoding and its own qualification
  rules, and compares the result against what the page published. It imports neither
  services/tokens/universe.ts nor universe-math.ts, so neither can validate itself.

  The scan here is allowed to be slow — it is a diagnostic, not a page render — so it
  covers the same range the service has covered and reports the full funnel.

  No API token is read or printed by this script.
*/

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { createPublicClient, encodeFunctionData, getAddress, http, parseAbi } from "viem";

import { poolixConfig } from "@/config/poolix";
import { isUniswapV2Available } from "@/config/resolve";

const MIN_WETH_RESERVE = 10n ** 14n;
const TRACK_LIMIT = 10;
const BATCH = 500;
const PAUSE_MS = 150;

const factoryAbi = parseAbi([
  "function allPairsLength() view returns (uint256)",
  "function allPairs(uint256) view returns (address)",
]);
const pairAbi = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112,uint112,uint32)",
]);
const erc20 = parseAbi([
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function balanceOf(address) view returns (uint256)",
]);

const client = createPublicClient({ transport: http(poolixConfig.rpcUrl) });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = String(actual) === String(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"} ${label.padEnd(38)} ${String(actual)}${ok ? "" : `  != ${String(expected)}`}`);
}

interface Call {
  to: string;
  data: string;
}

let throttles = 0;

/** One raw JSON-RPC batch, retried on throttling. */
async function batch(calls: readonly Call[]): Promise<readonly (string | null)[]> {
  if (calls.length === 0) return [];
  const payload = calls.map((c, id) => ({
    jsonrpc: "2.0",
    id,
    method: "eth_call",
    params: [{ to: c.to, data: c.data }, "latest"],
  }));

  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(poolixConfig.rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res.status === 429) {
        throttles++;
        await sleep(1_000 * (attempt + 1));
        continue;
      }
      if (!res.ok) return calls.map(() => null);
      const json: unknown = await res.json();
      if (!Array.isArray(json)) return calls.map(() => null);
      const byId = new Map<number, string | null>();
      for (const entry of json) {
        if (typeof entry === "object" && entry !== null && "id" in entry) {
          const record = entry as { id: number; result?: string };
          byId.set(record.id, record.result ?? null);
        }
      }
      return calls.map((_, id) => byId.get(id) ?? null);
    } catch {
      await sleep(800 * (attempt + 1));
    }
  }
  return calls.map(() => null);
}

async function paced(calls: readonly Call[]): Promise<readonly (string | null)[]> {
  const out: (string | null)[] = [];
  for (let i = 0; i < calls.length; i += BATCH) {
    if (i > 0) await sleep(PAUSE_MS);
    out.push(...(await batch(calls.slice(i, i + BATCH))));
  }
  return out;
}

const toAddress = (v: string | null): string | null => {
  if (v === null || v.length !== 66) return null;
  const a = `0x${v.slice(26)}`.toLowerCase();
  return a === "0x0000000000000000000000000000000000000000" ? null : a;
};

interface Published {
  tokens: string[];
  discovered: number;
  selected: number;
  verified: number;
  pairsExamined: number;
  totalPairs: number;
  at: number;
}

async function loadState(): Promise<{ scannedFrom: number; scannedTo: number; published: Published | null } | null> {
  try {
    const path = join(process.cwd(), ".poolix-cache", `tokens-${poolixConfig.chain.id}.json`);
    return JSON.parse(await readFile(path, "utf8")) as {
      scannedFrom: number;
      scannedTo: number;
      published: Published | null;
    };
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  if (!isUniswapV2Available(poolixConfig)) throw new Error("Uniswap v2 is not configured for this network.");
  const { uniswapV2, weth } = poolixConfig.contracts;
  if (uniswapV2.factory.status !== "configured") throw new Error("Factory is not configured.");

  const factory = uniswapV2.factory.address;
  const wethAddress = getAddress(weth).toLowerCase();

  console.log("Poolix token universe verification");
  console.log(`network      : ${poolixConfig.chain.name} (${poolixConfig.chain.id})`);
  console.log(`factory      : ${factory}`);
  console.log(`WETH         : ${wethAddress}  (never tracked: it is the quote asset)`);
  console.log(`track limit  : ${TRACK_LIMIT}  (a ceiling, not a target)\n`);

  const totalPairs = Number(await client.readContract({ address: factory, abi: factoryAbi, functionName: "allPairsLength" }));
  const state = await loadState();

  // Cover exactly the range the service has covered, so the two are comparable.
  const from = state === null ? Math.max(0, totalPairs - 400) : state.scannedFrom;
  const to = state === null ? totalPairs : Math.min(state.scannedTo, totalPairs);
  const span = Math.max(0, to - from);

  console.log(`pairs in factory              : ${totalPairs.toLocaleString("en-US")}`);
  console.log(`range the service has covered : [${from.toLocaleString("en-US")}, ${to.toLocaleString("en-US")})  = ${span.toLocaleString("en-US")} pairs`);
  if (span === 0) throw new Error("Nothing scanned yet — open /analytics, then re-run.");

  const started = Date.now();
  const addressResults = await paced(
    Array.from({ length: span }, (_, o) => ({
      to: factory,
      data: encodeFunctionData({ abi: factoryAbi, functionName: "allPairs", args: [BigInt(from + o)] }),
    })),
  );

  const pairs: string[] = [];
  let listFailed = 0;
  for (const v of addressResults) {
    const a = toAddress(v);
    if (a === null) listFailed++;
    else pairs.push(a);
  }

  const reservesData = encodeFunctionData({ abi: pairAbi, functionName: "getReserves" });
  const reserveResults = await paced(pairs.map((p) => ({ to: p, data: reservesData })));

  let decoded = 0;
  let emptyPairs = 0;
  let belowMin = 0;
  const survivors: { pair: string; r0: bigint; r1: bigint }[] = [];
  for (const [i, pair] of pairs.entries()) {
    const rv = reserveResults[i] ?? null;
    if (rv === null || rv.length < 194) continue;
    decoded++;
    const r0 = BigInt(`0x${rv.slice(2, 66)}`);
    const r1 = BigInt(`0x${rv.slice(66, 130)}`);
    if (r0 <= 0n || r1 <= 0n) { emptyPairs++; continue; }
    if (r0 < MIN_WETH_RESERVE && r1 < MIN_WETH_RESERVE) { belowMin++; continue; }
    survivors.push({ pair, r0, r1 });
  }

  const t0 = encodeFunctionData({ abi: pairAbi, functionName: "token0" });
  const t1 = encodeFunctionData({ abi: pairAbi, functionName: "token1" });
  const tokenResults = await paced(survivors.flatMap((s) => [{ to: s.pair, data: t0 }, { to: s.pair, data: t1 }]));

  let noWethSide = 0;
  let wethBelowMin = 0;
  let tokenReadFailed = 0;
  const best = new Map<string, { pair: string; wethReserve: bigint }>();

  for (const [i, s] of survivors.entries()) {
    const a = toAddress(tokenResults[i * 2] ?? null);
    const b = toAddress(tokenResults[i * 2 + 1] ?? null);
    if (a === null || b === null) { tokenReadFailed++; continue; }

    const wethIs0 = a === wethAddress;
    if (!wethIs0 && b !== wethAddress) { noWethSide++; continue; }
    const wethReserve = wethIs0 ? s.r0 : s.r1;
    if (wethReserve < MIN_WETH_RESERVE) { wethBelowMin++; continue; }

    const other = wethIs0 ? b : a;
    if (other === wethAddress) continue;

    const existing = best.get(other);
    if (existing === undefined || wethReserve > existing.wethReserve) {
      best.set(other, { pair: s.pair, wethReserve });
    }
  }

  // Same deterministic ordering the service uses: reserve desc, then address asc.
  const ordered = [...best.entries()].sort((x, y) => {
    if (x[1].wethReserve !== y[1].wethReserve) return y[1].wethReserve > x[1].wethReserve ? 1 : -1;
    return x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0;
  });
  const selected = ordered.slice(0, TRACK_LIMIT);

  // Verification: decimals() and balanceOf() must both answer.
  const verifyCalls: Call[] = selected.flatMap(([token, entry]) => [
    { to: token, data: encodeFunctionData({ abi: erc20, functionName: "decimals" }) },
    { to: token, data: encodeFunctionData({ abi: erc20, functionName: "balanceOf", args: [entry.pair as `0x${string}`] }) },
  ]);
  const verifyResults = await paced(verifyCalls);

  const verified: string[] = [];
  const rejected: { token: string; why: string }[] = [];
  for (const [i, [token]] of selected.entries()) {
    const dv = verifyResults[i * 2] ?? null;
    const bv = verifyResults[i * 2 + 1] ?? null;
    const decimals = dv !== null && dv.length >= 66 ? Number(BigInt(dv)) : null;
    const okDecimals = decimals !== null && Number.isInteger(decimals) && decimals >= 0 && decimals <= 255;
    const okBalance = bv !== null && bv.length === 66;
    if (okDecimals && okBalance) verified.push(token);
    else rejected.push({ token, why: !okDecimals ? "decimals() unreadable" : "balanceOf() unreadable" });
  }

  const secs = ((Date.now() - started) / 1000).toFixed(1);

  console.log("\n-- funnel --");
  console.log(`  pairs scanned                    : ${span.toLocaleString("en-US")}`);
  console.log(`  pairs successfully decoded       : ${decoded.toLocaleString("en-US")}${listFailed > 0 ? `  (${listFailed} addresses unreadable)` : ""}`);
  console.log(`  rejected, both reserves empty    : ${emptyPairs.toLocaleString("en-US")}`);
  console.log(`  rejected, below minimum reserve  : ${(belowMin + wethBelowMin).toLocaleString("en-US")}`);
  console.log(`  rejected, no WETH side           : ${noWethSide.toLocaleString("en-US")}`);
  console.log(`  rejected, token read failed      : ${tokenReadFailed.toLocaleString("en-US")}`);
  console.log(`  unique non-WETH tokens discovered: ${best.size.toLocaleString("en-US")}`);
  console.log(`  tokens selected (cap ${TRACK_LIMIT})         : ${selected.length}`);
  console.log(`  tokens successfully verified     : ${verified.length}`);
  for (const entry of rejected) console.log(`      rejected: ${entry.token}  ${entry.why}`);
  console.log(`  FINAL TOKENS TRACKED             : ${verified.length}`);
  console.log(`  (scan took ${secs}s, ${throttles} throttled requests)`);

  console.log("\n-- selected token universe --");
  for (const [index, token] of verified.entries()) {
    const entry = best.get(token);
    const symbol = await client
      .readContract({ address: token as `0x${string}`, abi: erc20, functionName: "symbol" })
      .catch(() => "?");
    console.log(`  ${String(index + 1).padStart(2)}. ${token}  ${String(symbol).slice(0, 12).padEnd(12)} pair ${entry?.pair}`);
  }

  console.log("\n-- page vs verifier --");
  if (state?.published == null) {
    console.log("  ·    nothing published yet — open /analytics, then re-run.");
  } else {
    const published = state.published;
    console.log(`  ·    page discovered / selected / verified  ${published.discovered} / ${published.selected} / ${published.verified}`);
    console.log(`  ·    page tokens                            ${published.tokens.length}`);
    console.log(`  ·    verifier tokens                        ${verified.length}`);

    check("Tokens Tracked never exceeds the cap", published.verified <= TRACK_LIMIT, true);
    check("Tokens Tracked equals the token list", published.verified, published.tokens.length);
    check("no duplicates in the tracked list", new Set(published.tokens).size, published.tokens.length);
    check("all normalised lower-case", published.tokens.every((t) => t === t.toLowerCase()), true);
    check("WETH is not tracked", published.tokens.includes(wethAddress), false);
    check("no zero address tracked", published.tokens.includes("0x0000000000000000000000000000000000000000"), false);

    const missing = verified.filter((t) => !published.tokens.includes(t));
    const extra = published.tokens.filter((t) => !verified.includes(t));
    console.log(`  ·    in verifier only / in page only        ${missing.length} / ${extra.length}`);
    for (const token of missing.slice(0, 5)) console.log(`         verifier only: ${token}`);
    for (const token of extra.slice(0, 5)) console.log(`         page only    : ${token}`);

    // Reserves move between the two scans, so the tail of the ranking can legitimately
    // differ. A wholesale divergence cannot be explained that way.
    const drift = missing.length + extra.length;
    const tolerance = Math.max(2, Math.ceil(verified.length * 0.3));
    const ok = drift <= tolerance;
    if (!ok) failures++;
    console.log(`  ${ok ? "PASS" : "FAIL"} token sets agree within tolerance     ${drift} <= ${tolerance}`);
  }

  console.log("\n-- holders uses the same universe --");
  try {
    const holdersPath = join(process.cwd(), ".poolix-cache", `holders-${poolixConfig.chain.id}.json`);
    const holders = JSON.parse(await readFile(holdersPath, "utf8")) as {
      published: { universe: string[]; tokenCount: number; holders: number } | null;
    };
    if (holders.published === null || state?.published == null) {
      console.log("  ·    nothing published yet — open /analytics, then re-run.");
    } else {
      const tracked = [...state.published.tokens].sort();
      const used = [...holders.published.universe].sort();
      check("holders universe == tracked tokens", JSON.stringify(used), JSON.stringify(tracked));
      check("holders tokenCount == Tokens Tracked", holders.published.tokenCount, state.published.verified);
      console.log(`  ·    holders counted over ${holders.published.tokenCount} tokens -> ${holders.published.holders} holders`);
    }
  } catch {
    console.log("  ·    no holders state yet — open /analytics, then re-run.");
  }

  console.log(`\n${failures === 0 ? "All checks passed." : `${failures} CHECK(S) FAILED`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
