# POOLIX — Development Checkpoint

Snapshot of the project as built. Written so a fresh session can continue without any
prior chat context. Companion docs: `README.md` (how to run), `HANDOFF.md` (decisions +
verification record), `/docs` in-app (user-facing reference).

Date: 2026-09-17

---

## 1. Current phase and completion status

All six phases of the original plan are **complete**, with all four gates green.

| Phase | Scope | Status |
|---|---|---|
| 1 — Foundation | Next.js scaffold, design system, layout, nav, landing, chain config | Complete |
| 2 — Swap | v2 adapter, quoting, approval + transaction lifecycle, swap UI | Complete (read path verified live; write path **not** exercised — see §11) |
| 3 — Pools | Pool discovery, pool list/detail, add + remove liquidity | Complete (write path not exercised) |
| 4 — Analytics & Tokens | Token explorer, pool-derived pricing, analytics | Complete within data limits (§12) |
| 5 — Developers | Docs shell, contract reference, integration guide | Complete |
| 6 — Polish | ⌘K search, dashboard, error/not-found, favicon/OG, robots/sitemap, mobile pass | Complete |

Nothing is stubbed or faked. Where a value cannot be derived from a verifiable source it
renders `--` with an on-page explanation.

---

## 2. Implemented routes

16 routes. `○` = static/ISR prerendered, `ƒ` = dynamic on demand.

| Route | Type | Revalidate | Notes |
|---|---|---|---|
| `/` | ○ | — | Landing; interactive constant-product curve driven by real `math.ts` |
| `/swap` | ○ | — | Swap surface (client-side quoting) |
| `/pools` | ○ | 2m | Your Liquidity + pool finder + bounded discovery ranking |
| `/pools/[address]` | ƒ | — | Pool detail, add/remove liquidity tabs |
| `/tokens` | ○ | 2m | Token explorer, prices in ETH |
| `/token/[address]` | ƒ | — | Token detail + its WETH pool |
| `/analytics` | ○ | 30s | Chain/protocol metrics + liquidity distribution |
| `/dashboard` | ○ | — | Portfolio, balances, LP positions |
| `/docs` | ○ | — | Overview, architecture, data availability |
| `/docs/contracts` | ○ | — | Verified addresses, both networks |
| `/docs/integration` | ○ | — | Code reference for the service layer |
| `/_not-found` | ○ | — | `app/not-found.tsx` |
| `/icon` | ○ | — | Generated favicon (`next/og`) |
| `/opengraph-image` | ○ | — | Generated 1200×630 OG image |
| `/robots.txt` | ○ | — | Disallows `/pools/`, `/token/`, `/dashboard` |
| `/sitemap.xml` | ○ | — | Stable surfaces only |

`/analytics` shows 30s because `fetchChainStatus` uses `unstable_cache({revalidate: 30})`
and Next takes the minimum; the expensive pool scan is still cached separately (§10).

There is intentionally **no** `/pools/new` route — creating a pool happens inline in the
pool finder when a pair has no pool. No dangling links to it exist.

---

## 3. Major features implemented

**Swap** — token selector with onchain metadata import, debounced quoting (300ms),
two-hop routing (direct pair vs WETH-bridged, best wins), router-confirmed `amountOut`,
price impact, minimum received, network fee estimate, route display, slippage + deadline
controls, high-impact (≥15%) explicit acknowledgement, approval flow, transaction dialog.

**Pools** — bounded factory scan ranked by ETH liquidity, CREATE2 pool finder resolving
*any* pair, pool detail with live reserves/supply/position, add liquidity (ratio-enforced
for existing pools, free for new pools), remove liquidity with percentage slider,
ETH↔WETH substitution toggle.

**Tokens** — explorer listing aggregated per token (liquidity summed across pools, price
from deepest pool), token detail with contract address/copy/explorer, pool link.

**Analytics** — real chain metrics (pairs created, scanned liquidity, latest block,
chain ID), liquidity distribution bars, top tokens. No timeframe selector by design —
there is no history behind it, so a selector would be non-functional UI.

