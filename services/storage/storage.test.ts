import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { classify, overall, type DatasetHealth } from "@/services/storage/health";
import { assertKey, datasetKey, InvalidKeyError, isValidKey, redact } from "@/services/storage/keys";
import { canAcquire, evaluate, grant, isExpired, isLease, renew, type Lease } from "@/services/storage/lease";
import { formatLog } from "@/services/storage/log";
import { interpret, needsRebuild, stamp, type VersionedSpec } from "@/services/storage/versioned";

// ------------------------------------------------------------------ keys

describe("storage keys", () => {
  it("accepts the dataset keys this codebase uses", () => {
    for (const key of ["holders-4663", "swap-window-4663", "pool-history-4663", "tokens-4663"]) {
      assert.equal(isValidKey(key), true, key);
    }
  });

  it("rejects anything that could escape the cache directory", () => {
    for (const key of [
      "../secrets",
      "..",
      "a/b",
      "a\\b",
      "/etc/passwd",
      "C:\\windows",
      "holders\0.4663",
      "",
    ]) {
      assert.equal(isValidKey(key), false, JSON.stringify(key));
    }
  });

  it("rejects separators at the edges and doubled up", () => {
    for (const key of ["-holders", "holders-", ".holders", "holders..4663"]) {
      assert.equal(isValidKey(key), false, key);
    }
  });

  it("rejects an over-long key", () => {
    assert.equal(isValidKey("a".repeat(129)), false);
  });

  it("throws rather than sanitising", () => {
    // Silently rewriting a bad key would hide the bug that produced it.
    assert.throws(() => assertKey("../escape"), InvalidKeyError);
  });

  it("builds a per-chain dataset key", () => {
    assert.equal(datasetKey("holders", 4663), "holders-4663");
  });

  it("refuses a nonsense chain id", () => {
    assert.throws(() => datasetKey("holders", -1), InvalidKeyError);
    assert.throws(() => datasetKey("holders", 1.5), InvalidKeyError);
  });
});

// -------------------------------------------------------------- redaction

describe("secret redaction", () => {
  it("removes a bearer token", () => {
    const out = redact("Authorization: Bearer abc123def456ghi789", {});
    assert.equal(out.includes("abc123def456ghi789"), false);
    assert.match(out, /redacted bearer/);
  });

  it("removes a 32-byte hex value, which is what a private key looks like", () => {
    const key = `0x${"a".repeat(64)}`;
    const out = redact(`key=${key}`, {});
    assert.equal(out.includes(key), false);
  });

  it("removes the value of any secret-looking environment variable", () => {
    const env = { ENVIO_API_TOKEN: "s3cr3t-value-not-a-uuid" };
    const out = redact("failed with token s3cr3t-value-not-a-uuid", env);
    assert.equal(out.includes("s3cr3t-value-not-a-uuid"), false);
    assert.match(out, /redacted ENVIO_API_TOKEN/);
  });

  it("removes every occurrence, not just the first", () => {
    const env = { API_KEY: "abcdefghij" };
    const out = redact("abcdefghij and abcdefghij", env);
    assert.equal(out.includes("abcdefghij"), false);
  });

  it("leaves ordinary values alone", () => {
    assert.equal(redact("blocks=1234 dataset=holders", {}), "blocks=1234 dataset=holders");
  });

  it("does not redact a short env value, which would scrub common words", () => {
    const env = { MY_KEY: "dev" };
    assert.equal(redact("running in dev mode", env), "running in dev mode");
  });
});

describe("worker logs never carry secrets", () => {
  it("redacts a token that reached an error message", () => {
    const line = formatLog("error", {
      dataset: "holders",
      error: "401 from https://x/y with Bearer supersecrettoken123",
    });
    assert.equal(line.includes("supersecrettoken123"), false);
  });

  it("keeps the fields an incident needs", () => {
    const line = formatLog("info", {
      dataset: "swap-window",
      reason: "tick",
      fromBlock: 100,
      toBlock: 200,
      received: 50,
      accepted: 48,
      discarded: 2,
      checkpointIn: 100,
      checkpointOut: 200,
      durationMs: 1234,
      published: true,
    });
    for (const field of [
      "dataset=swap-window",
      "fromBlock=100",
      "toBlock=200",
      "received=50",
      "accepted=48",
      "discarded=2",
      "checkpointIn=100",
      "checkpointOut=200",
      "published=true",
    ]) {
      assert.ok(line.includes(field), `missing ${field} in: ${line}`);
    }
  });

  it("omits undefined fields rather than printing them", () => {
    assert.equal(formatLog("info", { dataset: "x", reason: undefined }).includes("reason"), false);
  });
});

