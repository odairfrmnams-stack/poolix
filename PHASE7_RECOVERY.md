# Poolix data recovery

What Poolix persists, what must survive, and how to get back to a working system.

The short version: **nothing in `.poolix-cache` is a system of record.** Every dataset is
derived from HyperSync event history and Robinhood Chain state, so any of it can be deleted
and rebuilt. What a rebuild costs is time, not correctness — and while a dataset is
rebuilding, the page shows `--` rather than a partial figure.

> **Local filesystem persistence is development-safe but not multi-instance durable
> production storage.** See [Limitations](#limitations).

---

## 1. What is stored

Eight datasets, all under `.poolix-cache/<dataset>-<chainId>.json`, all written atomically
(temp file + rename) and all stamped with `version` and `chainId`.

| Dataset | Source | Checkpoints | Publishes a snapshot | Rebuild cost |
|---|---|---|---|---|
| `swap-window` | HyperSync | `head`, `tail` | no | ~70s full 24h sweep |
| `activity-window` | HyperSync | `head`, `tail` | no | ~1 min |
| `history` | HyperSync | `boundaries` (per hourly bucket) | no | **hours** (30 days hourly) |
| `liquidity-history` | HyperSync | `scannedTo` | no | minutes |
| `apr` | derived (history + liquidity) | `scannedTo` | no | minutes |
| `holders` | HyperSync + RPC | `latestBlock`, per-token `syncedTo` | **yes** | **~10 min–hours** |
| `tokens` | RPC | `scannedFrom`, `scannedTo` | **yes** | minutes |
| `pool-history` | HyperSync | `scannedTo` | no | minutes |

### Classification

- **Source-derived state** — none. Poolix holds no authoritative data.
- **Derived aggregate** — all eight.
- **Temporary working state** — the in-progress fields of `holders` (`pendingConfirm`,
  per-token replay) and `tokens` (`found`).
- **Rebuildable cache** — all eight, without exception.

### Dependency graph

```
HyperSync (event history)        RPC (chain state, Chainlink ETH/USD)
        |                                 |
        +---- swap-window                 +---- pool discovery
        +---- activity-window             +---- tokens (universe)
        +---- history  ------+            |         |
        +---- liquidity-history           |         v
        |        |          |             |      holders (universe passed in)
        |        v          v             |
        |     pool-history  apr <---------+
        |        |          |
        +--------+----------+-------------> dashboard view (read-only aggregation)
                                            portfolio scope (read-only)
```

Two edges matter operationally:

- `pool-history` takes its pair scope from `liquidity-history`. If one is rebuilt the other
  should be ticked too, or `verify:pool-analytics` will report divergent universes.
- `holders` is counted over the universe `tokens` publishes. Rebuilding `tokens` alone
  leaves `holders` describing a set that no longer exists; tick them together.

### What advances each dataset

Every dataset is advanced by the render that needs it, on that route's revalidation
cadence. `holders` is the exception and is worth knowing about: confirming balances can
spend a whole tick budget, so `/analytics` **reads** the published snapshot during render
and advances the tick in `after()`, once the response is sent. The universe passed to that
tick is the one the render just used, which is what keeps the two in step.

Consequence for operators: **ticking the token universe without ticking holders makes them
diverge.** The application never does this, but a script that calls `getTokenUniverse()`
alone will — which is why `verify:infrastructure` checks the two published universes
against each other, and why the sequence in [§9](#9-verifying-after-recovery) re-syncs them
before that gate runs.

---

## 2. Fresh deployment

A new instance with an empty cache is a supported state, not a failure.

1. Set `ENVIO_API_TOKEN` in the environment. Nothing else is required.
2. Start the app. Every dataset bootstraps incrementally on its own tick budget.
3. Expect `--` for historical figures for the first minutes to hours. This is correct:
   an incomplete window is withheld rather than published short.

To pre-warm the expensive one:

```bash
npm run bootstrap:history
```

Do not run bootstrap concurrently with the verifiers — both compete for the same
rate-limited endpoint and each will slow the other down.

---

## 3. Restoring persistent state

Copy `.poolix-cache/*.json` into place before starting the process. Files are
self-describing: each carries `version` and `chainId`, and any file that does not match the
running build is discarded and rebuilt rather than reinterpreted.

Restoring a **subset** is safe. Datasets do not require each other to load — only to agree,
and disagreement is detected by `verify:infrastructure` rather than silently tolerated.

---

## 4. Rebuilding derived caches

Deleting any file is safe:

```bash
rm .poolix-cache/apr-4663.json          # cheap
rm .poolix-cache/history-4663.json      # expensive: hours
rm -rf .poolix-cache                    # everything
```

Then tick the affected services (loading `/analytics` does this) or run
`npm run bootstrap:history` for the volume series.

**Prefer deleting over editing.** A hand-edited cache that still parses is exactly the case
the schema check cannot catch.

---

## 5. Corrupted cache

Corruption is handled automatically and does not need intervention: a file that fails to
parse, fails validation, carries the wrong `chainId`, or carries a version this build does
not understand is discarded, and the dataset rebuilds from source.

A **newer** version is also discarded rather than downgraded — it was written by code that
knew more than the running build, and guessing at its meaning is the one failure mode worth
refusing outright.

To confirm the state is sound:

```bash
npm run verify:infrastructure
```

---

## 6. HyperSync outage

No action required. The design already holds:

- A failed request is never converted into zero data.
- A checkpoint never advances past an incomplete read.
- The previous published snapshot stays available throughout.
- 429 is treated as an ordinary event and waited out with bounded backoff.

When the endpoint returns, ticks resume from their checkpoints. Nothing is lost and nothing
double-counts.

If the outage is long enough that a window ages out, the affected figure reads `--` until
coverage is restored — the honest state, not a smaller number.

---

## 7. Process crash

Safe at any point, by construction:

- **Before a query** — nothing changed.
- **After a query, before processing** — nothing persisted; the range is re-read.
- **After processing, before the checkpoint** — the range is re-read. Ingestion is
  idempotent (events are keyed by block and bucket, and bucket totals are *replaced*, not
  accumulated), so reprocessing cannot inflate a metric.
- **After the checkpoint** — work is durable; the next tick continues.
- **During publication** — the write is atomic. A reader sees the whole previous snapshot
  or the whole new one, never a partial file.

A crash mid-write can leave a `.tmp` file. It is inert and never read;
`verify:infrastructure` reports any that accumulate.

---

## 8. Rotating credentials

`ENVIO_API_TOKEN` is the only secret this system uses.

1. Issue a new token from the Envio dashboard.
2. Replace it in `.env.local` (development) or the deployment's environment.
3. Restart. No cache invalidation is needed — **no credential is ever written to analytics
   state**, which `verify:infrastructure` asserts by searching every dataset for the
   configured token and for credential-shaped material.

Never use `NEXT_PUBLIC_ENVIO_API_TOKEN`: Next inlines `NEXT_PUBLIC_*` into the browser
bundle, which would publish the token to every visitor.

---

## 9. Verifying after recovery

Run sequentially — they share a rate-limited endpoint and will throttle each other if run
in parallel:

```bash
npm test && npm run typecheck && npm run lint && npm run build
npm run verify:chain
npm run verify:swaps
npm run verify:transactions
npm run verify:tvl
npm run verify:holders
npm run verify:tokens
npm run verify:historical
npm run verify:liquidity-history
npm run verify:apr
npm run verify:pool-analytics
npm run verify:dashboard
npm run verify:portfolio
npm run verify:infrastructure
```

Three of these depend on freshly-ticked state, which is a property of a live chain rather
than a defect:

- **`verify:tokens`** compares a live scan against the published set. Tick the universe
  immediately before it, or the top-10 ranking rotates mid-scan and drift exceeds
  tolerance.
- **`verify:holders`** only compares when the published snapshot reads `complete: true`.
  Drive ticks until it does, then run the gate immediately. It reports `INCOMPLETE`
  (exit 2) rather than passing on partial coverage — that is correct behaviour, not a
  failure.
- **`verify:infrastructure`** asserts that the holders and tokens universes agree. The
  gates above tick the universe without ticking holders, so run one paired tick
  (`getTokenUniverse()` then `getHolders(universe.tokens)`, in that order) immediately
  before it. A genuine divergence here is not cosmetic: it means the published holder
  count describes a set of tokens the page no longer tracks.

Verifiers that assert 100% window coverage (`liquidity-history`, `apr`, `pool-analytics`)
need the ingestion ticked first, or they fail on the newest hourly bucket.

---

## 10. Limitations

**Local filesystem persistence is development-safe but not multi-instance durable
production storage.**

Concretely, with the filesystem backend:

- Writes are atomic, so a reader never sees a torn file.
- But **two instances cannot detect each other.** Instance A and B both read, both compute,
  and the later write wins regardless of which state is newer. Neither can tell it happened.
- `Storage.supportsCompareAndSwap` is `false` for the filesystem backend, and it says so
  rather than pretending otherwise.
- On a serverless host the filesystem is per-instance and does not survive a cold start.
  Losing it costs a rebuild, not accuracy.

The `Storage` interface is shaped so a shared backend can supply what the filesystem
cannot — atomic writes, compare-and-swap via `setIfUnchanged`/`revision`, and durability —
without any analytics module changing. The leases in `services/storage/lease.ts` reduce
duplicated work between workers but are **not** a correctness mechanism and are not
presented as one: they expire, so a crashed holder cannot block work forever, and a lost
race wastes effort rather than corrupting state.

Until a shared durable backend is configured, Poolix should run as **a single instance**.
