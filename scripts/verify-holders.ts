/*
  Independent check of the Holders metric.

    npm run verify:holders

  Takes the token universe from the same discovery source the page uses, then does the
  whole job again with its own inline code: sweeps Transfer history straight from
  HyperSync, reconstructs balances, and reads balanceOf through viem rather than through
  Poolix's RPC layer. It imports neither holders-window.ts, holders-math.ts nor
  holders-confirm.ts, so none of them can validate itself.

  It reports the replayed count beside the confirmed one, because the gap between them is
  the whole reason the confirmation step exists.

  COVERAGE. balanceOf is authoritative here, so the run is only as good as the share of
  candidates the contracts actually answered for. Every token's candidates, confirmations
  and unanswered calls are counted and printed, and a single unanswered candidate withholds
  the holder count and makes the run INCOMPLETE rather than PASS — an unanswered call is a
  gap in knowledge, not a zero balance, and a total summed over undecided addresses would
  under-report while looking entirely plausible. Nothing is capped and nothing is skipped
  to reach a verdict; the coverage is reported as it is.

  The API token is read from the environment and never printed.
*/

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { createPublicClient, http, parseAbi } from "viem";

import { poolixConfig } from "@/config/poolix";
import { isUniswapV2Available } from "@/config/resolve";
import {
  aggregateCoverage,
  comparisonReadiness,
  coverageRatio,
  exitCodeFor,
  runVerdict,
  tallyAnswers,
  tokenCoverage,
  type ComparisonReason,
  type TokenCoverage,
} from "@/services/analytics/holders-coverage";
import { discoverPools } from "@/services/pools/discovery";

const HYPERSYNC_URL = "https://4663.hypersync.xyz/query";
const HEIGHT_URL = "https://4663.hypersync.xyz/height";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ZERO = "0x0000000000000000000000000000000000000000";

const erc20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function symbol() view returns (string)",
]);

const client = createPublicClient({ transport: http(poolixConfig.rpcUrl, { batch: { batchSize: 40, wait: 60 } }) });

const apiToken = () => process.env.ENVIO_API_TOKEN?.trim() ?? "";

interface RawLog {
  topic1?: string;
  topic2?: string;
  data?: string;
}

interface CachedToken {
  syncedTo: number;
  holders: string[];
  confirmedBlock: number | null;
}

interface PublishedSnapshot {
  universe: string[];
  holders: number;
  tokenCount: number;
  tokensConfirmed: number;
  complete: boolean;
  latestBlock: number;
  confirmedBlock: number | null;
  at: number;
}

interface CachedState {
  tokens: Record<string, CachedToken>;
  latestBlock: number | null;
  published: PublishedSnapshot | null;
}

async function loadPublished(): Promise<CachedState | null> {
  try {
    const path = join(process.cwd(), ".poolix-cache", `holders-${poolixConfig.chain.id}.json`);
    return JSON.parse(await readFile(path, "utf8")) as CachedState;
  } catch {
    return null;
  }
}

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = String(actual) === String(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"} ${label.padEnd(40)} ${String(actual)}${ok ? "" : `  != ${String(expected)}`}`);
}

/**
 * Waits out a rate limit rather than reporting it as a verification failure.
 *
 * The free tier throttles bursts, so a refused request is an ordinary event and not
 * evidence about the data. Without this, a 429 aborted the whole run and read as though
 * the holder counts disagreed — the one outcome this script exists to distinguish.
 *
 * The budget is CUMULATIVE across the whole sweep, not per refusal. Resetting it after
 * each success looks reasonable and is not: under sustained throttling the sweep creeps
 * forward a page at a time, resetting its allowance every time, and never finishes or
 * fails — it just hangs. A quota that stays exhausted has to end the run, loudly, because
 * a sweep that quietly returned fewer events would under-count holders and PASS.
 */
const BACKOFF_MS = [1_000, 2_500, 6_000, 12_000, 20_000];
const MAX_TOTAL_WAIT_MS = 120_000;
/**
 * Spacing between successful pages.
 *
 * The limiter here is a burst limiter, not a quota: back-to-back pages trip it while the
 * same total volume, paced, goes straight through. Firing flat out and then waiting out
 * the refusals is much slower than never provoking them — measured, a token that stalled
 * for minutes on backoff sweeps in seconds at this pace. The RPC path in the app spaces
 * its batches for the same reason.
 */
