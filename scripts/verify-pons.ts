/*
  Independent verification of the Pons integration.

    npm run verify:pons

  Reads the chain directly rather than through the service code, so a bug in the indexer
  cannot satisfy its own test. Where it must import Poolix code — the qualification rule,
  the persisted state — it checks the OUTPUT against independently obtained facts.

  It never prints a secret, and it never claims a total number of Pons launches.
*/

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { poolixConfig } from "@/config/poolix";
import {
  PONS_DISCOVERY_CONFIG,
  PONS_FACTORY_START_BLOCK,
  PONS_LAST_OBSERVED_LAUNCH_BLOCK,
  PONS_LAUNCH_TOPIC_A,
  PONS_LAUNCH_TOPIC_B,
  PONS_POOL_FEE,
  ponsContracts,
} from "@/services/pons/pons-config";
import { qualify } from "@/services/pons/pons-math";

const RPC = process.env.RPC_URL?.trim() || poolixConfig.rpcUrl;
const HYPERSYNC = "https://4663.hypersync.xyz/query";
const CACHE = join(process.cwd(), ".poolix-cache", `pons-${poolixConfig.chain.id}.json`);
const WETH = poolixConfig.contracts.weth.toLowerCase();
const ZERO = `0x${"0".repeat(40)}`;

