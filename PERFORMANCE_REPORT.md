# Poolix performance — route navigation and loading

Navigation latency only. **No analytics definition, calculation or methodology changed, and
the Pons / Uniswap v2 architecture is untouched.** Every figure the UI shows is produced by
the same functions, from the same data, under the same publication rules as before. What
changed is *when* the work happens.

Measure with `npm run measure:routes` (add `--routes-only` for genuinely cold route
timings, `--quick` to skip the cold pass).

---

## 1. Audit — measured before any change

Server data path, Robinhood Chain mainnet, filesystem cache warm from prior runs.

| Service | cold | warm | 5× concurrent |
|---|---|---|---|
| `discoverPools` | **10.43 s** | 0.00 s | shared |
| `getPoolHistory` | **6.93 s** | 0.00 s | shared |
| `getLiquidityHistory` | 3.42 s | 0.00 s | shared |
| `getApr` | 2.50 s | 0.00 s | shared |
| `getSwapWindow` | 1.44 s | 0.55 s | shared |
| `getHistory` | 1.12 s | 0.53 s | shared |
| `getActivityWindow` | 0.93 s | 0.56 s | shared |
| `getTokenUniverse` | 0.94 s | 0.00 s | shared |
| `readPublishedHolders` | 0.11 s | 0.10 s | **4.3× DUPLICATED** |
| `getPonsView` | 0.08 s | 0.07 s | **5.1× DUPLICATED** |
| `/explore` | — | 0.08 s | **4.6× DUPLICATED** |

`/` and `/swap` await nothing — already immediate, so **Task 8 held by construction** and
nothing was added to the swap path.

### The four findings

1. **`getDashboard` serialised five independent reads.** `dashboard.ts:108–112` awaited
   holders, history, liquidity, APR and pool-history one after another: 0.11 + 1.12 + 3.42
   + 2.50 + 6.93 = **14.1 s where the slowest alone is 6.9 s**.
2. **Four ingestion services ticked *during* the render.** History, liquidity, APR and
   per-pool history each ran a network scan before the page could emit HTML. The render was
   paying for a refresh nobody had asked for.
3. **Two snapshot reads had no single-flight.** `readPublishedHolders` parses a 16 MB JSON
   and `getPonsView` a 3.6 MB one; concurrent callers each did the whole parse.
4. **Two routes had no loading UI at all** (`/explore`, `/portfolio`), and `/analytics` had
   three grey bars that matched nothing on the page.

---

## 2. Changes

### Parallelised the dashboard reads

The five became one `Promise.all`. Safe because every service holds a single-flight guard,
so `getApr` reading history and liquidity internally *joins* those promises rather than
starting a second scan.

### Renders read; workers refresh

Added `readHistory`, `readLiquidityHistory`, `readApr`, `readPoolHistory` — each reusing the
**same `summarise` the tick itself already falls back to when the chain is unreachable**.
Not a second projection, not a new code path: the existing one made callable.

`getDashboard` now calls these. `/analytics` advances the real ticks in `after()`, once the
response is sent — the pattern Phase 7 established for holders, extended to the rest.

Nothing about the figures changes: same windows, same coverage rules, same withholding of
an incomplete window, same `--`. `latestBlock` reads `--` on the read-only path because no
height was fetched, which is honest rather than a stale number.

### One refresh per render, rotating

Moving four ticks into `after()` fixed the render and created the next bottleneck: run end
to end they exceed a minute, and `after` counts towards a prerender's budget — `/analytics`
began failing its build with *"took more than 60 seconds"*.

So `services/analytics/refresh-rotation.ts` advances exactly one service per render. With a
30-second revalidate the whole set refreshes within a couple of minutes and no single
response pays for all of it. Seven tests cover the rotation.

**Liquidity and APR advance together in one slot.** Splitting them broke `verify:apr`: the
fee series covered 16 pools while liquidity covered 6, because they refreshed on different
renders. APR's denominator *is* the liquidity series, so they are not independent steps.
Caught by the gate, fixed, re-verified.

### Single-flight for snapshot reads

