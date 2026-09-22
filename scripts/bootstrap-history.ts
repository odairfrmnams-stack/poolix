/*
  Fills the historical volume buckets outside a page render.

    npm run bootstrap:history -- --target=7d
    npm run bootstrap:history -- --target=30d

  A full sweep is tens of minutes of sustained querying, which is far beyond what a page
  render can do, so the work is driven from here instead. Each tick is bounded and
  persists what it completed, so stopping this at any point loses nothing: the next run
  resumes from the buckets already on disk rather than starting the sweep again.

  Run it on its own. Bootstrapping while a verification script is also querying is what
  produced HTTP 429s and made unrelated gates fail.

  The API token is read from the environment and never printed.
*/

import { getHistory, rateLimitCount } from "@/services/analytics/history-window";

const TARGETS = { "7d": { label: "7D", buckets: 168 }, "30d": { label: "30D", buckets: 720 } } as const;
type TargetKey = keyof typeof TARGETS;

/** Gap between ticks. The module backs off on 429 itself; this keeps the pace civil. */
const TICK_PAUSE_MS = 1_500;
/** Ticks with no new bucket before giving up, so a stuck run does not spin forever. */
const STALL_LIMIT = 40;

const arg = (name: string): string | undefined =>
  process.argv.find((value) => value.startsWith(`--${name}=`))?.split("=")[1];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const key = (arg("target") ?? "7d").toLowerCase() as TargetKey;
  const target = TARGETS[key];
  if (target === undefined) throw new Error(`Unknown target "${key}". Use 7d or 30d.`);

  const maxMinutes = Number(arg("minutes") ?? "180");
  const started = Date.now();
  const deadline = started + maxMinutes * 60_000;

  console.log(`Poolix historical bootstrap -> ${target.label} (${target.buckets} hourly buckets)`);
  console.log(`budget: ${maxMinutes} minutes\n`);

  let ticks = 0;
  let stalled = 0;
  let previous = -1;

  while (Date.now() < deadline) {
    const summary = await getHistory();
    ticks++;

    const totals = summary.totals[target.label];
    const present = totals.bucketsPresent;

    if (present === previous) stalled++;
    else stalled = 0;
    previous = present;

    const minutes = (Date.now() - started) / 60_000;
    const rate = minutes > 0 ? present / minutes : 0;
    process.stdout.write(
      `\rtick ${String(ticks).padStart(4)}  ${minutes.toFixed(1).padStart(6)}m  ` +
        `${target.label} ${String(present).padStart(3)}/${target.buckets}  ` +
        `stored ${String(summary.bucketsStored).padStart(3)}  ` +
        `swaps ${summary.swapsProcessed.toLocaleString("en-US").padStart(11)}  ` +
        `429s ${String(rateLimitCount()).padStart(3)}  ` +
        `${rate.toFixed(1)}/min      `,
    );

    if (totals.complete) {
      console.log(`\n\n${target.label} COMPLETE: ${present}/${target.buckets} buckets.`);
      console.log(`swaps processed: ${summary.swapsProcessed.toLocaleString("en-US")}`);
      console.log(`elapsed: ${minutes.toFixed(1)} minutes, ${ticks} ticks, ${rateLimitCount()} rate limits.`);
      console.log("\nRun `npm run verify:historical` now — on its own, not alongside this.");
      return;
    }

    if (stalled >= STALL_LIMIT) {
      console.log(
        `\n\nStalled: ${STALL_LIMIT} ticks with no new bucket at ${present}/${target.buckets}.`,
      );
      console.log("Nothing is lost — rerun to resume from the buckets already persisted.");
      process.exitCode = 1;
      return;
    }

    await sleep(TICK_PAUSE_MS);
  }

  const minutes = (Date.now() - started) / 60_000;
  console.log(`\n\nBudget reached at ${previous}/${target.buckets} after ${minutes.toFixed(1)} minutes.`);
  console.log("Rerun to resume; persisted buckets are kept.");
  process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
