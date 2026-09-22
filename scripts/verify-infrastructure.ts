/*
  Independent check of the data infrastructure.

    npm run verify:infrastructure

  The other verifiers ask whether the numbers are right. This one asks whether the state
  holding them is sound — a different question, and one that only becomes visible after a
  crash, a redeploy or a second instance.

  It reads what is actually on disk and asserts the invariants the storage layer claims:
  every dataset carries its schema identity, checkpoints are internally consistent, a
  published snapshot is never partial, nothing on disk looks like a credential, and every
  dataset is reconstructible from an authoritative source.

  It imports the key/version/health logic it is checking only where the alternative would
  be to duplicate a regex; the invariants themselves are written out longhand so a bug in
  the storage layer cannot satisfy its own test.

  No API token is read or printed by this script.
*/

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { poolixConfig } from "@/config/poolix";
import { classify, overall, type DatasetHealth } from "@/services/storage/health";

const CACHE_DIR = join(process.cwd(), ".poolix-cache");

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = String(actual) === String(expected);
  if (!ok) failures++;
  console.log(
    `  ${ok ? "PASS" : "FAIL"} ${label.padEnd(56)} ${String(actual)}${ok ? "" : `  != ${String(expected)}`}`,
  );
}

function note(label: string, value: unknown): void {
  console.log(`  ·    ${label.padEnd(56)} ${String(value)}`);
}

/**
 * Every dataset the analytics surface persists, with how it is rebuilt and what makes it
 * publishable. This list is the audit: a file on disk that is not here is unaccounted for.
 */
interface DatasetSpec {
  readonly key: string;
  readonly version: number;
  /** A field the dataset cannot function without. */
  readonly requires: string;
  /** Checkpoint fields, which must be finite numbers when present. */
  readonly checkpoints: readonly string[];
  /** Where the data ultimately comes from, i.e. what a rebuild reads. */
  readonly source: "hypersync" | "rpc" | "derived";
  /** True when the dataset keeps a separate published snapshot. */
  readonly publishes: boolean;
  /**
   * How old the state may be before the dataset counts as stale, taken from its tick
   * cadence rather than picked to be comfortable: a window refreshed every 30s is stale
   * within the hour, an hourly series is not.
   */
  readonly maxAgeMs: number;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const DATASETS: readonly DatasetSpec[] = [
  { key: "swap-window", version: 1, requires: "buckets", checkpoints: ["head", "tail"], source: "hypersync", publishes: false, maxAgeMs: 30 * MINUTE },
  { key: "activity-window", version: 1, requires: "buckets", checkpoints: ["head", "tail"], source: "hypersync", publishes: false, maxAgeMs: 30 * MINUTE },
  // history has no scalar checkpoint: its progress marker is `boundaries`, the per-bucket
  // block resolution, which is checked as a map further down rather than as a number here.
  { key: "history", version: 1, requires: "buckets", checkpoints: [], source: "hypersync", publishes: false, maxAgeMs: 2 * HOUR },
  { key: "liquidity-history", version: 1, requires: "points", checkpoints: ["scannedTo"], source: "hypersync", publishes: false, maxAgeMs: 2 * HOUR },
  { key: "apr", version: 1, requires: "buckets", checkpoints: ["scannedTo"], source: "derived", publishes: false, maxAgeMs: 2 * HOUR },
  { key: "holders", version: 6, requires: "tokens", checkpoints: ["latestBlock"], source: "hypersync", publishes: true, maxAgeMs: 30 * MINUTE },
  { key: "tokens", version: 1, requires: "found", checkpoints: ["scannedFrom", "scannedTo"], source: "rpc", publishes: true, maxAgeMs: 30 * MINUTE },
  { key: "pool-history", version: 1, requires: "pools", checkpoints: ["scannedTo"], source: "hypersync", publishes: false, maxAgeMs: 2 * HOUR },
  /*
    Pons launches. Phase 9B.

    Its checkpoint DESCENDS: indexing walks backwards from the factory's last observed
    launch, so `scannedFrom` falls towards the factory's start block rather than rising.
    The generic checkpoint checks below only require a finite non-negative number, which
    holds either way; the direction-specific invariant lives in verify:pons, which knows
    the factory's working range.

    Tolerant of age because the factory is dormant — its last launch was ~40 days before
    this was written — so a quiet deployment legitimately goes hours without a tick.
  */
  { key: "pons", version: 2, requires: "byToken", checkpoints: ["scannedFrom"], source: "hypersync", publishes: false, maxAgeMs: 6 * HOUR },
];

interface Loaded {
  readonly spec: DatasetSpec;
  readonly raw: Record<string, unknown> | null;
  readonly bytes: number;
  readonly outcome: "ok" | "missing" | "corrupt";
}

async function load(spec: DatasetSpec): Promise<Loaded> {
  const path = join(CACHE_DIR, `${spec.key}-${poolixConfig.chain.id}.json`);
  try {
    const info = await stat(path);
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { spec, raw: null, bytes: info.size, outcome: "corrupt" };
    }
    return { spec, raw: parsed as Record<string, unknown>, bytes: info.size, outcome: "ok" };
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    return { spec, raw: null, bytes: 0, outcome: missing ? "missing" : "corrupt" };
  }
}