// ------------------------------------------------------------- versioning

interface Sample {
  version: number;
  chainId: number;
  value: number;
}

const spec: VersionedSpec<Sample> = {
  dataset: "sample",
  version: 2,
  chainId: 4663,
  validate: (value): value is Sample =>
    typeof value === "object" &&
    value !== null &&
    typeof (value as Sample).value === "number",
};

// ------------------------------------------------- Phase 8: redaction safety

describe("redaction terminates", () => {
  it("returns when a secret is a substring of its own replacement label", () => {
    /*
      The bug this pins down. The original implementation was

        while (output.includes(value)) output = output.replace(value, `[redacted ${name}]`)

      which never terminates when the value appears inside the label it is replaced with:
      SECRET_KEY_VALUE_THING holding "KEY_VALUE" produces "[redacted SECRET_KEY_VALUE_THING]",
      which still contains "KEY_VALUE". That is an infinite loop on the logging path,
      reached by every worker warning — a hung request and a pinned CPU.

      If this test ever hangs rather than fails, the loop is back.
    */
    const env = { SECRET_KEY_VALUE_THING: "KEY_VALUE" };
    const output = redact("leaked KEY_VALUE here", env);

    assert.ok(!output.includes("KEY_VALUE here".slice(0, 9)) || output.includes("[redacted"));
    assert.ok(output.includes("[redacted SECRET_KEY_VALUE_THING]"));
  });

  it("replaces every occurrence, not just the first", () => {
    const env = { API_TOKEN: "abcdefgh12345678" };
    const output = redact("abcdefgh12345678 and abcdefgh12345678", env);
    assert.ok(!output.includes("abcdefgh12345678"));
    assert.equal(output.split("[redacted API_TOKEN]").length - 1, 2);
  });

  it("handles a secret containing regex metacharacters literally", () => {
    const env = { MY_SECRET: "a+b*c(d)[e]" };
    const output = redact("value=a+b*c(d)[e] end", env);
    assert.ok(!output.includes("a+b*c(d)[e]"));
  });
});

// ------------------------------------------------ Phase 8: filesystem paths

describe("storage keys cannot escape the cache directory", () => {
  const traversals = [
    "../secrets",
    "../../etc/passwd",
    "..\\..\\windows\\system32",
    "/etc/passwd",
    "C:\\Windows\\System32",
    "holders/../../escape",
    "holders\u0000.json",
    ".",
    "..",
    "./holders",
    "holders/",
    "%2e%2e%2fholders",
    "\\\\server\\share",
  ];

  for (const attempt of traversals) {
    it(`rejects ${JSON.stringify(attempt)}`, () => {
      assert.equal(isValidKey(attempt), false);
      assert.throws(() => assertKey(attempt), InvalidKeyError);
    });
  }

  it("still accepts every real dataset key", () => {
    for (const dataset of [
      "swap-window",
      "activity-window",
      "history",
      "liquidity-history",
      "apr",
      "holders",
      "tokens",
      "pool-history",
    ]) {
      assert.equal(isValidKey(datasetKey(dataset, 4663)), true);
    }
  });

  it("refuses a chain id that is not a safe non-negative integer", () => {
    assert.throws(() => datasetKey("holders", -1), InvalidKeyError);
    assert.throws(() => datasetKey("holders", 1.5), InvalidKeyError);
    assert.throws(() => datasetKey("holders", Number.NaN), InvalidKeyError);
    assert.throws(() => datasetKey("holders", Number.MAX_VALUE), InvalidKeyError);
  });
});

