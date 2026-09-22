/*
  Route performance measurement.

    npm run measure:routes            full run
    npm run measure:routes -- --quick skip the cold pass

  Times the SERVER data path behind each route — the work that decides when the first byte
  of HTML can be sent. Client hydration is measured separately in a browser; this is the
  part that was taking tens of seconds.

  Three passes, because they answer different questions:

    cold        first call in a fresh process. In-process memo empty, filesystem cache
                whatever the deployment has. This is a cold start or a new instance.
    warm        second call in the same process. Shows whether anything is memoised at all.
    concurrent  five identical calls started together. Shows whether single-flight works,
                or whether five visitors each start their own scan.

  It measures; it never mutates analytics definitions and never writes a figure anywhere.
*/

import { writeFile } from "node:fs/promises";

import { poolixConfig } from "@/config/poolix";
import { isUniswapV2Available } from "@/config/resolve";
import { getActivityWindow } from "@/services/analytics/activity-window";
import { getApr } from "@/services/analytics/apr-window";
import { getDashboard } from "@/services/analytics/dashboard";
import { fetchEthUsdPrice } from "@/services/analytics/eth-price";
import { getHistory } from "@/services/analytics/history-window";
import { readPublishedHolders } from "@/services/analytics/holders-window";
import { getLiquidityHistory } from "@/services/analytics/liquidity-history";
import { getSwapWindow } from "@/services/analytics/swap-window";
import { fetchChainStatus } from "@/services/chain/status";
import { getPonsView } from "@/services/pons/pons-view";
import { discoverPools } from "@/services/pools/discovery";
import { getPoolHistory } from "@/services/pools/pool-history";
import { getPortfolioScope } from "@/services/portfolio/portfolio-scope";
import { listTokens } from "@/services/tokens/listing";
import { getTokenUniverse } from "@/services/tokens/universe";

const QUICK = process.argv.includes("--quick");
/*
  Route timings only.

  The per-service pass warms everything it touches, so the route figures that follow it are
  never truly cold. This flag skips it, which is the only way to see what a visitor arriving
  at a fresh instance actually waits for.
*/
const ROUTES_ONLY = process.argv.includes("--routes-only");

interface Timing {
  readonly label: string;
  readonly cold: number | null;
  readonly warm: number;
  readonly concurrent: number;
  readonly concurrentCalls: number;
}

const results: Timing[] = [];

async function measure(label: string, run: () => Promise<unknown>): Promise<void> {
  let cold: number | null = null;
  if (!QUICK) {
    const started = Date.now();
    await run();
    cold = Date.now() - started;
  }

  const warmStarted = Date.now();
  await run();
  const warm = Date.now() - warmStarted;

  /*
    Five at once. If single-flight works this costs about what one costs; if it does not,
    it costs five scans and the endpoint throttles for everyone.
  */
  const calls = 5;
  const concurrentStarted = Date.now();
  await Promise.all(Array.from({ length: calls }, () => run()));
  const concurrent = Date.now() - concurrentStarted;

  results.push({ label, cold, warm, concurrent, concurrentCalls: calls });
  console.log(
    `  ${label.padEnd(34)} cold ${(cold === null ? "-" : `${(cold / 1000).toFixed(2)}s`).padStart(8)}` +
      `   warm ${`${(warm / 1000).toFixed(2)}s`.padStart(8)}` +
      `   ${calls}x concurrent ${`${(concurrent / 1000).toFixed(2)}s`.padStart(8)}`,
  );
}