**Dashboard** — portfolio value in ETH, token balances priced from pools, LP positions,
explicit notes on why transactions and claimable fees are absent.

**Cross-cutting** — ⌘K/Ctrl-K global search that resolves an address onchain to
pool/token/contract/account (pools proven by `pair.factory()` matching the configured
factory), transaction state machine, error classifier mapping wallet/RPC/revert errors to
glossary copy, English-only copy glossary as single source of truth, skeletons and empty
states everywhere, reduced-motion support, focus trapping in dialogs, mobile layouts.

---

## 4. Files and directories

### Pre-existing foundation — reused **unmodified**
`lib/copy.ts`, `lib/errors.ts`, `lib/errors.test.ts`, `lib/transactions/machine.ts`,
`lib/transactions/machine.test.ts`, `services/liquidity/types.ts`,
`services/liquidity/uniswap-v2/math.ts`, `.../math.test.ts`, `.../revert-reasons.ts`

### Pre-existing foundation — **modified**
| File | Change |
|---|---|
| `config/chains.ts` | Added verified Uniswap v2 deployment per network (`uniswapV2: {factory, router} \| null`), PublicNode default RPC + `rpcUrls.robinhood`, `DEFAULT_NETWORK = "mainnet"` |
| `config/resolve.ts` | Env override now falls back to verified constants; `ContractConfig.source: "verified" \| "env"`; added `isUniswapV2Available()` |
| `config/resolve.test.ts` | Rewritten for the above |
| `lib/format.ts` | Added `formatNumber()`, `formatPrice()` |
| `lib/format.test.ts` | Added coverage for both |
| `types/web3.ts` | Now re-exports `Address`/`Hash`/`Hex` from viem |
| `.env.example` | Documented `POOLIX_POOL_SCAN_WINDOW`, `NEXT_PUBLIC_SITE_URL`, RPC guidance |
| `HANDOFF.md` | Added "Resolved 2026-09-17" section with all verification outcomes |

### Created
```
app/                  16 routes (§2) + layout, providers, error, not-found,
                      icon, opengraph-image, robots, sitemap, 3 loading.tsx
components/
  analytics/          liquidity-distribution
  brand/              poolix-mark
  dashboard/          portfolio
  docs/               code-block, doc-nav
  landing/            liquidity-curve
  layout/             site-header, site-footer
  pools/              add-liquidity, remove-liquidity, pool-detail, pool-finder,
                      discovered-pools, your-liquidity, pair-badge
  search/             global-search
  swap/               swap-card, currency-input, swap-details, slippage-control,
                      token-select
  tokens/             token-detail, token-table, token-search
  transaction/        transaction-dialog
  ui/                 button, dialog, dropdown, info-tip, notice, page-header,
                      skeleton, stat
  wallet/             connect-wallet
hooks/                use-currency-balance, use-debounced-value, use-liquidity-source,
                      use-lp-positions, use-mounted, use-network-fee, use-pool,
                      use-portfolio, use-swap-quote, use-transaction-flow,
                      use-token-list, use-wallet-status
lib/                  amounts(+test), navigation, token-storage, utils, wagmi
services/
  abis/               uniswap-v2
  chain/              status               (server-only)
  liquidity/uniswap-v2/  adapter, pair(+test), liquidity(+test)
  pools/              pool, discovery (server-only), pricing(+test)
  search/             resolve
  tokens/             currency, metadata, listing(+test)
scripts/              verify-deployments.ts
app/globals.css       Poolix design tokens (dark-only)
README.md             Rewritten
.claude/launch.json   Dev server config for the preview tool
```

Unused create-next-app leftovers still present: `public/{file,globe,next,vercel,window}.svg`,
`app/favicon.ico` (superseded by `app/icon.tsx`). Harmless; safe to delete.

---

## 5. Robinhood Chain configuration