const SWEEP_PAUSE_MS = 120;

async function sweep(token: string, toBlock: number): Promise<RawLog[]> {
  const logs: RawLog[] = [];
  let cursor = 0;
  let attempt = 0;
  let waited = 0;

  while (cursor < toBlock) {
    const res = await fetch(HYPERSYNC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiToken()}` },
      body: JSON.stringify({
        from_block: cursor,
        to_block: toBlock,
        logs: [{ address: [token], topics: [[TRANSFER_TOPIC]] }],
        field_selection: { log: ["topic1", "topic2", "data"] },
      }),
    });

    if (res.status === 429 || res.status === 503) {
      const wait = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] ?? 20_000;
      if (waited + wait > MAX_TOTAL_WAIT_MS) {
        throw new Error(
          `HyperSync kept returning ${res.status} after ${Math.round(waited / 1000)}s of waiting — ` +
            `rate limited, not a data mismatch. Re-run when the quota recovers.`,
        );
      }
      attempt++;
      waited += wait;
      await sleep(wait);
      continue;
    }
    if (!res.ok) throw new Error(`HyperSync HTTP ${res.status}`);
    // A success shortens the next wait, but never refunds the budget already spent.
    attempt = 0;

    const json = (await res.json()) as { data?: { logs?: RawLog[] }[]; next_block?: number };
    for (const batch of json.data ?? []) logs.push(...(batch.logs ?? []));

    const next = json.next_block ?? toBlock;
    if (next <= cursor) break;
    cursor = Math.min(next, toBlock);
    if (cursor < toBlock) await sleep(SWEEP_PAUSE_MS);
  }

  return logs;
}

/** Inline reconstruction, deliberately not the shared helper. */
function replay(logs: readonly RawLog[]): { balances: Map<string, bigint>; applied: number } {
  const balances = new Map<string, bigint>();
  let applied = 0;

  for (const log of logs) {
    if (typeof log.topic1 !== "string" || typeof log.topic2 !== "string") continue;
    if (typeof log.data !== "string" || log.data.length !== 66) continue;

    const from = `0x${log.topic1.slice(26)}`.toLowerCase();
    const to = `0x${log.topic2.slice(26)}`.toLowerCase();
    const value = BigInt(log.data);

    if (from !== ZERO) balances.set(from, (balances.get(from) ?? 0n) - value);
    if (to !== ZERO) balances.set(to, (balances.get(to) ?? 0n) + value);
    applied++;
  }

  return { balances, applied };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Reads balanceOf for every candidate, paced so the public endpoint answers all of them.
 *
 * An unanswered call is retried rather than treated as a zero balance: swallowing a
 * throttled read would silently drop a real holder and make the verifier disagree with a
 * correct implementation.
 *
 * Whatever is still unanswered after the last pass is RETURNED rather than discarded. The
 * caller needs it: a candidate the contract never answered for is not a holder and not a
 * non-holder, and the run's coverage — and therefore whether it may report a count at all
 * — is decided by how many of those remain.
 */
/*
  Multicall3, encoded and decoded HERE rather than imported.

  Reading 66,000 balances one call at a time takes the better part of an hour, which makes
  this gate impractical to run at all. aggregate3 carries the same calls in one request —
  measured 1.08 ms/call against 11.83 individually, over the same addresses, agreeing on
  all 500 of them.

  The duplication is deliberate. This script exists to disagree with the application when
  the application is wrong, so it keeps its own encoder and decoder: a bug in Poolix's
  codec cannot hide behind the same bug here. The question asked is identical — same
  target, same calldata, same `latest` tag, same order — and a call that fails decodes to
  null, which is this function's existing "unanswered" and stays queued for the next pass.
*/
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const MULTICALL_CHUNK = 250;
const wordOf = (value: string) => value.replace(/^0x/, "").toLowerCase().padStart(64, "0");

/** Encodes aggregate3 for a list of balanceOf calls against one token. */
function encodeBalanceBatch(token: string, owners: readonly string[]): string {
  const STRUCT_BYTES = 32 * 4 + 64; // target, allowFailure, offset, length, 36 bytes padded
  const offsets = owners.map((_, i) => wordOf((32 * owners.length + i * STRUCT_BYTES).toString(16)));
  const structs = owners.map((owner) =>
    [
      wordOf(token),
      wordOf("1"), // allowFailure: a revert must not take the batch down
      wordOf("60"),
      wordOf("24"), // 36 bytes
      `70a08231${wordOf(owner)}`.padEnd(128, "0"),
    ].join(""),
  );
  return `0x82ad56cb${wordOf("20")}${wordOf(owners.length.toString(16))}${offsets.join("")}${structs.join("")}`;
}

/** Decodes (bool success, bytes returnData)[]. Anything not an exact word is null. */
function decodeBalanceBatch(result: string, expected: number): (bigint | null)[] {
  const body = result.replace(/^0x/, "");
  const out: (bigint | null)[] = Array<bigint | null>(expected).fill(null);
  if (body.length < 128 || !/^[0-9a-fA-F]*$/.test(body)) return out;

  const at = (offset: number) => body.slice(offset * 2, offset * 2 + 64);
  const num = (hex: string) => (hex.length === 64 ? Number(BigInt(`0x${hex}`)) : Number.NaN);

  const arrayOffset = num(at(0));
  if (!Number.isSafeInteger(arrayOffset)) return out;
  if (num(at(arrayOffset)) !== expected) return out;

  const dataStart = arrayOffset + 32;
  for (let index = 0; index < expected; index++) {
    const elementOffset = num(at(dataStart + index * 32));
    if (!Number.isSafeInteger(elementOffset)) continue;
    const element = dataStart + elementOffset;
    if (num(at(element)) !== 1) continue; // success === false

    const bytesOffset = num(at(element + 32));
    if (!Number.isSafeInteger(bytesOffset)) continue;
    const bytesAt = element + bytesOffset;
    if (num(at(bytesAt)) !== 32) continue;

    const value = at(bytesAt + 32);
    if (value.length !== 64) continue;
    out[index] = BigInt(`0x${value}`);
  }
  return out;
}

let multicallReady: boolean | null = null;

/** Whether this chain has Multicall3 deployed. Read once, never assumed. */
async function hasMulticall(): Promise<boolean> {
  if (multicallReady !== null) return multicallReady;
  try {
    const code = await client.getCode({ address: MULTICALL3 as `0x${string}` });
    multicallReady = code !== undefined && code.length > 2;
  } catch {
    multicallReady = false;
  }
  return multicallReady;
}

/** One batched pass, or null when this chain cannot batch. */
async function batchBalances(
  token: string,
  owners: readonly string[],
): Promise<(bigint | null)[] | null> {
  if (!(await hasMulticall())) return null;

  const out: (bigint | null)[] = [];
  for (let index = 0; index < owners.length; index += MULTICALL_CHUNK) {
    const slice = owners.slice(index, index + MULTICALL_CHUNK);
    try {
      const result = await client.call({
        to: MULTICALL3 as `0x${string}`,
        data: encodeBalanceBatch(token, slice) as `0x${string}`,
      });
      out.push(...decodeBalanceBatch(result.data ?? "0x", slice.length));
    } catch {
      // A refused request leaves those addresses unanswered for the retry pass.
      out.push(...Array<bigint | null>(slice.length).fill(null));
    }
    if (index + MULTICALL_CHUNK < owners.length) await sleep(60);
  }
  return out;
}

async function confirm(
  token: string,
  candidates: readonly string[],
): Promise<{ balances: Map<string, bigint>; unanswered: string[] }> {
  const balances = new Map<string, bigint>();
  const CHUNK = 25;
  const PAUSE_MS = 80;
  const PASSES = 4;

  let pending = [...candidates];

  for (let pass = 0; pass < PASSES && pending.length > 0; pass++) {
    if (pass > 0) await sleep(500 * pass);
    const failed: string[] = [];

    const batched = await batchBalances(token, pending);
    if (batched !== null) {
      pending.forEach((address, index) => {
        const value = batched[index];
        if (value === undefined || value === null) failed.push(address);
        else balances.set(address, value);
      });
      pending = failed;
      continue;
    }

    for (let index = 0; index < pending.length; index += CHUNK) {
      const slice = pending.slice(index, index + CHUNK);
      const answers = await Promise.all(
        slice.map((address) =>
          client
            .readContract({
              address: token as `0x${string}`,
              abi: erc20,
              functionName: "balanceOf",
              args: [address as `0x${string}`],
            })
            .catch(() => null),
        ),
      );

      // A null is a call that did not come back; an answer of 0n is the contract saying
      // the address holds nothing. tallyAnswers is what keeps those two apart.
      const tally = tallyAnswers(slice, answers);
      answers.forEach((answer, offset) => {
        const address = slice[offset];
        if (address === undefined || answer === null) return;
        balances.set(address, answer);
      });
      failed.push(...tally.unanswered);

      if (index + CHUNK < pending.length) await sleep(PAUSE_MS);
    }

    pending = failed;
  }

  return { balances, unanswered: pending };
}

interface TokenReport {
  token: string;
  symbol: string;
  transfers: number;
  candidates: number;
  /** Addresses the event replay alone would have called holders. Never published. */
  replayHolders: Set<string>;
  /** Addresses the contract confirms hold a positive balance. */
  holders: Set<string>;
  disagree: number;
  /** Candidate confirmations the contract answered. */
  confirmed: number;
  /** Candidates the contract never answered for. Never counted as zero balances. */
  unanswered: number;
  /** This token's confirmation coverage, as the run's verdict consumes it. */
  coverage: TokenCoverage;
}

async function auditToken(token: string, height: number): Promise<TokenReport> {
  const logs = await sweep(token, height);
  const { balances, applied } = replay(logs);
  const candidates = [...balances.keys()];
  const { balances: onChain, unanswered } = await confirm(token, candidates);

  const symbol = await client
    .readContract({ address: token as `0x${string}`, abi: erc20, functionName: "symbol" })
    .catch(() => "?");

  const holders = new Set<string>();
  const replayHolders = new Set<string>();
  let disagree = 0;

  for (const address of candidates) {
    const mine = balances.get(address) ?? 0n;
    const real = onChain.get(address);
    if (mine > 0n) replayHolders.add(address);
    // An address the contract never answered for decides nothing, in either direction.
    if (real === undefined) continue;
    if (real !== mine) disagree++;
    if (real > 0n) holders.add(address);
  }

  return {
    token,
    symbol: String(symbol).slice(0, 10),
    transfers: applied,
    candidates: candidates.length,
    replayHolders,
    holders,
    disagree,
    confirmed: onChain.size,
    unanswered: unanswered.length,
    coverage: tokenCoverage(token, candidates.length, onChain.size),
  };
}

/** Why the page-vs-verifier comparison did not run, in the reader's terms. */
function skipReason(reason: ComparisonReason): string {
  switch (reason) {
    case "page-snapshot-incomplete":
      // holders-window.ts persists a running subtotal and the page displays "--" until
      // every token is confirmed. That subtotal is not a claim, so it is not compared.
      return "the page has not finished confirming its universe, so it has published no holder count to compare.";
    case "verifier-coverage-incomplete":
      return "some candidate in the page's universe went unconfirmed here, so a recount cannot judge it either way.";
    case "no-snapshot":
      return "nothing published yet — open /analytics, then re-run.";
    case "ok":
      return "";
  }
}

function unionOver(reports: Map<string, TokenReport>, tokens: readonly string[]): Set<string> {
  const all = new Set<string>();
  for (const token of tokens) {
    for (const address of reports.get(token)?.holders ?? []) all.add(address);
  }
  return all;
}

async function main(): Promise<void> {
  if (apiToken() === "") throw new Error("ENVIO_API_TOKEN is not set.");

  const heightRes = await fetch(HEIGHT_URL);
  if (!heightRes.ok) throw new Error(`HyperSync height HTTP ${heightRes.status}`);
  const height = ((await heightRes.json()) as { height: number }).height;

  const discovery = isUniswapV2Available(poolixConfig)
    ? await discoverPools()
    : { pools: [], totalPairs: 0, scanned: 0, complete: false };

  const mine = [...new Set(discovery.pools.map((pool) => pool.other.address.toLowerCase()))];
  const state = await loadPublished();
  const published = state?.published ?? null;
  const theirs = published?.universe ?? [];

  console.log("Poolix holders verification");
  console.log(`network           : ${poolixConfig.chain.name} (${poolixConfig.chain.id})`);
  console.log(`HyperSync height  : ${height.toLocaleString("en-US")}  (indexing reference: how far the`);
  console.log(`                    Transfer sweep runs, i.e. what the candidate set is complete as of)`);
  console.log(`balanceOf reads   : "latest" tag — current chain state, NOT a pinned historical block.`);
  console.log(`                    This endpoint offers no archive state, so no exact block-state is claimed.`);
  console.log(
    `pool scan         : ${discovery.pools.length} pools from ${discovery.scanned} of ${discovery.totalPairs.toLocaleString("en-US")} pairs`,
  );
  console.log(`unique tokens     : ${mine.length}  (WETH excluded: the scanner records only the non-WETH side)`);

  if (mine.length === 0 && theirs.length === 0) {
    throw new Error("Token universe is empty — open /analytics first.");
  }

  // Everything either side cares about, so the recount can be restricted to the page's
  // universe afterwards even when the two scans disagree about what is in scope.
  const working = [...new Set([...mine, ...theirs])];
  const reports = new Map<string, TokenReport>();

  console.log("\n-- replaying and confirming every token in scope --");
  console.log("token                                       symbol    transfers  cand.  replay+  chain+  disagree");
  for (const token of working) {
    const report = await auditToken(token, height);
    reports.set(token, report);
    console.log(
      `${token}  ${report.symbol.padEnd(10)}  ${String(report.transfers).padStart(9)}  ` +
        `${String(report.candidates).padStart(5)}  ${String(report.replayHolders.size).padStart(7)}  ` +
        `${String(report.holders.size).padStart(6)}  ${String(report.disagree).padStart(8)}`,
    );
    if (report.unanswered > 0) {
      // Not a failed check: an unanswered call is missing knowledge, not a wrong number.
      // It makes the run INCOMPLETE further down, which is a different claim from FAIL.
      console.log(
        `     INCOMPLETE: ${report.unanswered.toLocaleString("en-US")} of ${report.candidates.toLocaleString("en-US")} balanceOf calls went unanswered`,
      );
    }
  }

  const label = (token: string) => `${reports.get(token)?.symbol ?? "?"} ${token}`;

  console.log("\n-- token universe snapshot --");
  console.log(`  verifier (${mine.length}):`);
  for (const token of mine) console.log(`    ${label(token)}`);
  if (published === null) {
    console.log("  page: nothing published yet — open /analytics, then re-run.");
  } else {
    console.log(`  page (${theirs.length}), published ${new Date(published.at).toISOString()}:`);
    for (const token of theirs) console.log(`    ${label(token)}`);

    const onlyMine = mine.filter((t) => !theirs.includes(t));
    const onlyTheirs = theirs.filter((t) => !mine.includes(t));
    if (onlyMine.length === 0 && onlyTheirs.length === 0) {
      console.log("  the two scans agree on the universe.");
    } else {
      // Surfaced, never silently reconciled: the pool scan covers a moving window and
      // shrinks under throttling, so the two runs can legitimately see different sets.
      console.log("  the two scans DISAGREE (the pool scan window moves between runs):");
      for (const token of onlyMine) console.log(`    only the verifier saw  ${label(token)}`);
      for (const token of onlyTheirs) console.log(`    only the page saw      ${label(token)}`);
    }
  }

  const mineHolders = unionOver(reports, mine);
  const replayOnly = new Set<string>();
  let transfers = 0;
  let candidates = 0;
  let disagreements = 0;
  for (const token of mine) {
    const report = reports.get(token);
    if (!report) continue;
    transfers += report.transfers;
    candidates += report.candidates;
    disagreements += report.disagree;
    for (const address of report.replayHolders) replayOnly.add(address);
  }

  /*
    Confirmation coverage, per token and in total.

    This is the section that decides whether any holder count below may be stated at all.
    balanceOf is authoritative in Poolix's holder definition, so an unanswered call leaves
    an address undecided — neither a holder nor a non-holder. A total summed over undecided
    addresses is a lower bound of unknown tightness, and presenting it as "holders" would
    claim more than was measured.
  */
  const coverageOver = (tokens: readonly string[]) =>
    aggregateCoverage(
      tokens
        .map((token) => reports.get(token)?.coverage)
        .filter((entry): entry is TokenCoverage => entry !== undefined),
    );

  /*
    Three populations, because three different claims depend on them:

      runCoverage   every token audited — decides the run's verdict
      mineCoverage  the verifier's own universe — gates the count it reports
      pageCoverage  the page's universe — gates the page-vs-verifier comparison

    Using one for all three would either withhold a count that was fully established or,
    worse, report PASS on a run whose comparison never executed.
  */
  const runCoverage = coverageOver(working);
  const mineCoverage = coverageOver(mine);
  /* Set below. A run whose comparison never executed has verified nothing. */
  let comparisonRan = false;

  console.log("\n-- confirmation coverage (balanceOf is authoritative) --");
  console.log("token                                       symbol      cand.  confirmed  unanswered  coverage");
  for (const token of working) {
    const report = reports.get(token);
    if (report === undefined) continue;
    const pct = (coverageRatio(report.coverage) * 100).toFixed(2);
    console.log(
      `${token}  ${report.symbol.padEnd(10)}  ${String(report.candidates).padStart(5)}  ` +
        `${String(report.confirmed).padStart(9)}  ${String(report.unanswered).padStart(10)}  ` +
        `${pct.padStart(7)}%${report.unanswered > 0 ? "  <- INCOMPLETE" : ""}`,
    );
  }
  console.log(
    `  TOTAL: ${runCoverage.confirmed.toLocaleString("en-US")} of ${runCoverage.candidates.toLocaleString("en-US")} candidates confirmed, ` +
      `${runCoverage.unanswered.toLocaleString("en-US")} unanswered across ${runCoverage.tokens.length} token(s)`,
  );
  console.log(
    `  tokens fully confirmed          : ${runCoverage.tokens.length - runCoverage.incompleteTokens.length} of ${runCoverage.tokens.length}`,
  );
  if (!runCoverage.complete) {
    console.log(
      `  tokens NOT fully confirmed      : ${runCoverage.incompleteTokens.length === 0 ? "(the universe is empty)" : runCoverage.incompleteTokens.join(", ")}`,
    );
  }

  console.log("\n-- verifier result, over its own universe --");
  console.log(`  unique token count              : ${mine.length}`);
  console.log(`  Transfer events replayed        : ${transfers.toLocaleString("en-US")}`);
  console.log(`  candidate addresses             : ${candidates.toLocaleString("en-US")}`);
  console.log(`  addresses the contracts dispute : ${disagreements.toLocaleString("en-US")}`);
  console.log(`  holders by replay alone         : ${replayOnly.size.toLocaleString("en-US")}  (NOT published)`);
  console.log(
    `  HOLDERS by balanceOf            : ${
      mineCoverage.complete
        ? mineHolders.size.toLocaleString("en-US")
        : `-- (withheld: ${mineCoverage.unanswered.toLocaleString("en-US")} candidate(s) unconfirmed)`
    }`,
  );

  console.log("\n-- page vs verifier --");
  if (published === null) {
    console.log("  ·    no published snapshot yet — open /analytics, then re-run to compare.");
  } else {
    /*
      Both sides are recounted over the SAME universe: the one the page published over.
      Comparing each run's own universe would compare two different questions whenever the
      pool scan window moved, which it routinely does.

      Exact equality is still not guaranteed — the page read balances at one moment and
      this run at a later one, and balances move — so the check is on the size of the
      symmetric difference, which stays tiny under drift and explodes under a real defect.
    */
    const recount = unionOver(reports, theirs);
    const onlyVerifier = [...recount].filter((a) => !mineHolders.has(a));

    /*
      The comparison is made over the PAGE's universe, so it is that universe's coverage
      that decides whether the recount may be compared — not the verifier's own.
    */
    const pageCoverage = coverageOver(theirs);

    check("page universe fully audited", theirs.every((t) => reports.has(t)), true);
    console.log(`  ·    page published HOLDERS               ${published.holders.toLocaleString("en-US")}`);
    console.log(
      `  ·    verifier recount, same universe      ${
        pageCoverage.complete
          ? recount.size.toLocaleString("en-US")
          : `-- (withheld: ${pageCoverage.unanswered.toLocaleString("en-US")} candidate(s) unconfirmed)`
      }`,
    );
    console.log(
      `  ·    page-universe coverage               ${pageCoverage.confirmed.toLocaleString("en-US")} / ${pageCoverage.candidates.toLocaleString("en-US")} candidates confirmed`,
    );
    console.log(`  ·    page tokenCount / confirmed          ${published.tokenCount} / ${published.tokensConfirmed} (complete: ${published.complete})`);
    console.log(`  ·    page HyperSync height                ${published.latestBlock.toLocaleString("en-US")}`);
    console.log(`  ·    page balances read near block        ${published.confirmedBlock?.toLocaleString("en-US") ?? "--"}`);
    console.log(`  ·    this run HyperSync height            ${height.toLocaleString("en-US")}`);
    console.log(`  ·    blocks elapsed between the two       ${(height - published.latestBlock).toLocaleString("en-US")}`);
    if (onlyVerifier.length > 0 || mine.length !== theirs.length) {
      console.log(`  ·    verifier-universe HOLDERS            ${mineHolders.size.toLocaleString("en-US")} (differs only because the universe differs)`);
    }

    /*
      Tolerance is deliberately tight. An earlier floor of 25 let a page publishing 12
      holders against a true 23 pass as "block drift", which is the opposite of what this
      check exists for. Legitimate drift over the minutes between the two reads is a
      handful of addresses at most; anything beyond a few percent is a defect.
    */
    const readiness = comparisonReadiness(pageCoverage, published);
    comparisonRan = readiness.comparable;

    if (!readiness.comparable) {
      /*
        Not run, and deliberately not failed. A verdict about the implementation needs
        evidence that supports one, and neither an unconfirmed recount nor an unfinished
        page subtotal is that.
      */
      console.log(`  SKIP page matches verifier${" ".repeat(15)}${skipReason(readiness.reason)}`);
    } else {
      const drift = Math.abs(published.holders - recount.size);
      const tolerance = Math.max(3, Math.ceil(recount.size * 0.02));
      const ok = drift <= tolerance;
      if (!ok) failures++;
      console.log(
        `  ${ok ? "PASS" : "FAIL"} page matches verifier${" ".repeat(19)}|${published.holders} - ${recount.size}| = ${drift} <= ${tolerance}` +
          `${ok ? "" : "  — too large to be block drift alone"}`,
      );
    }
  }

  /*
    Three outcomes, not two.

    PASS       every candidate was decided by its contract and every check held.
    INCOMPLETE the checks that ran held, but some candidate was never answered for, so the
               holder count was not established. This is NOT a pass: it reports that the
               question could not be settled, which is a different claim from settling it.
    FAIL       something was actually measured to be wrong. An observed defect outranks
               unknown coverage, because it is the firmer piece of news.
  */
  const verdict = runVerdict({ coverage: runCoverage, failedChecks: failures, comparisonRan });

  console.log(`\n-- verdict: ${verdict} --`);
  switch (verdict) {
    case "PASS":
      console.log(
        `  All checks passed over ${runCoverage.candidates.toLocaleString("en-US")} fully confirmed candidate(s) across ${runCoverage.tokens.length} token(s).`,
      );
      break;
    case "INCOMPLETE":
      if (runCoverage.tokens.length === 0) {
        console.log("  No token was audited, so no holder count was established.");
      } else if (!runCoverage.complete) {
        console.log(
          `  ${runCoverage.unanswered.toLocaleString("en-US")} of ${runCoverage.candidates.toLocaleString("en-US")} candidate(s) were never answered for, across ` +
            `${runCoverage.incompleteTokens.length} of ${runCoverage.tokens.length} token(s).`,
        );
        console.log("  No holder count is reported. Re-run when the RPC answers every candidate.");
      } else {
        console.log(
          `  Confirmation coverage was complete (${runCoverage.confirmed.toLocaleString("en-US")}/${runCoverage.candidates.toLocaleString("en-US")}) ` +
            "and no check failed, but the page comparison did not run.",
        );
        console.log("  Nothing was disproved and nothing was confirmed. See the SKIP line above.");
      }
      break;
    case "FAIL":
      console.log(`  ${failures} CHECK(S) FAILED — see the FAIL lines above.`);
      break;
  }

  process.exitCode = exitCodeFor(verdict);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

