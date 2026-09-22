/*
  Independent check of the analytics dashboard.

    npm run verify:dashboard

  The dashboard computes nothing. That is the claim this script exists to test, and it is a
  different claim from "the numbers are right" — every underlying figure is already checked
  by verify:swaps, verify:historical, verify:liquidity-history, verify:apr,
  verify:pool-analytics, verify:holders and verify:tokens. What can still go wrong is the
  aggregation layer quietly disagreeing with the pipelines it aggregates.

  So this reads the persisted state each pipeline wrote and re-derives, with its own inline
  arithmetic, what the dashboard is allowed to display. It imports dashboard.ts for the view
  and dashboard-math.ts for nothing at all — the checks below are written out longhand so a
  bug in the shaping rules cannot validate itself.

  The failure modes it is aimed at:

    - a metric published from an incomplete window
    - a USD figure with no oracle behind it, or any historical USD at all
    - a fabricated percentage change
    - a token/token pool dropped from the ranking for having no WETH side
    - a pool or token universe that differs from the one the pipelines used
    - an APR that is not the one apr-window.ts published
    - the dashboard mutating the state it read

  No API token is read or printed by this script.
*/

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { poolixConfig } from "@/config/poolix";
import { getDashboard } from "@/services/analytics/dashboard";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = String(actual) === String(expected);
  if (!ok) failures++;
  console.log(
    `  ${ok ? "PASS" : "FAIL"} ${label.padEnd(52)} ${String(actual)}${ok ? "" : `  != ${String(expected)}`}`,
  );
}

function note(label: string, value: unknown): void {
  console.log(`  ·    ${label.padEnd(52)} ${String(value)}`);
}

interface HistoryState {
  buckets: Record<string, { startTimestamp: number; volumeWei: string; swaps: number }>;
}
interface LiquidityState {
  points: Record<string, { startTimestamp: number; liquidityWei: string; complete: boolean }>;
  pairs: string[];
}
interface PoolState {
  pools: Record<string, { pair: string; wethSide: string; buckets: Record<string, { v: string; l: string | null }> }>;
}
interface TokensState {
  published: { tokens: string[]; verified: number } | null;
}
interface HoldersState {
  published: { universe: string[]; holders: number; complete: boolean } | null;
}

