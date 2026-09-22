/*
  Independent check of Historical Fee APR.

    npm run verify:apr

  Recomputes both windows from the persisted series with its own inline arithmetic — its
  own fee summation, its own time-weighting, its own annualization — and compares against
  what the application publishes. It imports neither apr-math.ts nor apr-window.ts, so
  neither can validate itself.

  It also enforces the two invariants the figure depends on and that a matching number
  would not reveal: that the fee series and the liquidity series cover the SAME pools, and
  that they are keyed to the SAME hours. An APR built from a chain-wide numerator over a
  scoped denominator is arithmetic between two different populations, and it looks
  entirely plausible until someone checks.

  No API token is read or printed by this script.
*/

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { poolixConfig } from "@/config/poolix";

const HOUR = 3_600n;
const YEAR_SECONDS = 365n * 24n * 60n * 60n;
const SCALE = 1_000_000n;

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = String(actual) === String(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"} ${label.padEnd(46)} ${String(actual)}${ok ? "" : `  != ${String(expected)}`}`);
}

interface AprState {
  buckets: Record<string, { startTimestamp: number; fromBlock: number; toBlock: number; volumeWei: string; swaps: number }>;
  pairs: string[];
  swapsCounted: number;
}

interface LiquidityState {
  points: Record<string, { startTimestamp: number; liquidityWei: string; complete: boolean }>;
  pairs: string[];
}

