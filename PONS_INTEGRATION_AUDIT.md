# Pons integration audit — Phase 9A

Read-only audit. No Poolix code was changed to produce this document.

Every address in the brief was checked against the chain, and the Pons event model was
**derived from the factory's own logs** rather than assumed. Where something could not be
established from the chain, it is recorded as undetermined rather than filled in.

---

## 1. Verification of the supplied addresses

All seven addresses carry code on chain 4663, and every cross-reference the brief implies
holds. Nothing was taken on trust.

| Role | Address | Code | Verified how |
|---|---|---|---|
| Pons factory (active) | `0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB` | 24,353 B | `owner()` responds; first log at block **8,991,118**, exactly the stated start block |
| Pons locker | `0x736D76699C26D0d966744cAe304C000d471f7F35` | 5,426 B | `factory()` → **the Pons factory** (not the V3 factory) |
| Uniswap V3 factory | `0x1f7d7550B1b028f7571E69A784071F0205FD2EfA` | 24,535 B | `owner()` responds; `getPool` behaves |
| Position manager | `0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3` | 24,384 B | `name()` = **"Uniswap V3 Positions NFT-V1"**, `symbol()` = `UNI-V3-POS`; `factory()` → V3 factory |
| Swap router | `0xCaf681a66D020601342297493863E78C959E5cb2` | 24,497 B | `factory()` → V3 factory, `WETH9()` → WETH |
| Quoter V2 | `0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7` | 8,273 B | `factory()` → V3 factory, `WETH9()` → WETH |
| WETH | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` | 2,202 B | `symbol()` = `WETH`, `decimals()` = 18; identical to Poolix's configured WETH |

- Chain id read from the node: **4663**. Matches.
- `ponsFactory.owner()` = `0x263ed295dafae1d9aadd6e56c4b6f9f38ee019dd`
- `v3Factory.owner()` = `0x05c420bc4823e039aa4da645edde743486daaa25` (a **different** owner from the Pons factory — the V3 deployment is not owned by Pons)

**No discrepancy found.** Every supplied address is what the brief says it is.

### Claims that could NOT be verified

- **Launch fee 0.0005 ETH.** No constant of this value appears in any factory event field.
  Event B's `data[6]` is a *variable* wei amount (observed 0.01, 0.0271, 0, 0.0015 ETH), so
  it is not the launch fee. The fee may be taken without being logged. **Not verified; must
  not be displayed as fact.**
- **Fixed supply 1,000,000,000.** Verified for the sampled token only: `totalSupply()` =
  `1e27` = 1,000,000,000 × 10¹⁸. Not verified across all tokens, and must be read per token
  rather than assumed.
- **Pool fee 10000 (1%).** Verified on the sampled pool and in the factory's configuration
  event. Treated as the expected tier, still read per pool.

---

## 2. The Pons event model, as read from the chain

The active factory emits **7 distinct event signatures**. Names are unavailable — the
contract is not verified on the block explorer's ABI endpoint — so events are identified by
`topic0` hash and their field layout was established empirically.

### The two launch events

Every launch emits **both**, in the same transaction, at different log indices. Their counts
are identical across the whole scanned range, so they are 1:1.

**Event A** — `0x1461370115e1c2be79cb529f8cfcbd11316e789d9c6099fc83417b0b4c48c62a`
4 topics, 96 bytes of data.

| Field | Meaning | Evidence |
|---|---|---|
| `topic1` | **token address** | Varies per launch; resolves to an ERC-20 (`BUNEE`, 18 decimals, supply 1e27) |
| `topic2` | **creator** | Varies; `eth_getCode` = empty, i.e. an EOA |
| `topic3` | V3 factory | Constant `0x1f7d7550…` |
| `data[0]` | WETH | Constant `0x0Bd7D308…` |
| `data[1..2]` | zero in every sample | — |

**Event B** — `0xdb51ea9ad51ab453a65a4cb7e60c3cb378c9501bb002609f8f97778fb6c4235a`
4 topics, 224 bytes of data. Same `topic1..3` as event A.

| Field | Meaning | Evidence |
|---|---|---|
| `data[0]` | WETH | Constant |
| `data[1]` | **V3 pool address** | `v3Factory.getPool(token, WETH, 10000)` returns **exactly this address** for all four sampled launches |
| `data[2..3]` | zero in every sample | — |
| `data[4]` | **position manager tokenId** | `positions(id)` returns the same token0/token1/fee/liquidity as the pool |
| `data[5]` | **undetermined** | Monotonic, +1 per ~12 s of chain time. Not a tokenId (`ownerOf` reverts; value exceeds the manager's 842,701 total supply). Not a timestamp. **Recorded as unknown.** |
| `data[6]` | variable wei amount | 0.01 / 0.0271 / 0 / 0.0015 ETH. Can be zero. Consistent with an optional initial buy; **inference, not fact** |

### The other five signatures

- `0x8be0079c…` ×1 at block 8,991,118 — the standard `OwnershipTransferred(address,address)`
  signature, at the factory's deploy block.
- `0x54729d9f…` ×1 at block 8,991,125 — a configuration event whose data contains the V3
  factory, position manager, swap router and `0x2710` (**10000**, confirming the 1% tier).
- `0x26d31e04…`, `0x4f1ea501…`, `0x13543882…` — each appears **exactly once** across 40,240
  launches.

**This is a useful result in its own right: of the seven signatures, five occur exactly once
and are deployment/configuration events. Only two are per-launch.** Discovery therefore has
a complete picture of the launch lifecycle from events A and B alone — there is no third
per-launch event that could carry state the integration is missing.

### Legacy Pons

The brief supplies no legacy factory address, and none was discovered. **Legacy launches
are out of scope for Phase 9A**, which is consistent with the instruction to treat current
Pons as primary and to support legacy only where it does not complicate the integration.

---

## 3. Graduation and the V3 relationship — verified

This is the part most at risk of being assumed, so each claim below is a measurement.

For the sampled launch (`BUNEE`):

- `v3Factory.getPool(token, WETH, 500)` → no pool
- `v3Factory.getPool(token, WETH, 3000)` → no pool
- `v3Factory.getPool(token, WETH, 10000)` → `0x8f4f723f…` — **the address in event B's `data[1]`**
- That pool's own view: `token0()` = the token, `token1()` = WETH, `fee()` = **10000**,
  `factory()` = the V3 factory, `liquidity()` = 36,819,258,015,569,838,458,222,
  `slot0().tick` = −195,451
- Token ordering matches plain address sort order, as Uniswap requires
- `positionManager.ownerOf(data[4])` = **the Pons locker**, for **all four** sampled
  launches. `positions(data[4])` returns the same token0/token1/fee/liquidity as the pool.

**Conclusions that follow from the above, and nothing more:**

1. A Pons token's pool is discoverable two independent ways — from event B, and from the V3
   factory — and they agree. Discovery can therefore *verify* rather than trust the event.
2. The LP position is held by the Pons locker at launch. The position is **locked**.
3. There is no separate "graduation" event among the launch pair: the pool exists from the
   launch transaction itself. **No bonding-curve-to-AMM migration was observed.** Any
   graduation model beyond "pool exists and is locked" would be invention, and Phase 9B
   must not assume one.

---

## 4. Existing Poolix architecture

### Token model

`Currency` (`services/liquidity/types.ts`) is a two-arm union — `native` and `erc20
{address, symbol, name, decimals}`. **There is no `source` field**, and nothing in it is
V2-specific. A Pons token fits this shape unchanged; the source tag must be added *around*
it rather than inside it, so existing call sites are unaffected.

`TokenListing` (`services/tokens/listing.ts`) is the Explore row: `{address, symbol,
decimals, priceEth, ethLiquidity, poolCount, deepestPool}`. Every field is derived from **V2
pool reserves**. A Pons token has no V2 reserves, so it cannot populate this type — a
separate row type is required, not an extension of this one.

### Discovery flow

```
discoverPools()                 server-only, bounded 300-pair window, 20s budget, paced
  └─ listTokens(discovery)      collapses pools → one row per token
       └─ /explore (server)     revalidate 120
            └─ <ExploreBrowser> client; tabs tokens|pools; filters in memory, never fetches