Single source of truth: `config/chains.ts`. Chain ID, explorer, WETH, Permit2, L2
Multicall and the Uniswap v2 deployment are **constants in code, not env vars** — a
mistyped address in an env file is a silent misconfiguration that routes funds wrongly.
Env selects the network and holds only per-deployment values.

`config/poolix.ts` exports the resolved `poolixConfig` using literal `process.env.*`
references so Next.js can inline them. `lib/wagmi.ts` builds the viem chain + wagmi
config from it.

---

## 6. Mainnet / testnet configuration

| | Mainnet | Testnet |
|---|---|---|
| Chain ID | **4663** | **46630** |
| Native | ETH, 18dp | ETH, 18dp |
| Explorer | `https://robinhoodchain.blockscout.com` | `https://explorer.testnet.chain.robinhood.com` |
| Uniswap v2 | Deployed | **Not deployed** (`uniswapV2: null`) |
| Default? | **Yes** | Opt-in |

Select with `NEXT_PUBLIC_POOLIX_NETWORK=mainnet|testnet` (default `mainnet`).

**Why mainnet is the default:** Uniswap has no 46630 deployment, so a testnet default
made Swap, Pools and Analytics all render "Contract Not Configured" out of the box. On
testnet those surfaces still degrade correctly and say so. Reads are free and safe; only
a user-signed transaction spends funds.

---

## 7. RPC configuration — and why PublicNode

| Network | Default (`rpcUrls.default`) | Robinhood official (`rpcUrls.robinhood`) |
|---|---|---|
| Mainnet | `https://robinhood-rpc.publicnode.com` | `https://rpc.mainnet.chain.robinhood.com` |
| Testnet | `https://robinhood-sepolia-rpc.publicnode.com` | `https://rpc.testnet.chain.robinhood.com` |

**Why PublicNode is the default:** on the build machine, `*.chain.robinhood.com` (docs
*and* both RPC endpoints) resolves to `202.62.8.232/233` — an ISP block page, not
Robinhood. Mainnet times out; testnet fails TLS. Robinhood's endpoints are also
rate-limited and documented as not production-grade. PublicNode was verified to return
chain IDs `0x1237` (4663) and `0xb626` (46630), and all onchain verification was run
through it. Robinhood's endpoints remain in config under `rpcUrls.robinhood` and are
documented in `/docs`.

Overrides:
- `NEXT_PUBLIC_RPC_URL` — browser RPC. Validated: https required (http only for
  localhost). **Never** put a keyed URL here; it is public to every visitor.
- `RPC_URL` — server-only, used by `services/pools/discovery.ts` and
  `services/chain/status.ts`. This is where a keyed provider belongs.

Transport uses JSON-RPC request batching (`http(url, { batch: { wait: 16 }, retryCount: 2 })`)
— **not** a multicall contract (see §9).

---

## 8. Verified contract addresses currently configured

All confirmed onchain; `npm run verify:chain` re-runs every assertion (30/30 passing at
checkpoint time).

### Mainnet (4663)
| Contract | Address |
|---|---|
| WETH | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |
| L2 Multicall | `0x2cAC2D899eCC914d704FeaAE33ac1bF36277DaD1` |
| UniswapV2Factory | `0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f` |
| UniswapV2Router02 | `0x89e5DB8B5aA49aA85AC63f691524311AEB649eba` |

### Testnet (46630)
| Contract | Address |
|---|---|
| WETH | `0x7943e237c7F95DA44E0301572D358911207852Fa` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |
| L2 Multicall | `0xa432504b6F04Cafe775b09D8AA92e8dbe41Ec7a8` |
| Uniswap v2 | **none** |

### What was actually proven
- `router.factory()` → the factory above; `router.WETH()` → the WETH above
- Both verified source on Blockscout under canonical names (`UniswapV2Router02`,
  `UniswapV2Factory`); factory held ~43.7k pairs, router ~4.6M txs