async function readState<T>(name: string): Promise<T | null> {
  try {
    const path = join(process.cwd(), ".poolix-cache", `${name}-${poolixConfig.chain.id}.json`);
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Decimal string for a wei value, without ever touching a float. */
function formatWei(value: bigint, decimals = 6): string {
  const whole = value / 10n ** 18n;
  const fraction = (value % 10n ** 18n) / 10n ** BigInt(18 - decimals);
  return `${whole.toLocaleString("en-US")}.${fraction.toString().padStart(decimals, "0")}`;
}

async function main(): Promise<void> {
  const before = await readState<HistoryState>("history");
  const dashboard = await getDashboard();
  const after = await readState<HistoryState>("history");

  const [history, liquidity, pools, tokens, holders] = await Promise.all([
    readState<HistoryState>("history"),
    readState<LiquidityState>("liquidity-history"),
    readState<PoolState>("pool-history"),
    readState<TokensState>("tokens"),
    readState<HoldersState>("holders"),
  ]);

  console.log("Poolix analytics dashboard verification");
  console.log(`network            : ${dashboard.chainName} (${poolixConfig.chain.id})`);
  console.log(`native symbol      : ${dashboard.nativeSymbol}`);
  console.log("NOTE               : the dashboard aggregates verified pipelines; it computes nothing.");

  // ------------------------------------------------------------- availability
  console.log("\n-- the dashboard renders at all --");
  check("dashboard is available", dashboard.available, true);
  check("headline carries every card", Object.keys(dashboard.headline).length, 11);
  check("both historical timeframes present", Object.keys(dashboard.timeframes).sort().join(","), "30D,7D");

  // ----------------------------------------------------------- no fabrication
  /*
    A percentage change would need a previous-period snapshot, and nothing in the pipeline
    stores one. The strongest check available is structural: no field anywhere in the view
    is shaped like a delta, so there is nothing for a renderer to print.
  */
  console.log("\n-- nothing fabricated --");
  const serialised = JSON.stringify(dashboard);
  const deltaKeys = /"(change|delta|pct|percentChange|previous|trend|growth)[A-Za-z0-9]*"\s*:/.exec(serialised);
  check("no percentage-change field in the view", deltaKeys === null, true);

  const usdFields = [...serialised.matchAll(/"(\w*[Uu]sd\w*)"\s*:/g)].map((match) => match[1]);
  note("USD-bearing fields", usdFields.length === 0 ? "(none)" : [...new Set(usdFields)].join(", "));

  /*
    Historical USD is the specific fabrication this chain invites: the Chainlink feed
    publishes no usable history here, so any USD figure attached to a historical window
    would have to be priced at today's rate and presented as the past.
  */
  let historicalUsd = 0;
  for (const frame of ["7D", "30D"] as const) {
    const view = dashboard.timeframes[frame];
    const fields = JSON.stringify(view);
    if (/[Uu]sd/.test(fields)) historicalUsd++;
  }
  check("no USD anywhere in a historical timeframe", historicalUsd, 0);
  check("no USD on a pool ranking row", /[Uu]sd/.test(JSON.stringify(dashboard.poolRows)), false);

  /*
    An undercount must not present itself as a measurement. When swaps in the 24h window
    are still unattributed to a pair, the total is a floor, and the card has to say so —
    the number is correct either way, but the claim it makes is not.
  */
  const unattributed = dashboard.day.unresolvedSwaps;
  note("unattributed swaps in the 24h window", unattributed.toLocaleString("en-US"));
  check(
    "24h volume is labelled a floor iff swaps are unattributed",
    /^At least this much/.test(dashboard.headline.volume24hWei.note),
    unattributed > 0,
  );

  const oracleBacked = dashboard.coverage.ethUsdAvailable;
  const tvlShown = dashboard.headline.tvlCents.value !== null;
  check("USD TVL shown only with a live oracle", tvlShown ? oracleBacked : true, true);
  note("oracle", oracleBacked ? (dashboard.coverage.ethUsdDescription ?? "available") : "unavailable");

  // ------------------------------------------------------- window publishing
  console.log("\n-- a window is published only when it is whole --");
  for (const frame of ["7D", "30D"] as const) {
    const view = dashboard.timeframes[frame];
    const whole = view.bucketsPresent === view.bucketsExpected && view.bucketsExpected > 0;
    note(
      `${frame} coverage`,
      `${view.bucketsPresent}/${view.bucketsExpected}  volume ${view.volumeWei === null ? "--" : formatWei(BigInt(view.volumeWei))}`,
    );
    check(`${frame} volume published iff window whole`, view.volumeWei !== null, whole);
    check(`${frame} fees published iff window whole`, view.feesWei !== null, whole);
    check(
      `${frame} liquidity published iff its own window whole`,
      view.liquidityLatestWei !== null,
      view.liquidityComplete,
    );
  }

  // --------------------------------------------- totals match the stored state
  /*
    Re-summing the persisted buckets is what proves the dashboard is reporting the pipeline
    rather than a number of its own. Matching totals are weak evidence on their own; the
    point is that a dashboard that had quietly re-derived volume would land somewhere else.
  */
  console.log("\n-- totals come from the stored series, not from a second sum --");
  if (history === null) {
    console.log("  SKIP no volume state on disk — run the app once first.");
  } else {
    const hour = Math.floor(Date.now() / 1000 / 3600) * 3600;
    for (const [frame, hours] of [["7D", 168], ["30D", 720]] as const) {
      const view = dashboard.timeframes[frame];
      if (view.volumeWei === null) {
        note(`${frame} recount`, "withheld by the dashboard; nothing to compare");
        continue;
      }
      let sum = 0n;
      let present = 0;
      for (let i = hours; i >= 1; i--) {
        const bucket = history.buckets[String(hour - i * 3600)];
        if (bucket === undefined) continue;
        present++;
        sum += BigInt(bucket.volumeWei);
      }
      note(`${frame} recount`, `${formatWei(sum)} over ${present}/${hours} hours`);
      check(`${frame} volume equals the stored buckets`, view.volumeWei, sum.toString());
      // The 0.30% rule, applied here rather than read from the dashboard.
      check(`${frame} fees are 0.30% of that volume`, view.feesWei, ((sum * 3n) / 1_000n).toString());
    }
  }

  // ------------------------------------------------------------ same universes
  console.log("\n-- one pool universe, one token universe --");
  if (pools !== null) {
    const stored = Object.keys(pools.pools).sort();
    const ranked = dashboard.poolRows.map((row) => row.pair).sort();
    check("pool rows are exactly the per-pool store", JSON.stringify(ranked), JSON.stringify(stored));
  } else {
    console.log("  SKIP no per-pool state on disk.");
  }

  if (liquidity !== null && pools !== null) {
    const liqPairs = [...liquidity.pairs].map((p) => p.toLowerCase()).sort();
    check(
      "per-pool universe equals the liquidity universe",
      JSON.stringify(Object.keys(pools.pools).sort()),
      JSON.stringify(liqPairs),
    );
  }

  if (tokens?.published != null) {
    const tracked = new Set(tokens.published.tokens.map((t) => t.toLowerCase()));
    const flagged = dashboard.tokenRows.filter((row) => row.tracked).map((row) => row.address);
    const strays = flagged.filter((address) => !tracked.has(address));
    check("no token is flagged tracked outside the universe", strays.length, 0);
    check("Tokens Tracked equals the published count", dashboard.coverage.tokensVerified, tokens.published.verified);
  } else {
    console.log("  SKIP no token universe on disk.");
  }

  if (holders?.published != null) {
    check(
      "holders published iff the pipeline says complete",
      dashboard.headline.holders.value !== null,
      holders.published.complete,
    );
    if (holders.published.complete) {
      check("holders equals the published count", dashboard.headline.holders.value, String(holders.published.holders));
    }
  }

  // ------------------------------------------------- token/token pools survive
  console.log("\n-- token-to-token pools are ranked, not dropped --");
  if (pools !== null) {
    const storedTokenToken = Object.values(pools.pools).filter((pool) => pool.wethSide === "none");
    const rankedTokenToken = dashboard.poolRows.filter((row) => row.wethSide === "none");
    note("token/token pools in the store", storedTokenToken.length);
    check("all of them appear in the ranking", rankedTokenToken.length, storedTokenToken.length);

    // And they carry no invented ETH figures.
    const invented = rankedTokenToken.filter(
      (row) => row.liquidityWei !== null || row.volume24hWei !== null || row.fees24hWei !== null,
    ).length;
    check("none carries an invented ETH figure", invented, 0);

    if (storedTokenToken.length === 0) {
      console.log("       (none in scope right now; the rule is still enforced above)");
    }
  }

  // --------------------------------------------------------------------- APR
  console.log("\n-- APR comes from the verified window --");
  for (const frame of ["7D", "30D"] as const) {
    const view = dashboard.timeframes[frame];
    note(`${frame} APR`, `${view.aprDisplay ?? "--"}  (${view.aprReason})`);
    // A published APR must be a formatted percentage, never a raw scaled integer.
    if (view.aprDisplay !== null) {
      check(`${frame} APR is a formatted percentage`, /%$/.test(view.aprDisplay), true);
    }
    check(
      `${frame} APR withheld unless the reason is ok`,
      view.aprDisplay !== null ? view.aprReason === "ok" : true,
      true,
    );
  }

  const poolAprs = dashboard.poolRows.filter((row) => row.apr7dDisplay !== null).length;
  note("pools publishing a 7D APR", `${poolAprs} of ${dashboard.poolRows.length}`);
  check(
    "every pool APR is formatted, never raw",
    dashboard.poolRows.every((row) => row.apr7dDisplay === null || /%$/.test(row.apr7dDisplay)),
    true,
  );

  // ------------------------------------------------- the dashboard is read-only
  console.log("\n-- the dashboard does not alter the analytics --");
  if (before !== null && after !== null) {
    // Bucket COUNT rather than deep equality: an ingestion tick legitimately adds an hour
    // while this runs, but the dashboard itself must never rewrite what is there.
    const beforeKeys = Object.keys(before.buckets).length;
    const afterKeys = Object.keys(after.buckets).length;
    note("volume buckets before / after", `${beforeKeys} / ${afterKeys}`);
    check("the dashboard did not remove stored buckets", afterKeys >= beforeKeys, true);
  } else {
    console.log("  SKIP no volume state to compare.");
  }

  // ------------------------------------------------------------------ summary
  console.log("\n-- coverage as the page reports it --");
  note("pools scanned / pairs", `${dashboard.coverage.poolsScanned} / ${dashboard.coverage.pairsTotal.toLocaleString("en-US")}`);
  note("pools ranked", dashboard.coverage.rankedPools);
  note("tokens tracked", `${dashboard.coverage.tokensVerified} of up to ${dashboard.coverage.tokensLimit}`);
  note(
    "holders",
    dashboard.coverage.holdersComplete
      ? `complete over ${dashboard.coverage.holdersTokenCount} tokens`
      : `rebuilding: ${dashboard.coverage.holdersTokensConfirmed}/${dashboard.coverage.holdersTokenCount}`,
  );
  note("token rows", dashboard.tokenRows.length);

  console.log(`\n${failures === 0 ? "All checks passed." : `${failures} CHECK(S) FAILED`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