```

`/token/[address]` is a thin server page that hands the raw parameter to `<TokenDetail>`, a
client component that reads metadata and the **V2** pair via wagmi.

### Caching

Phase 7's `analyticsStore<T>(dataset, version, chainId, validate, migrate?)` over
`services/storage/storage.ts`: atomic temp-and-rename writes, schema version and chain id
stamped, corrupt or mismatched state discarded and rebuilt, never migrated downward. Eight
datasets exist today. A Pons dataset should use this and nothing else.

### RPC / indexer boundaries

- `services/chain/rpc.ts` — `server-only`; issues **only** `eth_call` and `eth_blockNumber`;
  batched, paced 120 ms, 3 attempts, 10 s/30 s timeouts.
- `services/analytics/hypersync.ts` — `server-only`; fixed endpoint constants; bounded
  backoff; 10 s/45 s timeouts; token read from `ENVIO_API_TOKEN`, never logged.
- `services/chain/multicall.ts` — Multicall3 at `0xcA11…CA11`, batch 250.

Pons discovery must sit behind these same modules. Introducing a second transport would
duplicate the throttling behaviour that took three phases to get right.

### Analytics token universe — must not be touched

`services/tokens/universe.ts` publishes the ≤10 tracked tokens that drive the holder count,
and `verify:infrastructure` asserts the holders universe equals it. **Pons tokens must not
enter this universe.** Doing so would change the holder methodology, which Task 15 forbids.

---

## 5. What Pons adds, and the constraint that shapes everything

**Four sampled Pons tokens were checked against the Uniswap V2 factory. All four returned
`getPair(token, WETH)` = the zero address. All four have a V3 pool.**

So:

1. **Pons tokens are invisible to Poolix today.** V2 discovery cannot see them at any window
   size, because the pairs do not exist. This is the entire justification for the
   integration.
2. **Pons tokens are not tradeable through Poolix's V2 core.** The swap path builds calls to
   the V2 router; for a token with no V2 pair the quote returns null and a swap would fail.
   A Pons token page **must not offer a V2 swap**, and must say plainly that liquidity is in
   Uniswap V3 and that Poolix does not execute V3 swaps in this phase.

This is the single most important honesty constraint in Phase 9B. Showing a swap button
that cannot work would be worse than showing nothing.

---

## 6. Scale and coverage

An attempt was made to scan the factory's entire history. **It did not complete** — the
indexer throttled persistently and the scan stopped after exhausting its retries. The
figures below are exactly what was covered, and are not extrapolated.

| Measure | Value |
|---|---|
| Factory start block | 8,991,118 (verified — first log lands here) |
| Chain head at audit time | 68,762,355 |
| **Blocks actually scanned** | 8,991,118 → 13,117,425 |
| **Coverage of the factory's life** | **4,126,307 of 59,771,237 blocks — 6.9 %** |
| Launch events A | 40,240 |
| Launch events B | 40,240 — **identical, confirming exact 1:1 pairing over 40k samples** |
| Unique token addresses | **40,240 — equal to the launch count, so zero duplicates** |
| Unique V3 pools | **40,240 — one distinct pool per launch** |
| Event B carrying a non-zero pool | **40,240 — 100 %** |
| Unique creators | 13,302 (creators launch ~3 tokens each on average) |
| Distinct event signatures | 7 (5 of them one-off) |
| Cost | 86 HyperSync requests, 77 pages, **9 throttled**, 150.9 s |

**What this establishes, and what it does not.** Within the covered 6.9 %: every launch has
a unique token, a unique pool, and a pool address present in its event. What it does *not*
establish is anything about the remaining 93.1 % — no count, no rate, and no guarantee the
pattern holds.

**Do not state a total.** A linear extrapolation would suggest a number in the hundreds of
thousands, but the launch rate over the unscanned range is unmeasured, and publishing an
extrapolation as a figure is exactly the kind of invented number this project refuses.

The scan cost is itself the key design input: **6.9 % took 77 pages and 151 seconds, with
throttling already biting.** Full historical coverage would be on the order of 1,100 pages
and tens of minutes under ideal conditions, and more in practice. Therefore:

- A full sweep cannot happen during a page render, and cannot be a prerequisite for the
  Explore page rendering at all.
- **Phase 9B must discover a bounded recent window** — the same shape as every other Poolix
  window — and state its coverage, exactly as `/explore` already says "Covering N of M
  pairs".
- Historical backfill, if wanted later, belongs in a checkpointed background dataset like
  `history`, which already takes hours to build and is understood to.

Claiming "all Pons tokens" would be false. The UI must say which block range it covers.

---

## 7. Risks

| Risk | Consequence | Mitigation for 9B |
|---|---|---|
| **Volume of launches** | A naive full scan never finishes; a cache grows without bound | Bounded recent window, explicit coverage, measured cache size |
| **No V2 liquidity** | A swap button that always fails | Do not offer V2 swap on Pons tokens; state where liquidity lives |
| **V3 price math is not V2 math** | Mixing `slot0` pricing with reserve pricing produces wrong numbers | Keep the two models separate; never feed V3 data into V2 analytics |
| **USD thresholds** | Fabricated market cap / volume | Both require a validated price path; without one the token does **not** qualify and the empty state must explain why |
| **Untrusted metadata** | Impersonation, layout damage | Reuse Phase 8's `sanitizeSymbol`/`sanitizeName`/`isUsableDecimals` — already built for exactly this |
| **Token logos** | See below | — |
| **Holder universe contamination** | Changes holder methodology | Pons tokens stay out of `tokens/universe.ts` |
| **Endpoint throttling** | Flaky gates, as in earlier phases | Reuse the paced transports; never add a parallel one |
| **`data[5]` unknown** | Guessing invents meaning | Leave it undecoded; nothing in 9B needs it |

### Token logos are currently impossible without a security decision

Phase 8 set `img-src 'self' data:` and `images: { remotePatterns: [] }`. **A remote token
logo would be blocked by the CSP and rejected by the image optimizer.** Task 5 lists "token
logo if available" — delivering it requires either:

- allowing an external image origin in the CSP (weakens a Phase 8 control, and the origin
  would be attacker-influenced if the URL comes from token metadata), or
- proxying and re-serving images from Poolix's own origin (new fetch surface, new SSRF
  considerations), or
- **not showing remote logos** and keeping the existing initials-in-a-circle placeholder.

**Recommendation: the third.** It costs nothing, keeps every Phase 8 control intact, and no
Pons logo source was found on chain anyway — the launch events carry no URI field. This
should be the user's call, and 9B should not silently relax the CSP.

---

## 8. Implementation plan for Phase 9B

Ordered, with the non-regression rule enforced at each step.

**1. `services/pons/pons-config.ts`** — verified addresses as constants, the 10000 fee tier,
`PONS_FACTORY_START_BLOCK = 8_991_118`, the two launch `topic0` hashes, and
`PONS_DISCOVERY_CONFIG = { minMarketCapUsd: 20_000, minVolume24hUsd: 20_000 }` as a single
exported object — thresholds referenced from there, never inlined in UI.

**2. `services/pons/pons-events.ts`** — pure decoder for events A and B. No `server-only`,
so it is unit-testable (the pattern proven by `multicall-codec.ts`). Decodes token, creator,
pool, tokenId. Anything that is not an exact, well-formed match decodes to `null`.

**3. `services/pons/pons-discovery.ts`** — `server-only`. Bounded recent-window sweep via
the existing HyperSync transport. Verifies each pool against `v3Factory.getPool` rather than
trusting the event. Reads metadata through the existing paced RPC/multicall, sanitised with
Phase 8's helpers. Tags every row `source: "pons"`.

**4. `services/pons/pons-cache.ts`** — `analyticsStore<PonsState>("pons", 1, chainId, …)`.
New dataset; no existing dataset touched. Registered in `verify:infrastructure`'s inventory.

**5. `services/pons/pons-math.ts`** — pure. V3 `sqrtPriceX96` → price, market cap from a
verified supply and a verified price, threshold qualification that returns a *reason* when a
token does not qualify. Returns `null`, never a guess.

**6. Explore UI** — a source filter (`All | Pons | Uniswap`) and a Pons status filter
(`New | Active | Graduated`) over a **separate row type**. `--` wherever a value is not
derivable. No ranking language, no scores.

**7. Token detail** — a Pons section visually separated from Poolix/Uniswap analytics, with
an explicit statement that liquidity is in Uniswap V3 and that Poolix does not route V3
swaps in this phase.

**8. Freshness** — last indexed block, scan timestamp, and a stale indicator, all from real
values; never "live" when the data is cached.

**9. Tests** — `pons-events.test.ts`, `pons-math.test.ts`, `pons-security.test.ts` covering
every case in Task 12.

**10. `scripts/verify-pons.ts`** + `npm run verify:pons`, covering all 15 required checks
independently of the service code.

### Must remain untouched

Chain id; PublicNode RPC strategy; HyperSync strategy; V2 swap execution, router and pool
discovery; TVL, volume, fees, transactions, active-user, holder, historical-volume,
historical-liquidity, APR and portfolio methodologies; all Phase 8 security controls; the
Phase 7 storage architecture and the eight existing datasets.

Pons is an **additional discovery source**. It reads; it changes nothing that already works.

---

## 9. Answer to Task 1.8 — does a Pons token fit the existing model?

**Partly, and the distinction matters.**

- `Currency` fits **unchanged**: a Pons token is an ERC-20 with an address, symbol, name and
  decimals. No change to the type, so no risk to existing tokens.
- `TokenListing` does **not** fit: every one of its fields is derived from V2 reserves, which
  a Pons token does not have. Forcing it in would mean either fabricating `priceEth` and
  `ethLiquidity` or filling them with zeros — and a zero that means "no V2 pool" is
  indistinguishable from a zero that means "drained pool". That is precisely the class of
  error Poolix's data policy exists to prevent.

**Therefore: a separate `PonsToken` row type, sharing `Currency` for identity, carrying its
own V3-derived fields, and tagged `source: "pons"` so it can never be confused with a
`source: "uniswap"` row.**