- CREATE2 derivation with canonical init code hash
  `0x96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f` reproduces live
  pair addresses → `factory.getPair` is never needed (pinned in `pair.test.ts` with three
  live mainnet pairs as fixtures)
- `router.getAmountsOut` matched `math.ts` **exactly** on every sampled amount across
  four live pairs → deployed fee is canonical 997/1000
- Mainnet WETH `name()` is literally `"WETH"` (not "Wrapped Ether") — checked, not assumed
- `factory.feeTo()` is set (protocol fee is on), so `liquidityMinted` previews are
  estimates, as its docstring already notes

---

## 9. Unverified / missing contract information

| Item | Status |
|---|---|
| Uniswap v3 / v4 / Universal Router addresses | **Not looked up, not configured.** Only v2 is integrated. |
| Chainlink price feeds | **Not wired in.** No verified USD feed → no USD anywhere. |
| `factory.feeToSetter()` | Reverts on this deployment. Not used by Poolix; unexplained but harmless. |
| L2 Multicall exact build | Confirmed **Multicall2** behaviour (`aggregate`, `tryAggregate`, `getEthBalance`; **no `aggregate3`**). Deliberately **not** placed in viem's `multicall3` slot, where it would revert. `Multicall3.getBlockNumber()` disagrees with `eth_blockNumber` by a few blocks — node lag, not a different chain. |
| Stock tokens (ERC-8056) | Not implemented. `HANDOFF.md` flags legal review before including them. |
| Poolix's own contracts | None written. No `contracts/` directory exists. |

---

## 10. Uniswap integration status

**Only Uniswap v2, mainnet only.** Behind `LiquiditySource` (`services/liquidity/types.ts`),
so the swap UI does not know which protocol quoted it. Adding v3/v4 means adding an
adapter, not changing UI. Liquidity *management* stays source-specific by design.

- `services/liquidity/uniswap-v2/adapter.ts` — `getAvailability`, `quoteExactIn`, `buildSwap`
- `services/liquidity/uniswap-v2/liquidity.ts` — `buildAddLiquidity`, `buildRemoveLiquidity`
- `services/liquidity/uniswap-v2/pair.ts` — CREATE2 derivation, token sorting, reserve orientation

Routing: direct pair and WETH-bridged path (max 2 hops) are both priced locally from
reserves, the better wins, then the **router** prices the winner — that router number is
what the user sees. No route → `null`, never a fabricated quote.

Ecosystem projects on this chain already trade via v3/v4, so v2-only quotes may be worse
than the Uniswap interface for some pairs. This is a known product gap, not a bug.

---

## 11. Swap execution status

**Read path: verified live.** Quoting confirmed end-to-end in the browser against
mainnet — 0.01 ETH → SMK2 returned 0.08557725, price impact 4.54%, minimum received
0.085149 at 0.5% slippage, all matching the router exactly.

**Write path: implemented but NEVER exercised with a real signed transaction.** No funded
wallet was available. This is the single biggest untested area.

Flow (`hooks/use-transaction-flow.ts`, shared by swap / add / remove liquidity):
1. `PREPARE`
2. Approvals for outstanding allowances only. Approves the **exact amount** (never
   unlimited). If a non-zero allowance exists it is cleared to 0 first (USDT-style
   tokens). With multiple approvals only the final one is tracked by the state machine.
3. `eth_call` **simulation before** prompting the wallet, so reverts surface their real
   reason (slippage / expired deadline / insufficient liquidity) via
   `uniswapV2RevertReasons`.
4. Send → `SUBMITTED` → wait for receipt → `CONFIRMED` / `REVERTED`.
5. Every branch reaches a settled state; rejection maps to `REJECTED`.

Router functions wired and selector-asserted in tests: `swapExactETHForTokens`
(`0x7ff36ab5`), `swapExactTokensForETH`, `swapExactTokensForTokens`, `addLiquidity`
(`0xe8e33700`), `addLiquidityETH` (`0xf305d719`), `removeLiquidity` (`0xbaa2abde`),
`removeLiquidityETH` (`0x02751cec`).