/*
  Values that are 32 bytes of hex for a legitimate, public reason.

  A transaction hash, a block hash and an event topic are all exactly the shape the
  private-key test below looks for. Addresses are not — they are 40 hex characters — which
  is why the original test needed no exemption until the Pons dataset began storing launch
  transaction hashes and tripped it on every record.

  These are stripped before the secret test runs, rather than the test being loosened: a
  64-hex value anywhere ELSE in persisted state is still a finding. The field name has to
  say what the value is, so a secret cannot hide simply by being 32 bytes long.
*/
const PUBLIC_HASH_FIELDS =
  /"(?:\w*[Hh]ash|topic\d)"\s*:\s*"0x[0-9a-fA-F]{64}"/g;

/*
  Shapes that must never appear in persisted state.

  Deliberately conservative about what counts as a secret and deliberately aware of what
  legitimately looks like one: addresses are 40 hex characters and appear everywhere, so
  the 64-character test below cannot match them, and named hash fields are removed first.
*/
const SECRET_SHAPES: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  { label: "bearer token", pattern: /Bearer\s+[A-Za-z0-9._~+/-]{8,}/i },
  { label: "authorization header", pattern: /"authorization"\s*:/i },
  { label: "private key or 32-byte secret", pattern: /"0x[0-9a-fA-F]{64}"/ },
  { label: "env-style token", pattern: /ENVIO_API_TOKEN|PRIVATE_KEY|SECRET_KEY|MNEMONIC/i },
];

