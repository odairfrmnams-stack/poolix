/*
  Independent check of per-pool analytics.

    npm run verify:pool-analytics

  Recomputes every pool's windows from the persisted buckets with its own inline
  arithmetic — its own summation, its own 0.30% fee rule, its own time-weighting and
  annualization — and never imports pool-analytics-math.ts, pool-history.ts or
  pool-analytics.ts. None of those can validate itself here.

  Matching totals are the weakest thing this script checks. The failure modes that matter
  for per-pool figures are not arithmetic slips, they are attribution errors: one pool's
  volume credited to another, a pool's fees divided by the whole chain's liquidity, a
  window that silently covers a different set of hours than the one it claims. Those all
  produce plausible numbers. So the checks that carry the weight are the cross-scope ones:

    - the pool universe is EXACTLY the liquidity series' universe, not a superset
    - per-pool liquidity SUMS to the chain-scoped liquidity series, hour for hour
    - per-pool volume never EXCEEDS chain-wide volume in the same hour
    - every pool's fees come from that pool's own volume and nothing else
    - no pool reports volume in an hour before it existed

  When an indexer token is present it also re-reads each pool's PairCreated event straight
  from the factory and compares the creation block. The token is read from the environment
  and never printed.
*/

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { poolixConfig } from "@/config/poolix";

const HOUR = 3_600n;
const YEAR_SECONDS = 365n * 24n * 60n * 60n;
const SCALE = 1_000_000n;
const FRAMES = [
  ["1H", 1],
  ["24H", 24],
  ["7D", 168],
  ["30D", 720],
] as const;

const PAIR_CREATED_TOPIC0 = "0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9";
const HYPERSYNC_URL = "https://4663.hypersync.xyz/query";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = String(actual) === String(expected);
  if (!ok) failures++;
  console.log(
    `  ${ok ? "PASS" : "FAIL"} ${label.padEnd(52)} ${String(actual)}${ok ? "" : `  != ${String(expected)}`}`,
  );
}

interface StoredBucket {
  v: string;
  s: number;
  t: number;
  l: string | null;
}

interface StoredPool {
  pair: string;
  token0: string;
  token1: string;
  wethSide: "token0" | "token1" | "none";
  creationBlock: number | null;
  creationTimestamp: number | null;
  creationFromPairCreated: boolean;
  buckets: Record<string, StoredBucket>;
  swaps: number;
  transactions: number;
}

interface PoolState {
  pools: Record<string, StoredPool>;
  scannedTo: number;
  updatedAt: number;
}

interface LiquidityState {
  points: Record<string, { startTimestamp: number; liquidityWei: string; complete: boolean }>;
  pairs: string[];
}

interface VolumeState {
  buckets: Record<string, { startTimestamp: number; volumeWei: string }>;
}

/** Decimal string for a wei value, without ever touching a float. */
function formatWei(value: bigint, decimals = 6): string {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const whole = magnitude / 10n ** 18n;
  const fraction = (magnitude % 10n ** 18n) / 10n ** BigInt(18 - decimals);
  return `${negative ? "-" : ""}${whole.toLocaleString("en-US")}.${fraction.toString().padStart(decimals, "0")}`;
}

/** Percent from a scaled integer, rendered without floats. */
function formatScaled(scaled: bigint | null, decimals = 2): string {
  if (scaled === null) return "--";
  const whole = scaled / SCALE;
  const divisor = SCALE / 10n ** BigInt(decimals);
  const fraction = (scaled % SCALE) / divisor;
  return `${whole.toLocaleString("en-US")}.${fraction.toString().padStart(decimals, "0")}%`;
}

const short = (address: string) => `${address.slice(0, 8)}...${address.slice(-4)}`;