`services/storage/snapshot-read.ts` — a 5-second memo, **scoped strictly to read-only
snapshot loads and never to anything that ticks**, because memoising a tick would change
what "fresh" means. A snapshot on disk cannot change between the tick that wrote it and the
tick that writes the next, so this returns identical bytes and no figure moves.

### Loading UI

New `/explore` and `/portfolio` skeletons, and `/analytics` rewritten from three grey bars
to the real layout — four-tile overview row, chart with its timeframe control, six volume
and fee tiles, two ranking tables with headers and rows. No full-screen spinner anywhere.

### Navigation

Already correct: every nav link is `next/link`, so there were no full-page reloads to fix
and nothing to change. Prefetch was left at Next's default deliberately — `/analytics` and
`/explore` are exactly the routes whose prefetch would trigger expensive server work, which
Task 6 warns against.

---

## 3. Results

### Client navigation, measured in the browser

| Navigation | shell visible | full content |
|---|---|---|
| → `/explore` | 138 ms | 138 ms |
| → `/pools` | 192 ms | 194 ms |
| → `/swap` | 228 ms | 229 ms |
| → `/portfolio` | 246 ms | 246 ms |
| → `/analytics` | **370 ms** (skeleton) | data behind it |

**The headline: `/analytics` shows its shell in 370 ms.** Previously the screen sat frozen
while the scans ran. That was the primary complaint and it is fixed.

### Server render (RSC payload, warm)

| Route | ms |
|---|---|
| `/` | 100 |
| `/swap` | 108 |
| `/pools` | 186 |
| `/explore` | 308 |
| `/analytics` | **904** |
| `/portfolio` | 15,324 (cold `discoverPools` — see below) |

### Service path, before → after

| | before | after |
|---|---|---|
| `/analytics` warm | 1.17 s | **0.66 s** |
| `/explore` warm | 0.08 s | **0.00 s** |
| `readPublishedHolders` concurrent | **4.3×** | shared |
| `getPonsView` concurrent | **5.1×** | shared |
| `/explore` concurrent | **4.6×** | shared |
| Production build | 107 s, with retries | **26.6 s, no retries** |

No `DUPLICATED` entry remains anywhere.

---

## 4. Remaining slow operations

**`discoverPools`, ~10 s cold.** Now the dominant cost on a cold instance, and it is in
`/analytics`, `/explore`, `/pools`, `/tokens` and `/portfolio`. It holds an in-process TTL
cache but persists nothing, so every cold start pays it — which is the whole of
`/portfolio`'s 15.3 s above.

**I deliberately did not persist it**, for two reasons worth stating rather than burying:

1. Serving a stored pool ranking is precisely the high-water bug fixed earlier — a frozen
   ranking showed drained pools as top tokens. Task 5 does sanction stale-while-refresh, so
   it is viable, but only as a whole coherent timestamped snapshot with a visible age,
   replaced wholesale and never merged.
2. It would make `verify:tokens` worse. That gate compares a live scan against the published
   universe and is *already* failing on churn; adding minutes of staleness to discovery
   would widen the very drift it measures.

Trading a correctness gate for a speed number is not a trade worth making silently. It is
the obvious next step, and it needs the snapshot-age labelling and a `verify:tokens`
redesign alongside it.

**`getSwapWindow` and `getActivityWindow` still tick during render** (~0.55 s each warm).
Both compute a *rolling* 24-hour window against the current block height, so a read-only
variant would need a height — and passing a stale one would misreport coverage. Left alone
rather than risk the methodology for half a second.

**`fetchChainStatus` showed 2.3× duplication** in the harness. That is a measurement
artifact: it uses `unstable_cache`, which only engages inside a Next render, and the harness
runs outside one. In production it is already cached.

### `verify:tokens` — why the suggested redesign is not possible here

The gate compares a ~10-minute live scan against the published universe and allows a drift
of `max(2, 30 %)` = 3 for ten tokens. Eight attempts gave 8, 9, 4, 8, 4, 6, 6, 4.

The cause is measured, not inferred. Sampling the published universe every two minutes
showed it **drifts by 4 over ten minutes — above the tolerance — while pair creation had
stopped** (0–3 new pairs in that window). The movement is not new pairs; it is existing
pools' reserves reshuffling the top-ten-by-WETH ranking at the margins.