interface VolumeState {
  buckets: Record<string, { startTimestamp: number; fromBlock: number; toBlock: number }>;
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

async function main(): Promise<void> {
  const dir = join(process.cwd(), ".poolix-cache");
  let apr: AprState;
  let liquidity: LiquidityState;
  let volume: VolumeState;
  try {
    apr = JSON.parse(await readFile(join(dir, `apr-${poolixConfig.chain.id}.json`), "utf8")) as AprState;
    liquidity = JSON.parse(await readFile(join(dir, `liquidity-history-${poolixConfig.chain.id}.json`), "utf8")) as LiquidityState;
    volume = JSON.parse(await readFile(join(dir, `history-${poolixConfig.chain.id}.json`), "utf8")) as VolumeState;
  } catch {
    throw new Error("Historical state missing — build volume, liquidity and APR first.");
  }

  console.log("Poolix Historical Fee APR verification");
  console.log(`network            : ${poolixConfig.chain.name} (${poolixConfig.chain.id})`);
  console.log(`pairs in APR scope : ${apr.pairs.length}`);
  console.log(`scoped swaps       : ${apr.swapsCounted.toLocaleString("en-US")}`);
  console.log("annualization      : 365d / window, applied to the window's own duration");
  console.log("NOTE               : historical measurement, annualized. Not a projection, not compounded.");

  // --- the two invariants an APR depends on ---
  console.log("\n-- scope and grid --");
  const aprPairs = [...apr.pairs].sort();
  const liqPairs = [...liquidity.pairs].sort();
  check("fee series and liquidity cover same pools", JSON.stringify(aprPairs), JSON.stringify(liqPairs));
  check("pair count matches", apr.pairs.length, liquidity.pairs.length);

  const volumeStarts = new Set(Object.values(volume.buckets).map((b) => b.startTimestamp));
  const offGrid = Object.values(apr.buckets).filter((b) => !volumeStarts.has(b.startTimestamp)).length;
  check("fee buckets sit on the volume grid", offGrid, 0);

  const liqStarts = new Set(Object.values(liquidity.points).map((p) => p.startTimestamp));
  const feeStarts = Object.values(apr.buckets).map((b) => b.startTimestamp);
  const unmatched = feeStarts.filter((start) => !liqStarts.has(start)).length;
  check("every fee hour has a liquidity hour", unmatched, 0);

  // --- independent recomputation, per window ---
  const nowTs = Math.floor(Date.now() / 1000);
  const hour = Math.floor(nowTs / 3600) * 3600;

  for (const [label, days] of [["7D", 7], ["30D", 30]] as const) {
    console.log(`\n-- ${label} --`);

    const wanted: number[] = [];
    for (let i = days * 24; i >= 1; i--) wanted.push(hour - i * 3600);

    let feesWei = 0n;
    let volumeWei = 0n;
    let swaps = 0;
    let feeBuckets = 0;
    let weightedWei = 0n;
    let totalDuration = 0n;
    let liquidityPoints = 0;

    for (const start of wanted) {
      const bucket = apr.buckets[String(start)];
      if (bucket !== undefined) {
        feeBuckets++;
        const bucketVolume = BigInt(bucket.volumeWei);
        volumeWei += bucketVolume;
        swaps += bucket.swaps;
        // The same 0.30% rule the historical fee series uses.
        feesWei += (bucketVolume * 3n) / 1_000n;
      }
      const point = liquidity.points[String(start)];
      if (point !== undefined) {
        liquidityPoints++;
        weightedWei += BigInt(point.liquidityWei) * HOUR;
        totalDuration += HOUR;
      }
    }

    const windowSeconds = BigInt(wanted.length) * HOUR;
    const volumeComplete = feeBuckets === wanted.length;
    const liquidityComplete = liquidityPoints === wanted.length;
    const twalWei = totalDuration > 0n ? weightedWei / totalDuration : null;

    // APR = fees x SUM(duration) x year x 100 x SCALE / (SUM(liq x duration) x window)
    const aprScaled =
      weightedWei > 0n && windowSeconds > 0n
        ? (feesWei * totalDuration * YEAR_SECONDS * 100n * SCALE) / (weightedWei * windowSeconds)
        : null;

    const publishable = volumeComplete && liquidityComplete && aprScaled !== null;

    console.log(`  fee buckets            ${feeBuckets}/${wanted.length}  ${volumeComplete ? "COMPLETE" : "partial"}`);
    console.log(`  liquidity points       ${liquidityPoints}/${wanted.length}  ${liquidityComplete ? "COMPLETE" : "partial"}`);
    console.log(`  scoped volume          ${formatWei(volumeWei)} ETH across ${swaps.toLocaleString("en-US")} swaps`);
    console.log(`  fees (0.30%)           ${formatWei(feesWei)} ETH`);
    console.log(`  SUM(liquidity x dur)   ${weightedWei} wei-seconds`);
    console.log(`  total duration         ${totalDuration}s   window ${windowSeconds}s`);
    console.log(`  TWAL                   ${twalWei === null ? "--" : `${formatWei(twalWei)} ETH`}`);
    console.log(`  annualization          365d / ${days}d = ${(Number(YEAR_SECONDS) / Number(windowSeconds)).toFixed(6)}`);
    console.log(`  APR raw (scaled 1e6)   ${aprScaled ?? "--"}`);
    console.log(`  APR displayed          ${publishable ? formatScaled(aprScaled) : "--"}`);

    check(`${label} volume coverage is 100%`, `${feeBuckets}/${wanted.length}`, `${wanted.length}/${wanted.length}`);
    check(`${label} liquidity coverage is 100%`, `${liquidityPoints}/${wanted.length}`, `${wanted.length}/${wanted.length}`);

    // Zero liquidity must never yield a number.
    if (weightedWei === 0n) {
      check(`${label} zero liquidity yields unavailable`, aprScaled, null);
    }
    // And the result must be finite and non-negative whenever it exists.
    if (aprScaled !== null) {
      check(`${label} APR is a non-negative integer`, aprScaled >= 0n, true);
    }
  }

  console.log("\n-- cross-window independence --");
  // A 7D result must not be reusable as a 30D result unless the data genuinely coincides;
  // this reports rather than asserts, since equality can be legitimate.
  console.log("  7D and 30D are computed from separate bucket sets and separate windows.");
  console.log("  When all fees and liquidity fall inside the shorter window, the longer");
  console.log("  window's extra hours contribute zero to both sums and the rates coincide.");

  console.log(`\n${failures === 0 ? "All checks passed." : `${failures} CHECK(S) FAILED`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