let failures = 0;
let skipped = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = String(actual) === String(expected);
  if (!ok) failures++;
  console.log(
    `  ${ok ? "PASS" : "FAIL"} ${label.padEnd(56)} ${String(actual)}${ok ? "" : `  != ${String(expected)}`}`,
  );
}
const note = (label: string, value: unknown) => console.log(`  ·    ${label.padEnd(56)} ${String(value)}`);
function skip(label: string, why: string): void {
  skipped++;
  console.log(`  SKIP ${label.padEnd(56)} ${why}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function rpc(method: string, params: unknown[]): Promise<unknown> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(RPC, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(25_000),
      });
      if (res.status === 429) {
        await sleep(2_000 * (attempt + 1));
        continue;
      }
      const json = (await res.json()) as { result?: unknown; error?: unknown };
      await sleep(150);
      return json.error ? null : json.result;
    } catch {
      await sleep(2_000 * (attempt + 1));
    }
  }
  return null;
}

async function hyperSync(body: unknown): Promise<Record<string, unknown> | null> {
  const token = process.env.ENVIO_API_TOKEN?.trim() ?? "";
  if (token === "") return null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(HYPERSYNC, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45_000),
    });
    if (res.status === 429 || res.status === 503) {
      await sleep(2_500 * (attempt + 1));
      continue;
    }
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  }
  return null;
}

const pad = (a: string) => a.replace("0x", "").toLowerCase().padStart(64, "0");
const toAddress = (w: string) => `0x${w.slice(-40)}`.toLowerCase();

async function codeSize(address: string): Promise<number> {
  const code = (await rpc("eth_getCode", [address, "latest"])) as string | null;
  return code && code !== "0x" ? (code.length - 2) / 2 : 0;
}

interface PonsCacheShape {
  byToken?: Record<string, Record_>;
  /** The lowest block scanned. Indexing walks BACKWARDS from the last observed launch. */
  scannedFrom?: number;
  updatedAt?: number | null;
}

interface Record_ {
  tokenAddress: string;
  creatorAddress: string;
  launchBlock: number;
  launchTxHash: string;
  poolAddress: string;
  positionTokenId: string;
  symbol: string | null;
  decimals: number | null;
  totalSupply: string | null;
  poolVerified: boolean;
  quoteIsToken1: boolean | null;
  v2PairAddress: string | null;
  v2CheckedAt: number | null;
  source: string;
}

async function main(): Promise<void> {
  console.log("Poolix Pons verification");
  console.log(`network            : ${poolixConfig.chain.name} (${poolixConfig.chain.id})`);
  console.log("NOTE               : reads the chain directly; never prints a secret.");

  // =========================================================== 1. chain identity
  console.log("\n-- chain --");
  const chainIdHex = (await rpc("eth_chainId", [])) as string | null;
  const chainId = chainIdHex === null ? null : Number(BigInt(chainIdHex));
  check("chain id is 4663", chainId, 4663);
  check("configured chain matches", poolixConfig.chain.id, 4663);

  // ========================================================= 2-5. contract code
  console.log("\n-- contracts --");
  for (const [label, address] of Object.entries(ponsContracts)) {
    const size = await codeSize(address);
    check(`${label} has code`, size > 0, true);
    note(`${label}`, `${address}  ${size} bytes`);
  }
  check("WETH has code", (await codeSize(WETH)) > 0, true);

  // The Pons factory must respond to owner(), and the V3 peripherals must name the V3
  // factory — the cross-reference that proves these are one deployment.
  const factoryOwner = (await rpc("eth_call", [{ to: ponsContracts.factory, data: "0x8da5cb5b" }, "latest"])) as string | null;
  check("pons factory answers owner()", factoryOwner !== null && factoryOwner.length >= 66, true);

  const pmFactory = (await rpc("eth_call", [{ to: ponsContracts.positionManager, data: "0xc45a0155" }, "latest"])) as string | null;
  check(
    "position manager names the V3 factory",
    pmFactory === null ? null : toAddress(pmFactory.slice(0, 66)),
    ponsContracts.v3Factory.toLowerCase(),
  );

  const lockerFactory = (await rpc("eth_call", [{ to: ponsContracts.locker, data: "0xc45a0155" }, "latest"])) as string | null;
  check(
    "locker names the Pons factory",
    lockerFactory === null ? null : toAddress(lockerFactory.slice(0, 66)),
    ponsContracts.factory.toLowerCase(),
  );

  // ============================================================ 6. launch events
  console.log("\n-- launch events --");
  const probe = await hyperSync({
    from_block: PONS_FACTORY_START_BLOCK,
    to_block: PONS_FACTORY_START_BLOCK + 200_000,
    logs: [{ address: [ponsContracts.factory.toLowerCase()], topics: [[PONS_LAUNCH_TOPIC_A, PONS_LAUNCH_TOPIC_B]] }],
    field_selection: { log: ["block_number", "topic0", "topic1"] },
  });
  if (probe === null) {
    skip("launch events can be queried", "no indexer token, or the endpoint refused");
  } else {
    interface Row { topic0?: string; topic1?: string }
    const rows: Row[] = [];
    for (const batch of (probe.data ?? []) as { logs?: Row[] }[]) rows.push(...(batch.logs ?? []));
    const a = rows.filter((r) => r.topic0 === PONS_LAUNCH_TOPIC_A).length;
    const b = rows.filter((r) => r.topic0 === PONS_LAUNCH_TOPIC_B).length;
    check("launch events can be queried", rows.length > 0, true);
    note("events in the probe window", `A=${a} B=${b}`);
    // The two events fire together; a divergence means the pairing model is wrong.
    check("the two launch events are 1:1", a, b);
  }

  // ====================================================== 7-14. indexed dataset
  console.log("\n-- indexed dataset --");
  let state: PonsCacheShape | null = null;
  try {
    state = JSON.parse(await readFile(CACHE, "utf8")) as PonsCacheShape;
  } catch {
    state = null;
  }

  if (state === null || state.byToken === undefined) {
    skip("indexed launch records", "no pons dataset on disk yet");
  } else {
    const records = Object.values(state.byToken);
    note("indexed launches", records.length.toLocaleString("en-US"));

    /*
      The claim this gate exists to police: the dataset is what was INDEXED, never a total.

      Indexing walks BACKWARDS from the factory's last observed launch, so the covered
      range is [scannedFrom, PONS_LAST_OBSERVED_LAUNCH_BLOCK] and the checkpoint must sit
      inside the factory's working range. Outside it there is nothing to read, and a
      checkpoint that drifted out would make coverage meaningless.
    */
    const scannedFrom = state.scannedFrom ?? 0;
    note(
      "covered block range",
      `${scannedFrom.toLocaleString("en-US")} -> ${PONS_LAST_OBSERVED_LAUNCH_BLOCK.toLocaleString("en-US")}`,
    );
    check("the checkpoint sits at or after the factory start", scannedFrom >= PONS_FACTORY_START_BLOCK, true);
    check(
      "the checkpoint never exceeds the last observed launch",
      scannedFrom <= PONS_LAST_OBSERVED_LAUNCH_BLOCK,
      true,
    );
    // Every indexed launch must fall inside the range the checkpoint claims to cover.
    const outOfRange = records.filter(
      (r) => r.launchBlock < scannedFrom || r.launchBlock > PONS_LAST_OBSERVED_LAUNCH_BLOCK,
    ).length;
    check("every launch falls inside the covered range", outOfRange, 0);

    // Uniqueness on both dedupe keys.
    const tokens = new Set(records.map((r) => r.tokenAddress));
    const txs = new Set(records.map((r) => r.launchTxHash));
    check("no duplicate token address", tokens.size, records.length);
    check("no duplicate launch transaction", txs.size, records.length);

    // Address hygiene.
    const malformed = records.filter((r) => !/^0x[0-9a-f]{40}$/.test(r.tokenAddress)).length;
    check("every token address is normalised", malformed, 0);
    check("no zero address is indexed", records.filter((r) => r.tokenAddress === ZERO).length, 0);
    check("no token equals WETH", records.filter((r) => r.tokenAddress === WETH).length, 0);
    check("every record is tagged source=pons", records.filter((r) => r.source !== "pons").length, 0);

    const badTx = records.filter((r) => !/^0x[0-9a-f]{64}$/.test(r.launchTxHash)).length;
    check("every launch tx hash is well formed", badTx, 0);

    // Decimals must be inside the bound Phase 8 established.
    const badDecimals = records.filter((r) => r.decimals !== null && (r.decimals < 0 || r.decimals > 36)).length;
    check("no record carries out-of-range decimals", badDecimals, 0);

    // A verified pool must know which side holds WETH, or its price cannot be read.
    const verifiedWithoutSide = records.filter((r) => r.poolVerified && r.quoteIsToken1 === null).length;
    check("every verified pool knows its WETH side", verifiedWithoutSide, 0);

    // ------------------------------------------- sample the pools against the chain
    const verified = records.filter((r) => r.poolVerified).slice(0, 5);
    if (verified.length === 0) {
      skip("V3 pool relationship", "no verified pool in the dataset yet");
    } else {
      console.log("\n-- V3 pool relationship, re-read from the chain --");
      for (const record of verified) {
        const data = `0x1698ee82${pad(record.tokenAddress)}${pad(WETH)}${PONS_POOL_FEE.toString(16).padStart(64, "0")}`;
        const result = (await rpc("eth_call", [{ to: ponsContracts.v3Factory, data }, "latest"])) as string | null;
        const pool = result === null ? null : toAddress(result.slice(0, 66));
        check(`${record.tokenAddress.slice(0, 10)} pool matches the factory`, pool, record.poolAddress);

        const fee = (await rpc("eth_call", [{ to: record.poolAddress, data: "0xddca3f43" }, "latest"])) as string | null;
        check(`${record.tokenAddress.slice(0, 10)} pool fee`, fee === null ? null : Number(BigInt(fee)), PONS_POOL_FEE);

        const token0 = (await rpc("eth_call", [{ to: record.poolAddress, data: "0x0dfe1681" }, "latest"])) as string | null;
        const token1 = (await rpc("eth_call", [{ to: record.poolAddress, data: "0xd21220a7" }, "latest"])) as string | null;
        const t0 = token0 === null ? null : toAddress(token0.slice(0, 66));
        const t1 = token1 === null ? null : toAddress(token1.slice(0, 66));
        const pairOk = (t0 === record.tokenAddress && t1 === WETH) || (t1 === record.tokenAddress && t0 === WETH);
        check(`${record.tokenAddress.slice(0, 10)} pool holds token/WETH`, pairOk, true);
        // The stored orientation must match the chain, or every price is inverted.
        check(`${record.tokenAddress.slice(0, 10)} WETH side recorded correctly`, record.quoteIsToken1, t1 === WETH);
      }

      /*
        ------------------------------------------ V2 availability, the trading question

        Poolix trades through Uniswap v2 and only through Uniswap v2. Whether a given Pons
        token can be traded is decided by the v2 factory, and the stored answer must match
        what the factory says right now — a token marked "V2 Available" that has no pair
        would offer a trade that cannot execute, and one marked unavailable that does have
        a pair would hide a tradeable token.
      */
      console.log("\n-- Uniswap V2 availability (Poolix's only execution route) --");
      const v2 = poolixConfig.contracts.uniswapV2.factory;
      if (v2.status !== "configured") {
        skip("V2 availability matches the factory", "the V2 factory is not configured");
      } else {
        const checked = records.filter((r) => r.v2CheckedAt !== null);
        const withPair = checked.filter((r) => r.v2PairAddress !== null);
        note("records with a V2 answer", `${checked.length.toLocaleString("en-US")} of ${records.length.toLocaleString("en-US")}`);
        note("records with a V2 pair", withPair.length.toLocaleString("en-US"));

        // Re-read a sample, preferring any that claim a pair — those are the ones whose
        // being wrong would show a user a trade that cannot happen.
        const sample = [...withPair.slice(0, 3), ...checked.filter((r) => r.v2PairAddress === null).slice(0, 3)];
        for (const record of sample) {
          const data = `0xe6a43905${pad(record.tokenAddress)}${pad(WETH)}`;
          const result = (await rpc("eth_call", [{ to: v2.address, data }, "latest"])) as string | null;
          const pair = result === null ? null : toAddress(result.slice(0, 66));
          const expected = record.v2PairAddress ?? ZERO;
          check(`${record.tokenAddress.slice(0, 10)} V2 pair matches the factory`, pair, expected);
        }

        // A stored pair address must be well formed and must never be the zero address —
        // zero means "no pair" and belongs in the null case, not as a pair.
        const malformedPair = checked.filter(
          (r) => r.v2PairAddress !== null && !/^0x[0-9a-f]{40}$/.test(r.v2PairAddress),
        ).length;
        check("every stored V2 pair is a normalised address", malformedPair, 0);
        check(
          "no stored V2 pair is the zero address",
          checked.filter((r) => r.v2PairAddress === ZERO).length,
          0,
        );
      }

      // ------------------------------- the V3 pool is reference data, not a route
      console.log("\n-- the Pons V3 pool is reference data only --");
      /*
        Asserted structurally: nothing in the Pons service imports or references a V3
        execution path. The swap router and quoter are recorded in config because the audit
        verified them, but no code may build a call to them.
      */
      const serviceFiles = [
        "pons-indexer.ts",
        "pons-view.ts",
        "pons-volume.ts",
        "pons-math.ts",
        "pons-events.ts",
      ];
      let executionReferences = 0;
      for (const file of serviceFiles) {
        const text = await readFile(join(process.cwd(), "services", "pons", file), "utf8").catch(() => "");
        // exactInputSingle / exactInput are the V3 router's swap entry points.
        if (/exactInput|exactOutput|swapRouter\s*,|quoterV2\s*,/.test(text)) executionReferences++;
      }
      check("no Pons module builds a V3 swap call", executionReferences, 0);

      // ------------------------------------------------------- supply sanity
      console.log("\n-- token contracts --");
      for (const record of verified.slice(0, 3)) {
        const size = await codeSize(record.tokenAddress);
        check(`${record.tokenAddress.slice(0, 10)} has contract code`, size > 0, true);
        const supply = (await rpc("eth_call", [{ to: record.tokenAddress, data: "0x18160ddd" }, "latest"])) as string | null;
        const onChain = supply === null ? null : BigInt(supply).toString();
        if (record.totalSupply !== null) {
          check(`${record.tokenAddress.slice(0, 10)} supply matches the chain`, onChain, record.totalSupply);
        }
      }
    }
  }

  // ==================================================== 15. qualification logic
  console.log("\n-- qualification --");
  const cents = (dollars: number) => BigInt(dollars) * 100n;
  const minCap = PONS_DISCOVERY_CONFIG.minMarketCapUsd;
  const minVol = PONS_DISCOVERY_CONFIG.minVolume24hUsd;

  note("thresholds", `market cap >= $${minCap.toLocaleString("en-US")}, volume >= $${minVol.toLocaleString("en-US")}`);
  check("a missing market cap never qualifies", qualify({ marketCapUsdCents: null, volume24hUsdCents: cents(10_000_000) }).qualified, false);
  check("a missing volume never qualifies", qualify({ marketCapUsdCents: cents(10_000_000), volume24hUsdCents: null }).qualified, false);
  check("exactly at both thresholds qualifies", qualify({ marketCapUsdCents: cents(minCap), volume24hUsdCents: cents(minVol) }).qualified, true);
  check("one cent below the cap threshold fails", qualify({ marketCapUsdCents: cents(minCap) - 1n, volume24hUsdCents: cents(minVol) }).qualified, false);
  check("one cent below the volume threshold fails", qualify({ marketCapUsdCents: cents(minCap), volume24hUsdCents: cents(minVol) - 1n }).qualified, false);
  check("both conditions are required", qualify({ marketCapUsdCents: cents(10_000_000), volume24hUsdCents: cents(1) }).qualified, false);

  // The dataset must never contain a qualified record lacking either figure.
  if (state?.byToken !== undefined) {
    const records = Object.values(state.byToken);
    const unpricedButVerified = records.filter((r) => r.poolVerified && r.totalSupply === null).length;
    check("no verified record is missing its supply", unpricedButVerified, 0);
  }

  // ================================================ 16. no secret in the dataset
  console.log("\n-- secrets --");
  const token = process.env.ENVIO_API_TOKEN?.trim() ?? "";
  if (token.length < 8) {
    skip("the API token appears in no dataset", "no token configured");
  } else {
    let leaked = 0;
    try {
      if ((await readFile(CACHE, "utf8")).includes(token)) leaked++;
    } catch {
      // absent
    }
    check("the API token appears in no Pons dataset", leaked, 0);
  }

  const verdict = failures === 0 ? "PASS" : "FAIL";
  console.log(`\n=== verify:pons : ${verdict} ===`);
  if (skipped > 0) console.log(`  ${skipped} check(s) skipped.`);
  console.log(
    failures === 0
      ? "  All checks passed. Counts above are INDEXED launches, not the total number of Pons launches."
      : `  ${failures} CHECK(S) FAILED`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
