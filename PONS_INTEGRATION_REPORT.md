# Pons integration — Phase 9B report

Pons added as a **token discovery source**. Nothing in Poolix's Uniswap v2 swap, liquidity
or analytics path was changed.

Everything below was verified on chain. Where the chain does not prove something it is
marked unknown, and nothing is filled in by inference.

---

## 1. Verified architecture

**Uniswap v2 is Poolix's trading and liquidity core and nothing here changes that.** Pons
is a discovery source; its Uniswap v3 pool is reference data that identifies a launch and
records where its liquidity went. It is never an execution route.

```
Pons factory (launch events)
    → Poolix Pons indexer
        → UniswapV2Factory.getPair(token, WETH)      ← the question that decides everything
            ├── pair exists      → "V2 Available"   → existing Poolix v2 swap / LP / analytics
            └── pair is zero     → "V2 Not Available" → discovery-only listing, no trading
    → /explore, /token/[address]

Uniswap v3 pool  → stored as "source pool / Pons reference" only
Robinhood Chain 4663 → settlement
```

**No V3 swap execution. No V3 LP. No change to the v2 router. No V3 analytics replacing v2
analytics.** `verify:pons` asserts structurally that no Pons module builds a v3 swap call.

For every indexed launch the v2 factory is asked directly, and its answer — not anything
Pons published — decides whether Poolix offers a trade. A v2 pair is never inferred from
the existence of a v3 one, and a user is never sent to v3 as a substitute.

Three states are kept distinct, because collapsing them would mislead:

| State | Meaning | What the UI does |
|---|---|---|
| **V2 Available** | `getPair` returned a real pair | Existing v2 swap and LP flows, unchanged |
| **V2 Not Available** | `getPair` returned the zero address | Discovery-only; no trade offered |
| **unknown** | the factory has not been asked yet | Shows `--`; **not** treated as "no pair" |

### Contracts, re-verified at implementation time