describe("schema versioning", () => {
  const current: Sample = { version: 2, chainId: 4663, value: 42 };

  it("accepts state at the current version", () => {
    const result = interpret(current, spec);
    assert.equal(result.outcome, "ok");
    assert.equal(result.value?.value, 42);
  });

  it("reports absent state as missing, not as corrupt", () => {
    // A cold start is not a fault, and conflating the two makes first runs look broken.
    assert.equal(interpret(null, spec).outcome, "missing");
    assert.equal(interpret(undefined, spec).outcome, "missing");
  });

  it("discards an older version rather than reinterpreting it", () => {
    const result = interpret({ version: 1, chainId: 4663, value: 42 }, spec);
    assert.equal(result.outcome, "version-mismatch");
    assert.equal(result.value, null);
  });

  it("discards a NEWER version, which this build cannot understand", () => {
    const result = interpret({ version: 99, chainId: 4663, value: 42 }, spec);
    assert.equal(result.outcome, "version-mismatch");
    assert.equal(result.value, null);
    assert.match(result.detail, /newer/);
  });

  it("never migrates a newer version downwards", () => {
    const withMigration: VersionedSpec<Sample> = {
      ...spec,
      migrate: () => ({ version: 2, chainId: 4663, value: 0 }),
    };
    assert.equal(interpret({ version: 99, chainId: 4663, value: 1 }, withMigration).outcome, "version-mismatch");
  });

  it("migrates an older version when a deterministic migration exists", () => {
    const withMigration: VersionedSpec<Sample> = {
      ...spec,
      migrate: (raw, from) =>
        from === 1 ? { version: 2, chainId: 4663, value: (raw as Sample).value * 2 } : null,
    };
    const result = interpret({ version: 1, chainId: 4663, value: 21 }, withMigration);
    assert.equal(result.outcome, "ok");
    assert.equal(result.value?.value, 42);
  });

  it("discards when a migration cannot faithfully upgrade", () => {
    const withMigration: VersionedSpec<Sample> = { ...spec, migrate: () => null };
    assert.equal(interpret({ version: 1, chainId: 4663, value: 1 }, withMigration).outcome, "version-mismatch");
  });

  it("discards a migration result that fails validation", () => {
    const withMigration: VersionedSpec<Sample> = {
      ...spec,
      migrate: () => ({ version: 2, chainId: 4663 } as unknown as Sample),
    };
    assert.equal(interpret({ version: 1, chainId: 4663, value: 1 }, withMigration).outcome, "invalid");
  });

  it("rejects state from another chain", () => {
    assert.equal(interpret({ version: 2, chainId: 1, value: 42 }, spec).outcome, "chain-mismatch");
  });

  it("treats a non-object as corrupt", () => {
    for (const raw of ["a string", 42, true, [1, 2, 3]]) {
      assert.equal(interpret(raw, spec).outcome, "corrupt", JSON.stringify(raw));
    }
  });

  it("treats a missing or non-numeric version as corrupt", () => {
    assert.equal(interpret({ chainId: 4663, value: 1 }, spec).outcome, "corrupt");
    assert.equal(interpret({ version: "2", chainId: 4663, value: 1 }, spec).outcome, "corrupt");
  });

  it("rejects state missing a field the dataset requires", () => {
    assert.equal(interpret({ version: 2, chainId: 4663 }, spec).outcome, "invalid");
  });

  it("says a rebuild is needed for every outcome except ok", () => {
    for (const outcome of ["missing", "corrupt", "version-mismatch", "chain-mismatch", "invalid"] as const) {
      assert.equal(needsRebuild(outcome), true, outcome);
    }
    assert.equal(needsRebuild("ok"), false);
  });

  it("stamps identity on write so the next reader can judge it", () => {
    const stamped = stamp({ value: 7 }, { version: 2, chainId: 4663 });
    assert.deepEqual(stamped, { value: 7, version: 2, chainId: 4663 });
  });

  it("round-trips a stamped value", () => {
    const written = stamp({ value: 7 }, { version: 2, chainId: 4663 });
    const read = interpret(JSON.parse(JSON.stringify(written)), spec);
    assert.equal(read.outcome, "ok");
    assert.equal(read.value?.value, 7);
  });
});

// ------------------------------------------------------------------ leases