Not implemented: fee-on-transfer token variants
(`swapExactTokensForTokensSupportingFeeOnTransferTokens` etc.). Such tokens will revert.

---

## 12. Analytics and data limitations

Root cause, probed directly: **the free PublicNode tier rejects archive queries.**
`eth_getLogs` returns `"Archive requests require a personal token"` for *any* block range,
including 1,000 blocks. Separately it **429s after roughly eight batched requests**.

Consequences, all rendered as `--` with an on-page explanation, never estimated:

| Metric | Why unavailable |
|---|---|
| TVL in USD | No verified price feed |
| Volume 24H / Fees 24H / APR | Needs swap history (archive) |
| Holders | Needs a transfer index |
| Active users / Transactions | Needs a transaction index |
| Transaction history (dashboard) | Same |
| Claimable fees | N/A by protocol design — v2 fees accrue into reserves, not as a claim |

What **is** real: reserves, LP supply, positions, balances, quotes, token metadata, and
prices as the pool-implied mid price **denominated in ETH** (`services/pools/pricing.ts`).

Pool discovery (`services/pools/discovery.ts`) is bounded by design:
- Window: newest `POOLIX_POOL_SCAN_WINDOW` pairs (default **300**) of ~43.8k
- Paced: batches of 40, 120ms apart, backoff on 429, max 3 attempts
- Hard budget: **20s** (+5s for metadata), then returns partial with a truthful `scanned` count
- Dust filter: pairs under `MIN_WETH_RESERVE` (0.0001 ETH) excluded as untradeable
- Cache: in-process, **300s on success, 20s on failure** (so a throttled scan recovers
  fast instead of pinning an empty page for 5 minutes)
- Page-level: `revalidate = 120` on `/pools`, `/tokens`, `/analytics`

The UI states its own coverage ("Scanned 300 of 43,780 pairs") and the pool finder
resolves any pair regardless via CREATE2.

---

## 13–16. Gate status (all re-confirmed at checkpoint time)

| Gate | Command | Result |
|---|---|---|
| Typecheck | `npm run typecheck` | **PASS** — `tsc --noEmit`, strict + `noUncheckedIndexedAccess` + `noUnusedLocals`/`noUnusedParameters`, zero errors |
| Lint | `npm run lint` | **PASS** — ESLint flat config (`eslint-config-next` 16.3.5), zero errors, zero warnings |
| Tests | `npm test` | **PASS** — **87 tests, 29 suites, 0 failures** (~2.5s) |
| Build | `npm run build` | **PASS** — 16 routes, Turbopack, no warnings |
| Chain verify | `npm run verify:chain` | **PASS** — 30/30 assertions against mainnet |

Test coverage by area: v2 math (incl. K-invariant checks), CREATE2 pair derivation
(live-pair fixtures), liquidity call builders (selector + arg-order assertions via
`decodeFunctionData`), amount parsing/sanitising, formatters, transaction state machine,
config resolution, pool pricing, token listing aggregation, error classification.

No test runner for components (no jsdom/Playwright configured) — see §17.

---

## 17. Known limitations

1. **Write paths unexercised** — swap, add and remove liquidity have never run a real
   signed transaction (§11).
2. **v2 only** — no v3/v4/UniswapX; quotes may be worse than the Uniswap interface.
3. **No archive data** — volume/fees/APR/holders/history are structurally unavailable on
   the current RPC tier (§12).
4. **No USD anywhere** — no verified price feed; everything is denominated in ETH.
5. **Partial pool ranking** — 300 of ~43.8k pairs, newest-first. The biggest pools may be
   older and therefore missing from the ranking (the finder still reaches them).
6. **No component/E2E tests** — only pure-function unit tests.
7. **No curated token list** — deliberate. Only ETH + WETH are built in; everything else
   is imported by address and stored in `localStorage` per browser. LP position discovery
   is likewise limited to pools pairing WETH with tokens in the user's own list.