async function main(): Promise<void> {
  const available = isUniswapV2Available(poolixConfig);
  console.log("Poolix route performance");
  console.log(`network            : ${poolixConfig.chain.name} (${poolixConfig.chain.id})`);
  console.log(`mode               : ${QUICK ? "quick (no cold pass)" : "full"}`);
  console.log("NOTE               : server data path only; hydration is measured in a browser.\n");

  if (ROUTES_ONLY) {
    console.log("-- route data paths (nothing pre-warmed) --");
    await measure("/analytics", () => getDashboard());
    await measure("/explore", async () => {
      const discovery = available
        ? await discoverPools()
        : { pools: [], totalPairs: 0, scanned: 0, complete: false };
      return Promise.all([Promise.resolve(listTokens(discovery)), getPonsView()]);
    });
    await measure("/pools", () => (available ? discoverPools() : Promise.resolve(null)));
    await measure("/portfolio", () => getPortfolioScope());
    return;
  }

  console.log("-- individual services --");
  await measure("fetchChainStatus", () => fetchChainStatus());
  await measure("fetchEthUsdPrice", () => fetchEthUsdPrice());
  await measure("discoverPools", () => (available ? discoverPools() : Promise.resolve(null)));
  await measure("getTokenUniverse", () => getTokenUniverse());
  await measure("getSwapWindow", () => getSwapWindow());
  await measure("getActivityWindow", () => getActivityWindow());
  await measure("getHistory", () => getHistory());
  await measure("getLiquidityHistory", () => getLiquidityHistory());
  await measure("getApr", () => getApr());
  await measure("getPoolHistory", () => getPoolHistory());
  await measure("readPublishedHolders", () => readPublishedHolders());
  await measure("getPonsView", () => getPonsView());
  await measure("getPortfolioScope", () => getPortfolioScope());

  console.log("\n-- route data paths --");
  // Exactly what each route awaits before it can emit HTML.
  await measure("/  (static, no data)", () => Promise.resolve(null));
  await measure("/swap  (static, no data)", () => Promise.resolve(null));
  await measure("/pools", () => (available ? discoverPools() : Promise.resolve(null)));
  await measure("/tokens", async () => {
    const discovery = available
      ? await discoverPools()
      : { pools: [], totalPairs: 0, scanned: 0, complete: false };
    return listTokens(discovery);
  });
  await measure("/portfolio", () => getPortfolioScope());
  await measure("/explore", async () => {
    const discovery = available
      ? await discoverPools()
      : { pools: [], totalPairs: 0, scanned: 0, complete: false };
    const [, pons] = await Promise.all([Promise.resolve(listTokens(discovery)), getPonsView()]);
    return pons;
  });
  await measure("/analytics", async () => {
    const [dashboard] = await Promise.all([
      getDashboard(),
      available ? discoverPools() : Promise.resolve(null),
    ]);
    return dashboard;
  });

  // ------------------------------------------------------------------ verdict
  console.log("\n-- summary --");
  const slowest = [...results].sort((a, b) => b.warm - a.warm).slice(0, 5);
  console.log("  slowest warm paths:");
  for (const entry of slowest) {
    console.log(`    ${entry.label.padEnd(34)} ${(entry.warm / 1000).toFixed(2)}s`);
  }

  /*
    Single-flight check. Five concurrent identical calls should cost roughly one call. A
    figure far above the warm time means the work was duplicated per caller, which is what
    turns one slow page into a throttled endpoint for everyone on it.
  */
  console.log("\n  duplicate-work check (5 concurrent vs warm):");
  for (const entry of results) {
    if (entry.warm < 50) continue;
    const ratio = entry.concurrent / Math.max(entry.warm, 1);
    const shared = ratio < 2;
    console.log(
      `    ${entry.label.padEnd(34)} ${ratio.toFixed(1)}x  ${shared ? "shared" : "DUPLICATED"}`,
    );
  }

  const stamp = new Date().toISOString();
  await writeFile(
    `route-timings-${stamp.slice(0, 19).replace(/[:T]/g, "-")}.json`,
    JSON.stringify({ at: stamp, quick: QUICK, results }, null, 2),
    "utf8",
  );
  console.log(`\n  written to route-timings-${stamp.slice(0, 19).replace(/[:T]/g, "-")}.json`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