describe("leases", () => {
  const NOW = 1_700_000_000_000;
  const held: Lease = { dataset: "holders", owner: "worker-a", acquiredAt: NOW, expiresAt: NOW + 60_000 };

  it("takes a lease nobody holds", () => {
    assert.equal(evaluate(null, "worker-a", NOW), "free");
    assert.equal(canAcquire("free"), true);
  });

  it("stands down when another holder's lease is valid", () => {
    assert.equal(evaluate(held, "worker-b", NOW + 1_000), "held");
    assert.equal(canAcquire("held"), false);
  });

  it("reclaims an expired lease, so a crash cannot block work forever", () => {
    assert.equal(evaluate(held, "worker-b", NOW + 60_001), "expired");
    assert.equal(canAcquire("expired"), true);
  });

  it("recognises its own lease instead of contending with itself", () => {
    assert.equal(evaluate(held, "worker-a", NOW + 1_000), "own");
    assert.equal(canAcquire("own"), true);
  });

  it("expires exactly at the boundary", () => {
    assert.equal(isExpired(held, NOW + 59_999), false);
    assert.equal(isExpired(held, NOW + 60_000), true);
  });

  it("grants a lease that expires in the future", () => {
    const lease = grant("holders", "worker-a", NOW, 30_000);
    assert.equal(lease.expiresAt, NOW + 30_000);
    assert.equal(lease.owner, "worker-a");
  });

  it("renews a lease the caller still holds", () => {
    const renewed = renew(held, "worker-a", NOW + 30_000, 60_000);
    assert.equal(renewed?.expiresAt, NOW + 90_000);
  });

  it("refuses to renew a lease that now belongs to someone else", () => {
    // Renewing here would let two workers both believe they hold it.
    assert.equal(renew(held, "worker-b", NOW + 30_000), null);
  });

  it("validates a lease read back from storage", () => {
    assert.equal(isLease(held), true);
    assert.equal(isLease({ owner: "a" }), false);
    assert.equal(isLease(null), false);
    assert.equal(isLease({ ...held, expiresAt: "soon" }), false);
  });
});

// ------------------------------------------------------------------ health

describe("dataset health", () => {
  const base = { dataset: "holders", maxAgeMs: 600_000, now: 1_000_000, lastSuccessAt: 1_000_000 };

  it("is healthy when published, complete and recent", () => {
    const health = classify({ ...base, hasPublished: true, complete: true });
    assert.equal(health.status, "healthy");
    assert.equal(health.publishable, true);
  });

  it("is bootstrapping before anything has been published", () => {
    const health = classify({ ...base, hasPublished: false, complete: false, lastSuccessAt: null });
    assert.equal(health.status, "bootstrapping");
    assert.equal(health.publishable, false);
  });

  it("is incomplete when running but short of the publication bar", () => {
    const health = classify({ ...base, hasPublished: true, complete: false });
    assert.equal(health.status, "incomplete");
    assert.equal(health.publishable, false);
  });

  it("is stale when the last success is older than tolerated, but still publishable", () => {
    // A figure that says it is stale beats no figure.
    const health = classify({ ...base, hasPublished: true, complete: true, lastSuccessAt: 1 });
    assert.equal(health.status, "stale");
    assert.equal(health.publishable, true);
  });

  it("reports a failure even when a usable snapshot remains", () => {
    const health = classify({ ...base, hasPublished: true, complete: true, lastError: "timeout" });
    assert.equal(health.status, "failed");
    assert.equal(health.publishable, true);
  });

  it("carries coverage and retry state through", () => {
    const health = classify({
      ...base,
      hasPublished: true,
      complete: false,
      coverage: { present: 167, expected: 168 },
      retries: 2,
    });
    assert.deepEqual(health.coverage, { present: 167, expected: 168 });
    assert.equal(health.retries, 2);
  });

  it("reports the worst status across datasets, never an average", () => {
    const make = (status: DatasetHealth["status"]): DatasetHealth => ({
      dataset: status,
      status,
      lastSuccessAt: null,
      sourceBlock: null,
      coverage: null,
      lastError: null,
      retries: 0,
      publishable: false,
    });
    assert.equal(overall([make("healthy"), make("failed")]), "failed");
    assert.equal(overall([make("healthy"), make("stale")]), "stale");
    assert.equal(overall([make("healthy"), make("healthy")]), "healthy");
    assert.equal(overall([]), "bootstrapping");
  });
});