| Role | Address | Evidence |
|---|---|---|
| Pons factory | `0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB` | 24,353 B; first log at block 8,991,118 — exactly the documented start |
| Pons locker | `0x736D76699C26D0d966744cAe304C000d471f7F35` | 5,426 B; `factory()` → **the Pons factory** |
| Uniswap V3 factory | `0x1f7d7550B1b028f7571E69A784071F0205FD2EfA` | 24,535 B; `getPool` agrees with every launch event |
| Position manager | `0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3` | `name()` = "Uniswap V3 Positions NFT-V1"; `factory()` → V3 factory |
| Swap router | `0xCaf681a66D020601342297493863E78C959E5cb2` | `factory()` → V3 factory, `WETH9()` → WETH |
| Quoter V2 | `0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7` | `factory()` → V3 factory, `WETH9()` → WETH |
| WETH | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` | `symbol()` = WETH, `decimals()` = 18 |

**No address discrepancy was found.** `verify:pons` re-checks all of this on every run.

### One material discrepancy with the brief's framing

The brief calls this the "Active Pons factory". The chain says otherwise:

- Its **last launch is near block 34,755,546 — 2026-08-12, about 40 days ago**, located by
  binary search between a range known to have launches and one known not to.
- **Zero launches** in every 50,000-block window sampled from the chain head back to ~38.7M.
- **No successor factory.** The 21 most recent 1%-tier `PoolCreated` events came from twelve
  different contracts, one or two each — a scattering of unrelated deployers, with the most
  frequent being the position manager itself. No replacement Pons factory exists.
- **No new locks.** Zero positions entered or left the locker in the last 300,000 blocks.
  The locker still emits one event signature (155 occurrences), consistent with servicing
  existing positions rather than receiving new ones.

The address is correct and the contract is what the brief says. It is simply no longer
receiving launches. This is reported rather than worked around, and it has one hard
consequence: **"New Pons Tokens" shows launches that are at least 40 days old**, and the UI
never implies otherwise.

## 2. Event model

The factory emits **7 distinct signatures. Five occur exactly once** (deployment and
configuration). Only two are per-launch, and they fire together in the same transaction —
40,240 of each across the range scanned in Phase 9A, with no divergence.

Event **names are unknown**: the factory is not verified on the block explorer's ABI
endpoint. They are identified by `topic0` and their fields were established empirically.

**Event A** `0x1461370115e1…` — 4 topics, 3 data words
**Event B** `0xdb51ea9ad51a…` — 4 topics, 7 data words

| Field | Meaning | How it was established |
|---|---|---|
| `topic1` | token | resolves to an ERC-20 (`BUNEE`, 18 decimals, supply 1e27) |
| `topic2` | creator | no contract code — an EOA |
| `topic3` | V3 factory | constant across every sample |
| `B.data[0]` | WETH | constant |
| `B.data[1]` | **V3 pool** | equals `getPool(token, WETH, 10000)` for every sample |
| `B.data[4]` | **position tokenId** | `positions(id)` returns the pool's own token0/token1/fee/liquidity |
| `B.data[5]` | **UNKNOWN** | see §10 |
| `B.data[6]` | a variable wei amount | 0.01 / 0.0271 / 0 / 0.0015 ETH — *not* the launch fee |

The documented **0.0005 ETH launch fee appears as no constant in any event**, so it is never
displayed as fact.

## 3. Indexer design

`services/pons/` — six modules, three of them pure and unit-tested.

| Module | Role |
|---|---|
| `pons-config.ts` | verified addresses, fee tier, topics, thresholds |
| `pons-events.ts` | pure decoders for both launch events and the V3 Swap event |
| `pons-math.ts` | pure price, market cap, volume and qualification arithmetic |
| `pons-cache.ts` | `analyticsStore<PonsState>("pons", 2, chainId, …)` |
| `pons-indexer.ts` | `server-only` worker: index → enrich → price |
| `pons-volume.ts` | `server-only` V3 Swap sweep, separate from the v2 pipeline |
| `pons-view.ts` | pure projection of persisted state onto UI rows |

**Records** carry: token, creator, launch block, launch tx hash, pool, position tokenId,
name, symbol, decimals, total supply, pool-verified flag, WETH side, `source: "pons"`,
`indexedAt`, `indexedBlock`, and the worker-computed price, market cap, volume, swap count
and `pricedAt`.

**Deduplicated on both keys** — token address and launch transaction — and every address is
lower-cased on write.

### Three design decisions, each forced by a measurement

**It scans backwards.** Indexing walks down from the last observed launch rather than up
from the factory's start. A forward scan reached **82 MB at 34% coverage** — five times the
largest existing dataset, with ~1.1 s per tick spent purely on JSON I/O — and filled the
list with the *oldest* launches, the opposite of what a discovery surface wants. Backwards
with a **10,000-record cap** keeps the dataset at **3.6 MB** and puts the newest launches
first.

**One phase per tick.** A tick runs exactly one of index / enrich / price, round-robin.
Running all three took ~20 s alone and ~60 s under contention with the holder worker, which
pushed both `/explore` and `/analytics` past Next's 60-second prerender budget.

**Renders never do network work.** `getPonsView()` is a pure projection of persisted state;
the tick is scheduled with `after()`. The first version priced pools during render and took
static generation from 30 s to 115 s — and silently dropped `/explore`'s revalidate from
2 minutes to 30 seconds by pulling the indexer's short-lived fetch into that route's cache
window.

**The page renders a bounded slice.** Sending every indexed launch produced **8,187 table
rows and 16.4 MB of HTML** on a page every visitor loads. `/explore` now renders the newest
100 launches **plus every qualified launch** — qualified rows are never truncated away,
because a filter that shows only a sample of its matches is not a filter. The full indexed
count is reported beside the table rather than implied by its length.

## 4. V3 relationship

For every record, the pool from the event is **independently confirmed** against
`v3Factory.getPool(token, WETH, 10000)` before it is marked verified, and the address is
also asked for its own `token0()`. Both must agree. A record that fails stays in the dataset
as unverified — it did launch — but carries no price and cannot qualify.

`verify:pons` re-reads five pools straight from the chain on every run and checks the pool
address, the fee (10000), that the pair really is token/WETH, and that the stored WETH side
matches. A wrong WETH side inverts every price, so it is checked rather than trusted.

**Graduation.** There is **no separate graduation event**. The pool exists from the launch
transaction, and `ownerOf(positionTokenId)` was the Pons locker for every sample — the
position is locked at launch. No bonding-curve stage was observed and none is modelled. The
status shown is therefore only what is verifiable: *unverified* (pool not confirmed),
*pool verified*, or *traded 24h*.

## 5. Market-cap methodology

`marketCap = totalSupply × price × ethUsd`, in **integer arithmetic end to end**, carried in
USD cents. No floating point touches an on-chain value — a token with 18 decimals and a 1e27
supply exceeds a double long before it reaches a screen.

`price` comes from the pool's `slot0.sqrtPriceX96`, squared and rescaled with the division
performed **last**; dividing first floors every cheap token to exactly zero.

Returns **null**, never zero, when the price, the supply or the ETH/USD feed is unavailable.
Null renders as `--`.

## 6. Volume methodology

24 hours of Uniswap V3 `Swap` events from the verified pools, summed on the WETH side.

A **separate module from the v2 pipeline, deliberately**. V2 emits four unsigned amounts;
V3 emits two signed ones where the negative side is what the pool paid out. Feeding V3 logs
through the v2 aggregator would produce numbers that nothing would catch, and teaching the
v2 aggregator both shapes would change a methodology four verifiers depend on.

**An incomplete window yields null, never a partial sum.** A partial sum is always an
undercount and never announces itself. There is no extrapolation anywhere.

A **complete** window with no trades yields zero — genuinely different from unknown, and
distinguished in both the data and the UI.

## 7. Qualification

```
PONS_DISCOVERY_CONFIG = { minMarketCapUsd: 20_000, minVolume24hUsd: 20_000 }
```

One exported object; the UI reads the numbers from it rather than restating them. A token
qualifies only when **both** figures exist **and** both meet their threshold. A null on
either side is a disqualification with a stated reason, never a zero.

It is a numeric filter and nothing more. No token is described as safe, good or
recommended, and a test asserts that no disqualification message contains such a word.

## 8. Partial indexing

The dataset is **indexed launches, never a total**. The UI states it as
"Pons indexed: N", with the block range and coverage percentage beside it, and says in
words that the remainder has not been read and is not estimated.

Coverage is measured against the factory's **observed working range**
(8,991,118 → 34,755,546), not the chain head. Against the head a fully indexed dataset
would read about 50% for ever, because the factory has been silent for ~34 million blocks.
The chain head is reported separately so the gap stays visible.

Indexing stops for one of two honest reasons — it reached the factory's first block, or it
hit the 10,000-record cap — and `atCapacity` distinguishes them.

## 9. Security decisions

Every Phase 8 control is intact; `verify:security` passes unchanged.

- **Token metadata is untrusted.** Symbols and names go through Phase 8's `sanitizeSymbol` /
  `sanitizeName`: control characters, zero-width characters and bidi overrides stripped,
  whitespace collapsed, length capped. A wholly invisible symbol becomes null and the UI
  falls back to the address.
- **Decimals are bounded** to ≤ 36. A token reporting 255 is refused rather than rendered.
- **No `dangerouslySetInnerHTML`**, no raw HTML, no token-supplied URL is ever navigated to
  or executed.
- **No remote token logos, and the CSP was not weakened.** Phase 8 allows images only from
  Poolix's own origin. The launch events carry no image URI at all, so there is no on-chain
  logo source to use; the initials placeholder is used instead. **This was the right trade
  and it cost nothing.**
- **No credential reaches the client.** The indexer is `server-only`; `verify:pons` asserts
  the API token appears in no Pons dataset.
- **Malformed data is refused, never coerced.** Any log that is not an exact match decodes
  to null.

## 10. Known unknown: event B `data[5]`

A monotonically increasing integer, rising by 1 per roughly 12 seconds of chain time.

Tested and **ruled out**: it is not a position tokenId (`ownerOf` reverts, and the value
exceeds the position manager's total supply of 842,701), and it is not a block timestamp.

**It is left undecoded and unnamed.** Nothing in the integration needs it, and giving it a
plausible name would be inventing protocol behaviour.

## 11. V2 availability — the trading decision

Every indexed launch is asked of the Uniswap v2 factory: `getPair(token, WETH)`. The stored
answer must match what the factory says, and `verify:pons` re-reads a sample on every run —
preferring records that claim a pair, since those are the ones whose being wrong would show
a user a trade that cannot execute.

**Measured result so far: of the launches checked, `getPair` returned the zero address for
every one.** Pons launches into v3, so this is expected rather than surprising — but it is
reported as a measurement, not assumed. Sampling is ongoing as enrichment proceeds.

The encoder was verified against a control rather than trusted: a token taken from the v2
factory's own `allPairs(0)` round-trips to its pair through the same code path, so "no pair"
is a real answer and not a silently broken call.

Consequently:

- **V2 Available** → the normal Poolix swap and liquidity links, because the token is an
  ordinary v2 token as far as the core is concerned.
- **V2 Not Available** → "Discovery only — no Uniswap v2 pair", stating that the launch
  liquidity sits in the v3 source pool which Poolix records but does not route through. No
  swap button, and **no suggestion to use v3 instead**.
- **unknown** → says so explicitly, and notes that an unread answer is not a "no".

A test asserts the decoded launch record carries no field that could be mistaken for a v2
pair or router, so v2 availability can only ever come from the v2 factory.

## 12. Durability

Unchanged from Phase 7, and restated because it still applies:

> **Local filesystem persistence is development-safe but not multi-instance durable
> production storage.**

Two instances indexing at once will not corrupt the file — writes are atomic — but the later
write wins and neither can detect it. **This is a single-instance index. It is not
distributed indexing and must not be described as such.**

## 13. Limitations

- Coverage is partial and stated. No total number of Pons launches is claimed anywhere.
- The factory is dormant, so the newest indexed launch is ~40 days old.
- Volume is measured only for pools inside the priced slice (the newest 60 per tick); a pool
  outside it has unknown volume, not zero, and cannot qualify.
- Event names remain unknown; the integration keys on topic hashes.
- `data[5]` remains undecoded.
- V3 swap execution and V3 LP are **not** implemented and are out of scope. A Pons token is
  tradeable on Poolix only when a Uniswap v2 pair exists; otherwise it is discovery-only.
- V2 availability is read during enrichment, so a freshly indexed launch reports `unknown`
  until its turn comes. That is deliberate — an unread answer is not a "no".
- Legacy Pons is out of scope — no legacy factory address was supplied or discovered.

## 14. Regression results

17 of 18 gates pass. **`verify:tokens` does not, and it is not from this phase.**

| Gate | Result |
|---|---|
| `npm test` | PASS — **804** tests (was 716; +88 Pons) |
| `typecheck`, `lint` | PASS |
| `build` | PASS — 18/18 pages, no retries on warm caches |
| `verify:security` | PASS |
| `verify:chain` | PASS — 30 checks |
| `verify:swaps`, `verify:transactions`, `verify:tvl` | PASS |
| `verify:holders` | PASS — drift 0, 15/15 coverage |
| **`verify:tokens`** | **FAIL — drift 4–9 against a tolerance of 3** |
| `verify:historical` | PASS — 168/168, 720/720 |
| `verify:liquidity-history`, `verify:apr` | PASS — 100% coverage |
| `verify:pool-analytics`, `verify:dashboard`, `verify:portfolio` | PASS |
| `verify:infrastructure` | PASS — `pons` registered, healthy |
| `verify:pons` | PASS |

### Why verify:tokens fails, measured

It compares a ~10-minute live scan against the published token set and allows a drift of
`max(2, 30%)` = 3 for ten tokens. Seven attempts gave 8, 9, 4, 8, 4, 6, 6.

The cause was measured rather than guessed: sampling the published universe every two
minutes showed it **drifts by 4 over ten minutes — above the tolerance — while pair
creation had stopped** (0–3 new pairs in that window). So the drift is not new pairs; it is
existing pools' reserves reshuffling the top-ten-by-WETH ranking at the margins. With the
verifier's own scan taking about ten minutes under current endpoint throttling, the
comparison window is wider than the tolerance allows.

**This phase did not cause it and cannot have:** `verify:tokens` exercises
`services/tokens/universe.ts` and `services/pools/discovery.ts`, neither of which was
modified, and neither of which imports anything from `services/pons/` — verified against
the import graph. The gate passed at drift 0 and 2 earlier the same day on the same code.

**No tolerance was changed and no verifier was weakened.** It needs a quieter chain, or a
faster scan than the throttled endpoint currently allows.

### Two verifier gaps this phase exposed, both fixed

- **`verify:infrastructure` did not know about the new dataset** and correctly flagged
  `pons-4663.json` as unaccounted. Registering it was an omission on my part, not a gate
  problem — the gate did exactly its job.
- **Its 32-byte-secret pattern false-positived on Pons launch transaction hashes**, which
  are legitimately 64 hex characters. The original exemption reasoning covered addresses
  (40 characters) but not hashes. Fixed by stripping values under fields whose *name* says
  they are a hash, before the secret test runs — proven field-scoped: a secret is still
  flagged under any other field name, in a bare array, and even sitting directly beside a
  legitimate hash.

## 15. What remains manual

- Deciding whether a remote logo source is ever worth a CSP change. Current answer: no.
- Watching for a successor Pons factory. If launches resume from a new address, that address
  must be verified and added to `pons-config.ts`; nothing auto-discovers it.