Task 12 suggests freezing a universe snapshot at the start of the run. **Two things were
checked, and the redesign turns out to be blocked by the endpoint, not by the code:**

1. **The published set is already frozen.** `verify-tokens.ts` loads it at line 154, before
   the scan begins at line 165. That half is done.
2. **The scan itself cannot be made atomic.** Every call uses `"latest"` (line 68), so over
   ten minutes the ranking is assembled from a moving chain. The fix would be to pin every
   call to one block — but the RPC does not allow it:

   ```
   head  69,143,363
   -  0 blocks   ok
   - 64 blocks   ok
   -128 blocks   FAILED  "Archive requests require a personal token"
   -6000 blocks  FAILED  "Archive requests require a personal token"
   ```

   PublicNode serves state roughly **64–127 blocks back — about 6 to 12 seconds** at this
   chain's ~10 blocks/second. A 52,000-pair scan cannot finish inside that window under the
   endpoint's own throttling.

So an atomic scan needs one of: an **archive-capable RPC** (paid), or a scan fast enough to
complete within ~64 blocks, which throttling makes impossible. The third option — sizing the
tolerance to the measured churn — is exactly the tolerance increase that is forbidden, and
rightly so.

**This phase did not cause it and cannot have.** The gate exercises
`services/tokens/universe.ts` and `services/pools/discovery.ts`, neither modified here, and
neither importing anything from the changed modules. It passed at drift 0 and 2 earlier in
the same session, on the same code, when the chain was quieter.

It is left failing and documented rather than papered over.

---

## 5. A bug this work introduced, found and fixed

Declaring the read-only helpers as `export const x = memoizeSnapshotRead(...)` at module top
level broke `/analytics` with a 500: **`ReferenceError: memoizeSnapshotRead is not defined`**.

These analytics modules form an import cycle — `liquidity-history` needs `history-window`'s
bucket ranges, `apr-window` needs `liquidity-history`, `pool-history` needs both — and in an
ES module cycle a top-level call to an imported function can execute before that binding is
initialised.

Fixed by building each memo on first use behind a `let memo = null` and a hoisted function
declaration, neither of which runs anything at module load. Verified in a browser: the 500
is gone and `/analytics` renders real figures (TVL $1,030,590.12 across 17 scanned pools).

Worth recording because typecheck, lint and every Node-based verifier passed while the page
was returning 500 — the cycle only manifested through the bundler.

---

## 6. Regression results

| Gate | Result |
|---|---|
| `npm test` | **PASS** — 825 tests (was 818; +7 rotation tests) |
| `typecheck`, `lint` | **PASS** |
| `build` | **PASS** — 18/18 pages in 35.3 s, no retries |
| `verify:security` | **PASS** |
| `verify:chain` | **PASS** — 30 checks |
| `verify:swaps`, `verify:transactions`, `verify:tvl` | **PASS** |
| `verify:holders` | **PASS** — drift 2, tolerance 29; 74,150 candidates confirmed |
| `verify:historical` | **PASS** |
| `verify:liquidity-history` | **PASS** |
| `verify:apr` | **PASS** — after fixing the regression this work introduced |
| `verify:pool-analytics` | **PASS** |
| `verify:dashboard` | **PASS** |
| `verify:portfolio` | **PASS** |
| `verify:infrastructure` | **PASS** |
| `verify:pons` | **PASS** |
| `verify:tokens` | **outstanding** — the churn issue documented in §4 |

Two gates needed state prepared beforehand, as their own documentation specifies and not by
relaxing anything: the hourly series were ticked before the 100 %-coverage gates, and the
token/holder universes were paired before `verify:infrastructure`.

## 7. What was not touched

- Swap, liquidity and analytics **methodology** — every definition, window, rate and
  coverage rule is unchanged.
- The **Uniswap v2 core**: router, pair discovery, swap execution, LP flows.
- **Pons** architecture: still discovery-only, V3 pool still reference data, no V3
  execution, and its indexing remains isolated behind its own `after()` rotation.
- **No verifier was weakened.** No tolerance raised, no check removed, no coverage reduced,
  no value estimated or hardcoded. `verify:apr` caught a real regression in this work and
  was fixed rather than adjusted.