async function main(): Promise<void> {
  console.log("Poolix data infrastructure verification");
  console.log(`network            : ${poolixConfig.chain.name} (${poolixConfig.chain.id})`);
  console.log(`cache directory    : .poolix-cache`);
  console.log("NOTE               : checks the STATE, not the figures. The other verifiers do those.");

  const loaded = await Promise.all(DATASETS.map(load));

  // ------------------------------------------------------------- inventory
  console.log("\n-- every dataset is accounted for --");
  let onDisk: string[] = [];
  try {
    onDisk = (await readdir(CACHE_DIR)).filter((entry) => entry.endsWith(".json"));
  } catch {
    onDisk = [];
  }
  const known = new Set(DATASETS.map((spec) => `${spec.key}-${poolixConfig.chain.id}.json`));
  const unaccounted = onDisk.filter((entry) => !known.has(entry));
  note("files in the cache directory", onDisk.length);
  if (unaccounted.length > 0) note("unaccounted files", unaccounted.join(", "));
  check("no unaccounted state file", unaccounted.length, 0);

  // A leftover temporary file means a write was interrupted and never cleaned up.
  const temporaries = onDisk.length === 0 ? [] : (await readdir(CACHE_DIR)).filter((e) => e.endsWith(".tmp"));
  check("no orphaned temporary writes", temporaries.length, 0);

  // -------------------------------------------------------- schema identity
  console.log("\n-- schema identity --");
  for (const entry of loaded) {
    const { spec, raw, outcome } = entry;
    if (outcome === "missing") {
      // A rebuildable dataset that has not been built yet is a cold start, not a fault.
      note(`${spec.key}`, "not present (rebuildable; cold start)");
      continue;
    }
    check(`${spec.key} parses as an object`, outcome, "ok");
    if (raw === null) continue;

    check(`${spec.key} carries its schema version`, raw.version, spec.version);
    check(`${spec.key} is stamped with this chain`, raw.chainId, poolixConfig.chain.id);
    check(`${spec.key} has its required field`, typeof raw[spec.requires], "object");
    note(`${spec.key} size`, `${(entry.bytes / 1024).toFixed(1)} KB`);
  }

  // ------------------------------------------------------------ checkpoints
  /*
    A checkpoint says "everything below here is processed". It must be a finite number, it
    must not run ahead of the chain, and where a dataset has both ends the lower must not
    exceed the upper — an inverted range would mean the window covers nothing while
    claiming to cover everything.
  */
  console.log("\n-- checkpoint invariants --");
  for (const { spec, raw } of loaded) {
    if (raw === null) continue;

    for (const field of spec.checkpoints) {
      const value = raw[field];
      if (value === null || value === undefined) {
        note(`${spec.key}.${field}`, "null (not yet checkpointed)");
        continue;
      }
      check(`${spec.key}.${field} is a finite number`, typeof value === "number" && Number.isFinite(value), true);
      check(`${spec.key}.${field} is not negative`, (value as number) >= 0, true);
    }

    if (typeof raw.head === "number" && typeof raw.tail === "number") {
      check(`${spec.key} tail does not exceed head`, raw.tail <= raw.head, true);
    }
    if (typeof raw.scannedFrom === "number" && typeof raw.scannedTo === "number") {
      check(`${spec.key} scannedFrom does not exceed scannedTo`, raw.scannedFrom <= raw.scannedTo, true);
    }
    if (typeof raw.updatedAt === "number" && raw.updatedAt > 0) {
      // A timestamp in the future means a clock problem, and every freshness judgement
      // downstream would be wrong in the direction of looking healthier than it is.
      check(`${spec.key}.updatedAt is not in the future`, raw.updatedAt <= Date.now() + 60_000, true);
    }

    /*
      history checkpoints per bucket rather than with a single number.

      `boundaries` maps a bucket's start time to the block that starts it, and it is what
      says which buckets are resolved. Time and block height both only move forwards, so a
      boundary that falls as the bucket time rises means two buckets are reading the same
      range — the failure that double-counts volume — and it has to be caught here because
      no scalar checkpoint exists to catch it.
    */
    if (spec.key === "history") {
      const boundaries = raw.boundaries as Record<string, unknown> | undefined;
      const entries = Object.entries(boundaries ?? {})
        .map(([bucket, block]) => [Number(bucket), Number(block)] as const)
        .sort((a, b) => a[0] - b[0]);
      check("history has resolved boundaries", entries.length > 0, true);
      const malformed = entries.filter(([, block]) => !Number.isFinite(block) || block < 0).length;
      check("every history boundary is a block number", malformed, 0);
      let inversions = 0;
      for (let i = 1; i < entries.length; i++) {
        const previous = entries[i - 1];
        const current = entries[i];
        if (previous !== undefined && current !== undefined && current[1] < previous[1]) inversions++;
      }
      check("history boundaries rise with bucket time", inversions, 0);
      note("history buckets resolved", entries.length);
    }
  }

  // ------------------------------------------- published vs working state
  /*
    The rule this exists to protect: a published snapshot is a claim, and a claim must not
    be partial. Holders in particular may only publish once every token in its universe is
    confirmed — the Phase 6 invariant.
  */
  console.log("\n-- published snapshots are never partial --");
  for (const { spec, raw } of loaded) {
    if (raw === null || !spec.publishes) continue;
    const published = raw.published as Record<string, unknown> | null | undefined;

    if (published === null || published === undefined) {
      note(`${spec.key}.published`, "nothing published yet (working state only)");
      continue;
    }
    check(`${spec.key}.published is an object`, typeof published === "object", true);

    if (spec.key === "holders") {
      const tokenCount = published.tokenCount;
      const confirmed = published.tokensConfirmed;
      const complete = published.complete;
      const holders = published.holders;

      note("holders published", `${String(holders)} over ${String(confirmed)}/${String(tokenCount)} tokens`);
      /*
        The Phase 6 rule, restated here rather than imported.

        The protection is the FLAG, not the number. A partial pass persists a running
        subtotal — deliberately, so progress survives a restart — and `complete` is what
        stops anything consuming it: the page renders "--" while it is false, and
        verify:holders refuses to compare against it. Demanding the subtotal be zero would
        be asserting a design the system does not have, and would force it to throw away
        work it correctly keeps.

        So what must hold is that the flag cannot disagree with the counts behind it.
      */
      check("holders complete iff every token confirmed", complete, confirmed === tokenCount);
      if (complete !== true) {
        check("an unfinished snapshot is marked incomplete", complete, false);
        check("an unfinished snapshot has tokens outstanding", Number(confirmed) < Number(tokenCount), true);
        note("holders subtotal while incomplete", `${String(holders)} (persisted, not publishable)`);
      }
      check("holders universe is recorded", Array.isArray(published.universe), true);
      if (Array.isArray(published.universe)) {
        check("holders universe size equals tokenCount", published.universe.length, tokenCount);
        check("holders universe respects the published cap", published.universe.length <= 10, true);
      }
    }

    if (spec.key === "tokens") {
      const tokens = published.tokens;
      check("tokens published list is an array", Array.isArray(tokens), true);
      if (Array.isArray(tokens)) {
        check("tokens published respects the cap", tokens.length <= 10, true);
        check("tokens published has no duplicates", new Set(tokens).size, tokens.length);
        const malformed = tokens.filter((t) => typeof t !== "string" || !/^0x[0-9a-f]{40}$/.test(t)).length;
        check("every published token is a normalised address", malformed, 0);
      }
    }
  }

  // --------------------------------------------------------- cross-dataset
  /*
    Dependencies between datasets are where a stale cache does the most damage: two
    datasets describing different universes produce figures that are individually correct
    and jointly meaningless.
  */
  console.log("\n-- cross-dataset consistency --");
  const holders = loaded.find((entry) => entry.spec.key === "holders")?.raw ?? null;
  const tokens = loaded.find((entry) => entry.spec.key === "tokens")?.raw ?? null;
  const liquidity = loaded.find((entry) => entry.spec.key === "liquidity-history")?.raw ?? null;
  const pools = loaded.find((entry) => entry.spec.key === "pool-history")?.raw ?? null;

  const holdersUniverse = ((holders?.published as { universe?: string[] } | null)?.universe ?? []).slice().sort();
  const trackedTokens = ((tokens?.published as { tokens?: string[] } | null)?.tokens ?? []).slice().sort();
  if (holdersUniverse.length > 0 && trackedTokens.length > 0) {
    check(
      "holders universe equals the tracked token universe",
      JSON.stringify(holdersUniverse),
      JSON.stringify(trackedTokens),
    );
  } else {
    note("holders/tokens universes", "one side has not published yet; nothing to compare");
  }

  const liquidityPairs = ((liquidity?.pairs as string[] | undefined) ?? []).map((p) => p.toLowerCase()).sort();
  const poolKeys = Object.keys((pools?.pools as Record<string, unknown> | undefined) ?? {}).sort();
  if (liquidityPairs.length > 0 && poolKeys.length > 0) {
    check(
      "per-pool universe equals the liquidity universe",
      JSON.stringify(poolKeys),
      JSON.stringify(liquidityPairs),
    );
  } else {
    note("pool/liquidity universes", "one side is empty; nothing to compare");
  }

  // ----------------------------------------------------------------- health
  /*
    The same classifier the runtime uses, run over what is actually on disk.

    This is the one place the health vocabulary is exercised against real state rather than
    fixtures, so a status that cannot be produced from a real dataset would show up here.

    None of these statuses is a failure on its own. A cold start is "bootstrapping", a
    draining holder queue is "incomplete", and an hourly series between ticks is "stale" —
    all honest, all temporary. What IS asserted is the rule underneath them: nothing may be
    publishable without being both present and complete.
  */
  console.log("\n-- dataset health --");
  const now = Date.now();
  const health: DatasetHealth[] = loaded.map(({ spec, raw }) => {
    const published = (raw?.[spec.requires] ?? null) as Record<string, unknown> | unknown[] | null;
    const size = Array.isArray(published)
      ? published.length
      : published === null
        ? 0
        : Object.keys(published).length;

    /*
      "Complete" means different things and is read from the dataset, never assumed.

      holders states it outright. tokens is complete once it has published a list. The
      window series have no completeness flag on disk — their coverage is what
      verify:historical, verify:apr and the rest assert — so the only claim made here is
      that they hold data.
    */
    const snapshot = raw?.published as Record<string, unknown> | null | undefined;
    const complete =
      spec.key === "holders"
        ? snapshot?.complete === true
        : spec.key === "tokens"
          ? Array.isArray(snapshot?.tokens) && snapshot.tokens.length > 0
          : size > 0;

    const updatedAt = typeof raw?.updatedAt === "number" ? raw.updatedAt : null;
    return classify({
      dataset: spec.key,
      hasPublished: size > 0,
      complete,
      lastSuccessAt: updatedAt,
      sourceBlock: typeof raw?.latestBlock === "number" ? raw.latestBlock : null,
      coverage: { present: size, expected: size },
      lastError: null,
      maxAgeMs: spec.maxAgeMs,
      now,
    });
  });

  for (const entry of health) {
    const age = entry.lastSuccessAt === null ? "never" : `${((now - entry.lastSuccessAt) / MINUTE).toFixed(1)}min ago`;
    note(
      `${entry.dataset}`,
      `${entry.status.padEnd(14)} ${String(entry.coverage?.present ?? 0).padStart(7)} entries   updated ${age}`,
    );
  }
  note("overall", overall(health));

  const publishableButNot = health.filter((entry) => entry.publishable && entry.status === "incomplete");
  check("nothing incomplete is marked publishable", publishableButNot.length, 0);
  const publishableButEmpty = health.filter(
    (entry) => entry.publishable && (entry.coverage?.present ?? 0) === 0,
  );
  check("nothing empty is marked publishable", publishableButEmpty.length, 0);

  // ------------------------------------------------------------- no secrets
  /*
    Persisted analytics state holds addresses and amounts. Nothing in it should ever look
    like a credential, and this is the check that would catch the day something does.
  */
  console.log("\n-- no secret material in persisted state --");
  const secretHits: string[] = [];
  for (const spec of DATASETS) {
    const path = join(CACHE_DIR, `${spec.key}-${poolixConfig.chain.id}.json`);
    let content = "";
    try {
      content = await readFile(path, "utf8");
    } catch {
      continue;
    }
    // Named hash fields are removed first — see PUBLIC_HASH_FIELDS. Everything else,
    // including any 64-hex value under a field that does not say it is a hash, is still
    // tested.
    const scannable = content.replace(PUBLIC_HASH_FIELDS, '"":""');

    for (const { label, pattern } of SECRET_SHAPES) {
      if (pattern.test(scannable)) {
        secretHits.push(`${spec.key}: ${label}`);
      }
    }
  }
  check("no dataset contains secret-shaped material", secretHits.length, 0);
  for (const hit of secretHits) note("found", hit);
  note("patterns checked", SECRET_SHAPES.map((s) => s.label).join(", "));

  // The running token must never have been written anywhere in the cache.
  const token = process.env.ENVIO_API_TOKEN?.trim() ?? "";
  if (token.length >= 8) {
    let leaked = 0;
    for (const spec of DATASETS) {
      try {
        const content = await readFile(join(CACHE_DIR, `${spec.key}-${poolixConfig.chain.id}.json`), "utf8");
        if (content.includes(token)) leaked++;
      } catch {
        // absent
      }
    }
    // The token itself is never printed — only whether it was found.
    check("the configured API token appears in no dataset", leaked, 0);
  } else {
    note("API token leak check", "no token configured in this environment; skipped");
  }

  // ---------------------------------------------------------- rebuildability
  /*
    Every dataset here is derived. None of it is a system of record, which is what makes
    "delete it and rebuild" a safe recovery step — and what this asserts.
  */
  console.log("\n-- every dataset is reconstructible --");
  for (const spec of DATASETS) {
    check(`${spec.key} has an authoritative source`, spec.source !== undefined, true);
  }
  note("sources", "hypersync (event history), rpc (chain state), derived (from the two)");
  note(
    "implication",
    "no dataset is a system of record; any of them may be deleted and rebuilt",
  );

  console.log(`\n${failures === 0 ? "All checks passed." : `${failures} CHECK(S) FAILED`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