8. **No fee-on-transfer support** — such tokens will revert.
9. **No hosted API / SDK** — `/docs` states this explicitly rather than implying otherwise.
10. **Unaudited** — disclosed in the security section of `/docs`. The footer badge states
    maturity (`Robinhood Chain · Beta`), not security.
11. **Not a git repository** — `git` is not installed on this machine; there is no commit
    history. `.gitignore` exists.

---

## 18. Known issues

1. **Robinhood RPC/docs unreachable from this machine** — DNS-blocked (§7). Not a code
   bug; affects local development only.
2. **First uncached page load is slow** — `/pools`, `/tokens`, `/analytics` take ~9–12s
   when the scan cache is cold. `loading.tsx` streams a skeleton meanwhile. Subsequent
   loads are ~50ms–1.8s.
3. **Scan can return empty under throttling** — the page then shows an honest empty state
   explaining the throttle, and retries after 20s.
4. **Blockscout is behind a Cloudflare challenge** — `curl`/`WebFetch` get the JS
   challenge page; a real browser passes. Only affects manual inspection, not the app.
5. **Stale dev-server console errors after heavy HMR** — referenced exports that do exist.
   Cleared by `rm -rf .next/dev` and restarting. Production build is unaffected and is the
   authoritative check.
6. **`factory.feeToSetter()` reverts** on this deployment — unexplained, unused.
7. **Leftover create-next-app assets** — `public/*.svg`, `app/favicon.ico` unused.

---

## 19. Exact next recommended development step

**Exercise the write path end-to-end on mainnet with a small funded wallet.**

This is the only major code path that has never run for real, and it is the one where a
defect costs users money. Do this before any new feature work.

Concretely:

1. Fund a throwaway wallet with a small amount of ETH on chain 4663 (a few dollars is
   enough — the sampled pools are small).
2. `npm run dev`, connect the wallet, confirm the header shows the address and no
   "Wrong Network" state.
3. **Native→token swap** (no approval path): ETH → a token from `/tokens`, ~0.001 ETH.
   Verify: simulation passes, wallet prompt appears once, dialog progresses
   `Confirming → Pending → Transaction Confirmed`, the explorer link resolves, and the
   received amount is ≥ the displayed Minimum Received.
4. **Token→native swap** (exercises the approval path): swap the token back. Verify the
   approval is for the **exact amount** (check the wallet prompt), that the dialog shows
   `Awaiting Approval → Approving → Approved → Confirming`, and that re-running with an
   existing allowance correctly **skips** approval.
5. **Add liquidity** on the same pair, then **remove 25%** and **remove 100%**. Verify
   `removeLiquidity` requires the LP-token approval to the router, that received amounts
   match the preview within slippage, and that 100% leaves no dust.
6. **Rejection and revert handling**: reject a wallet prompt (expect `Transaction
   Rejected`, not a hung spinner), and set slippage to 0.01% on a moving pair (expect the
   simulation to catch it and report **Price Moved**, not an opaque failure).

Record the resulting tx hashes in `HANDOFF.md` as the verification record.

### Runners-up, in priority order

1. **Set `RPC_URL` to a keyed provider** (Alchemy/QuickNode/dRPC all list Robinhood
   Chain). Single highest-leverage config change: unlocks archive queries → real volume,
   fees and APR, and a much wider pool scan. Most `--` values in §12 become computable.
2. **Uniswap v3 adapter** behind the existing `LiquiditySource` interface — improves quote
   quality with no UI change. Look up official v3 addresses for 4663 and extend
   `LiquiditySourceId`.
3. **Component/E2E tests** (Playwright) for the swap and liquidity flows, to lock in
   whatever step 1 verifies.
4. **Verified USD pricing** via Chainlink feeds
   (`https://docs.robinhood.com/chain/oracles-and-price-feeds`), with staleness and
   sequencer-uptime checks. Unlocks TVL.
5. **Housekeeping** — `git init`; delete unused `public/*.svg` and `app/favicon.ico`.