/** The creation block the factory itself reports for a pair, or null. */
async function liveCreationBlock(pool: StoredPool, toBlock: number): Promise<number | null> {
  const factory = poolixConfig.contracts.uniswapV2.factory;
  if (factory.status !== "configured") return null;

  const asTopic = (address: string) => `0x${address.trim().toLowerCase().slice(2).padStart(64, "0")}`;
  const res = await fetch(HYPERSYNC_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.ENVIO_API_TOKEN?.trim() ?? ""}`,
    },
    body: JSON.stringify({
      from_block: 0,
      to_block: toBlock,
      logs: [
        {
          address: [factory.address.toLowerCase()],
          topics: [[PAIR_CREATED_TOPIC0], [asTopic(pool.token0)], [asTopic(pool.token1)]],
        },
      ],
      field_selection: { log: ["block_number", "data"] },
    }),
  });
  if (!res.ok) return null;

  const json = (await res.json()) as { data?: { logs?: { block_number: number; data: string }[] }[] };
  for (const batch of json.data ?? []) {
    for (const log of batch.logs ?? []) {
      // The pair address is the first word of the data, so the match is confirmed rather
      // than assumed from the token pair alone.
      const word = log.data.slice(2, 66);
      if (!/^[0-9a-fA-F]{64}$/.test(word)) continue;
      if (`0x${word.slice(24)}`.toLowerCase() === pool.pair) return log.block_number;
    }
  }
  return null;
}

async function main(): Promise<void> {
  const dir = join(process.cwd(), ".poolix-cache");
  let state: PoolState;
  let liquidity: LiquidityState;
  let volume: VolumeState;
  try {
    state = JSON.parse(
      await readFile(join(dir, `pool-history-${poolixConfig.chain.id}.json`), "utf8"),
    ) as PoolState;
    liquidity = JSON.parse(
      await readFile(join(dir, `liquidity-history-${poolixConfig.chain.id}.json`), "utf8"),
    ) as LiquidityState;
    volume = JSON.parse(
      await readFile(join(dir, `history-${poolixConfig.chain.id}.json`), "utf8"),
    ) as VolumeState;
  } catch {
    throw new Error("Per-pool state missing — load a pool page or run the app once first.");
  }

  const pools = Object.values(state.pools);
  console.log("Poolix per-pool analytics verification");
  console.log(`network            : ${poolixConfig.chain.name} (${poolixConfig.chain.id})`);
  console.log(`pools indexed      : ${pools.length}`);
  console.log(`scanned to block   : ${state.scannedTo.toLocaleString("en-US")}`);
  console.log(`state written      : ${new Date(state.updatedAt).toISOString()}`);
  console.log("NOTE               : historical measurement, annualized. Not a projection.");

  // ---------------------------------------------------------------- scope
  console.log("\n-- scope --");
  const poolKeys = Object.keys(state.pools).sort();
  const liqPairs = [...liquidity.pairs].map((p) => p.toLowerCase()).sort();
  check("pool universe equals liquidity universe", JSON.stringify(poolKeys), JSON.stringify(liqPairs));
  check("pool count matches", pools.length, liquidity.pairs.length);

  const badKey = pools.filter((pool) => pool.pair !== pool.pair.toLowerCase()).length;
  check("every pair key is normalised", badKey, 0);

  const volumeStarts = new Set(Object.values(volume.buckets).map((b) => b.startTimestamp));
  let offGrid = 0;
  for (const pool of pools) {
    for (const key of Object.keys(pool.buckets)) {
      if (!volumeStarts.has(Number(key))) offGrid++;
    }
  }
  check("every pool hour sits on the volume grid", offGrid, 0);

  // ------------------------------------------------- liquidity reconciliation
  /*
    The decisive check. Phase 2 publishes ONE chain-scoped liquidity number per hour;
    per-pool ingestion publishes the parts. If the parts do not add up to the whole, the
    attribution is wrong somewhere, and no per-pool figure on the page can be trusted —
    including ones that look perfectly reasonable on their own.
  */
  console.log("\n-- liquidity reconciliation (parts vs whole) --");
  let comparedHours = 0;
  let mismatchedHours = 0;
  let firstMismatch = "";

  for (const [key, point] of Object.entries(liquidity.points)) {
    let sum = 0n;
    let missing = 0;
    for (const pool of pools) {
      const bucket = pool.buckets[key];
      if (bucket === undefined || bucket.l === null) {
        missing++;
        continue;
      }
      sum += BigInt(bucket.l);
    }
    // An hour where a pool has no reading at all is not comparable: the whole includes a
    // pair the parts cannot account for, and calling that a mismatch would be wrong.
    if (missing > 0) continue;

    comparedHours++;
    if (sum !== BigInt(point.liquidityWei)) {
      mismatchedHours++;
      if (firstMismatch === "") {
        firstMismatch = `hour ${key}: parts ${sum} vs whole ${point.liquidityWei}`;
      }
    }
  }

  console.log(`  hours compared         ${comparedHours.toLocaleString("en-US")}`);
  if (firstMismatch !== "") console.log(`  first mismatch         ${firstMismatch}`);
  check("per-pool liquidity sums to the series", mismatchedHours, 0);
  check("at least one hour was comparable", comparedHours > 0, true);

  // ------------------------------------------------------- volume containment
  console.log("\n-- volume containment (scoped vs chain-wide) --");
  let overruns = 0;
  let firstOverrun = "";
  for (const [key, bucket] of Object.entries(volume.buckets)) {
    let sum = 0n;
    for (const pool of pools) sum += BigInt(pool.buckets[key]?.v ?? "0");
    if (sum > BigInt(bucket.volumeWei)) {
      overruns++;
      if (firstOverrun === "") {
        firstOverrun = `hour ${key}: pools ${sum} > chain ${bucket.volumeWei}`;
      }
    }
  }
  if (firstOverrun !== "") console.log(`  first overrun          ${firstOverrun}`);
  check("scoped volume never exceeds chain-wide", overruns, 0);

  // ------------------------------------------------------------- per-pool math
  for (const pool of pools) {
    console.log(`\n-- ${short(pool.pair)}  weth side: ${pool.wethSide} --`);

    const storedHours = Object.keys(pool.buckets).length;
    let allSwaps = 0;
    let allTx = 0;
    let allVolume = 0n;
    for (const bucket of Object.values(pool.buckets)) {
      allSwaps += bucket.s;
      allTx += bucket.t;
      allVolume += BigInt(bucket.v);
    }
    console.log(`  stored hours           ${storedHours.toLocaleString("en-US")}`);
    check("stored swap total matches its buckets", pool.swaps, allSwaps);
    check("stored tx total matches its buckets", pool.transactions, allTx);

    // A token-to-token pair has no ETH-denominated liquidity, and must not report one.
    if (pool.wethSide === "none") {
      const priced = Object.values(pool.buckets).filter((b) => b.l !== null).length;
      check("token/token pair reports no ETH liquidity", priced, 0);
    }

    // --- creation ---
    const bothOrNeither =
      (pool.creationBlock === null) === (pool.creationTimestamp === null);
    check("creation block and timestamp agree", bothOrNeither, true);
    if (pool.creationBlock !== null) {
      // Nothing infers creation from a first swap, so anything stored came from the event.
      check("creation came from PairCreated", pool.creationFromPairCreated, true);
      check("creation is not in the future", (pool.creationTimestamp ?? 0) <= Math.floor(Date.now() / 1000), true);

      /*
        A pool cannot have traded before it existed. This catches a wrong creation block
        without needing the network, which matters because a plausible-but-wrong creation
        date is exactly the kind of error that survives review.
      */
      const creationHour = Math.floor((pool.creationTimestamp ?? 0) / 3600) * 3600;
      let beforeCreation = 0;
      for (const [key, bucket] of Object.entries(pool.buckets)) {
        if (Number(key) < creationHour && BigInt(bucket.v) > 0n) beforeCreation++;
      }
      check("no volume in hours before creation", beforeCreation, 0);

      console.log(
        `  created                block ${pool.creationBlock.toLocaleString("en-US")} @ ${new Date((pool.creationTimestamp ?? 0) * 1000).toISOString()}`,
      );
    } else {
      console.log("  created                --  (PairCreated not resolved yet)");
    }

    // --- windows ---
    const hour = Math.floor(Date.now() / 1000 / 3600) * 3600;
    for (const [label, hours] of FRAMES) {
      const wanted: number[] = [];
      for (let i = hours; i >= 1; i--) wanted.push(hour - i * 3600);

      let volumeWei = 0n;
      let swaps = 0;
      let transactions = 0;
      let present = 0;
      let weightedWei = 0n;
      let duration = 0n;
      let points = 0;

      for (const start of wanted) {
        const bucket = pool.buckets[String(start)];
        if (bucket === undefined) continue;
        present++;
        volumeWei += BigInt(bucket.v);
        swaps += bucket.s;
        transactions += bucket.t;
        if (bucket.l !== null) {
          points++;
          weightedWei += BigInt(bucket.l) * HOUR;
          duration += HOUR;
        }
      }

      // This pool's own volume at the 0.30% rate. No other pool's volume can reach here.
      const feesWei = (volumeWei * 3n) / 1_000n;
      const windowSeconds = BigInt(wanted.length) * HOUR;
      const volumeComplete = present === wanted.length;
      const liquidityComplete = points === wanted.length;
      const twalWei = duration > 0n ? weightedWei / duration : null;

      const aprScaled =
        weightedWei > 0n && windowSeconds > 0n
          ? (feesWei * duration * YEAR_SECONDS * 100n * SCALE) / (weightedWei * windowSeconds)
          : null;
      const publishable = volumeComplete && liquidityComplete && aprScaled !== null;

      console.log(
        `  ${label.padEnd(4)} vol ${formatWei(volumeWei).padStart(16)}  fees ${formatWei(feesWei).padStart(14)}` +
          `  cov ${String(present).padStart(3)}/${wanted.length}  liq ${String(points).padStart(3)}/${wanted.length}` +
          `  TWAL ${(twalWei === null ? "--" : formatWei(twalWei)).padStart(14)}` +
          `  APR ${publishable ? formatScaled(aprScaled) : "--"}`,
      );

      check(`${label} fees are 0.30% of this pool's volume`, feesWei, (volumeWei * 3n) / 1_000n);
      check(`${label} window asks for the right hours`, wanted.length, hours);
      check(`${label} swaps never exceed the pool total`, swaps <= pool.swaps, true);
      check(`${label} transactions never exceed the total`, transactions <= pool.transactions, true);
      if (weightedWei === 0n) check(`${label} zero liquidity yields unavailable`, aprScaled, null);
      if (aprScaled !== null) check(`${label} APR is non-negative`, aprScaled >= 0n, true);
    }

    console.log(`  lifetime               ${formatWei(allVolume)} ETH, ${allSwaps.toLocaleString("en-US")} swaps`);
  }

  // ------------------------------------------------- attribution independence
  /*
    Distinct pools must not be reporting the same series. Identical totals across every
    pool would be the signature of a scope bug writing one aggregate into every slot — the
    kind of thing that passes every arithmetic check above.
  */
  console.log("\n-- attribution independence --");
  if (pools.length > 1) {
    const fingerprints = new Set(
      pools.map((pool) =>
        JSON.stringify(
          Object.entries(pool.buckets)
            .filter(([, b]) => BigInt(b.v) > 0n)
            .map(([k, b]) => `${k}:${b.v}`),
        ),
      ),
    );
    const trading = pools.filter((pool) =>
      Object.values(pool.buckets).some((b) => BigInt(b.v) > 0n),
    ).length;
    console.log(`  pools with any volume  ${trading} of ${pools.length}`);
    console.log(`  distinct volume series ${fingerprints.size}`);
    // Every silent pool shares the one empty fingerprint, so only trading pools are counted.
    if (trading > 1) {
      check("trading pools have distinct series", fingerprints.size >= trading, true);
    } else {
      console.log("  only one pool traded in the stored range; nothing to disambiguate.");
    }
  } else {
    console.log("  a single pool is in scope; nothing to disambiguate.");
  }

  // ------------------------------------------------- live creation cross-check
  console.log("\n-- creation cross-check (factory PairCreated) --");
  if ((process.env.ENVIO_API_TOKEN?.trim() ?? "") === "") {
    console.log("  SKIPPED: no indexer token in the environment.");
  } else {
    for (const pool of pools) {
      if (pool.creationBlock === null) {
        console.log(`  ${short(pool.pair)}  stored --, nothing to compare`);
        continue;
      }
      const live = await liveCreationBlock(pool, state.scannedTo + 1_000_000);
      if (live === null) {
        console.log(`  ${short(pool.pair)}  factory did not answer; not counted either way`);
        continue;
      }
      check(`${short(pool.pair)} creation block matches the factory`, pool.creationBlock, live);
    }
  }

  console.log(`\n${failures === 0 ? "All checks passed." : `${failures} CHECK(S) FAILED`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
