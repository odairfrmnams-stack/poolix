# Poolix security audit

Phase 8, Task 1. Read-only audit of the Phase 7 baseline, performed before any code was
changed. Every finding below was reached by reading the code it names.

Nothing here is speculative: where a surface is safe, the reason is stated rather than the
surface being omitted. Where a risk is real but unexploitable today, it is recorded at the
severity its consequence warrants, not the severity its scariness suggests.

---

## Scope

| Surface | Present? | Notes |
|---|---|---|
| API route handlers (`route.ts`) | **none** | No `app/api`. Removes CORS, method, body-size, SSRF-proxy and origin-reflection classes entirely. |
| Dynamic routes | 2 | `/pools/[address]`, `/token/[address]` |
| Server-rendered pages | 16 | 14 static/ISR, 2 dynamic |
| Contract write paths | 3 | swap, add liquidity, remove liquidity — all through one flow |
| Contract read paths | many | all through viem/wagmi or the server RPC helper |
| External fetch destinations | 3 | PublicNode RPC, HyperSync query, HyperSync height |
| Third-party scripts | **none** | no analytics, no tag managers, no CDN scripts |
| `dangerouslySetInnerHTML` / `innerHTML` / `eval` / `new Function` | **none** | verified by search |
| `<iframe>` / WebSocket | **none** | verified by search |
| Filesystem writes | 1 module | `services/storage/storage.ts` only |
| Dependency advisories | **0** | `npm audit` → found 0 vulnerabilities |

---

## Environment variables

| Variable | Class | Reaches browser | Notes |
|---|---|---|---|
| `ENVIO_API_TOKEN` | SERVER_ONLY | no | Read only inside `import "server-only"` modules and scripts |
| `RPC_URL` | SERVER_ONLY / OPTIONAL | no | Server-side override for the read endpoint |
| `POOLIX_POOL_SCAN_WINDOW` | SERVER_ONLY / OPTIONAL | no | Scan sizing — see **L-2** |
| `POOLIX_LOG` | SERVER_ONLY / OPTIONAL | no | Enables debug/info logging |
| `NODE_ENV` | BUILD_TIME_ONLY | yes (by design) | Framework-standard |
| `NEXT_PUBLIC_POOLIX_NETWORK` | PUBLIC | yes | `"testnet" \| "mainnet"`, validated, throws otherwise |
| `NEXT_PUBLIC_RPC_URL` | PUBLIC | yes | **See H-2** |
| `NEXT_PUBLIC_UNISWAP_V2_FACTORY_ADDRESS` | PUBLIC / OPTIONAL | yes | Validated against an address pattern |
| `NEXT_PUBLIC_UNISWAP_V2_ROUTER_ADDRESS` | PUBLIC / OPTIONAL | yes | Validated against an address pattern |
| `NEXT_PUBLIC_SITE_URL` | PUBLIC / OPTIONAL | yes | **See L-6** |

No `NEXT_PUBLIC_*` variable holds a credential. No private key, seed phrase or signing
secret exists anywhere in source, configuration or persisted state. `.env*` is
git-ignored with an explicit `!.env.example` exception, and the example carries no values.

---

## Findings

### CRITICAL

None.

### HIGH

#### H-1 — No HTTP security headers are configured

`next.config.ts` is empty. The application ships with no `Content-Security-Policy`, no
`X-Content-Type-Options`, no `Referrer-Policy`, no `Permissions-Policy`, no
`Strict-Transport-Security` and no frame-ancestors restriction.

Consequence: the app can be framed (clickjacking against the swap button is the realistic
version of this), responses are MIME-sniffable, and full URLs leak in the `Referer` header
to any external origin the user navigates to — including the block explorer.

This is the highest-value finding precisely because the rest of the XSS surface is already
so small: a CSP here is cheap insurance rather than a load-bearing mitigation.

#### H-2 — `NEXT_PUBLIC_RPC_URL` can publish a credentialed endpoint to every visitor

`config/resolve.ts:80` validates the URL's *protocol* but nothing else. An RPC URL
carrying an API key — as a path segment, a query parameter, or HTTP userinfo, which is how
most commercial RPC providers issue them — passes validation and is then inlined by Next
into the client bundle, because the variable is `NEXT_PUBLIC_`.

The variable's name invites exactly this mistake. Nothing in the code warns against it.

Not exploitable in the current deployment (PublicNode needs no credential), which is why
this is HIGH rather than CRITICAL — the defect is that the guardrail is missing, not that
a secret is currently leaking.

### MEDIUM

#### M-1 — `redact()` can hang the server

`services/storage/keys.ts:92`

```ts
while (output.includes(value)) output = output.replace(value, `[redacted ${name}]`);
```

When the secret's value is a substring of its own replacement label, the loop never
terminates. Concretely: an environment variable named `SECRET_KEY_VALUE_THING` whose value
is `KEY_VALUE` produces the label `[redacted SECRET_KEY_VALUE_THING]`, which still contains
`KEY_VALUE`. The condition stays true forever.

Consequence: an infinite loop inside the logging path — which is reached on every worker
warning — pinning a CPU and hanging the request. Contrived to trigger deliberately, trivial
to hit by accident, and the fix is a one-line change to a non-looping replacement.

#### M-2 — No timeout on any outbound request

`services/chain/rpc.ts:50,83` and `services/analytics/hypersync.ts:34,59` all call `fetch`
with no `AbortSignal`. Node's `fetch` has no default timeout, so a connection that opens
and then stalls blocks indefinitely.

The `deadline` in `pacedCalls` does not help: it is only consulted *between* batches, so a
single hung request stalls the tick past its budget and, on a page render, past the route's
own timeout. Retry counts are bounded, but a hang never reaches the retry.

#### M-3 — Token metadata is rendered unsanitized

`services/tokens/metadata.ts:61` returns whatever `symbol()` and `name()` yield, with only
`.trim()` applied. There is no length cap and no character filtering.

This is **not** XSS — React escapes text nodes and the codebase contains no
`dangerouslySetInnerHTML`. The realistic harms are:

- **Impersonation.** A token whose `symbol()` returns `"ETH"`, or which embeds zero-width
  joiners, Unicode bidi overrides (`U+202E`) or Cyrillic homoglyphs, renders in the swap
  card and token tables as a token the user believes they recognise. On a chain where
  anyone can deploy a pair, this is the cheapest attack available.
- **Layout destruction.** A multi-kilobyte symbol breaks every table it appears in.

The audit instruction "do not trust token metadata merely because it came from the chain"
is exactly right: on-chain provenance says a string was published, not that it is honest.

#### M-4 — `decimals` is accepted up to 255

`services/tokens/metadata.ts:56` and `services/pools/discovery.ts:84` accept any `uint8`.
`decimals = 255` is a valid ERC-20 answer and flows straight into `parseUnits`,
`formatUnits` and `sanitizeAmountInput`, producing amounts of ~10²⁵⁵ and a 255-place
decimal input mask. No overflow — the math is bigint — but every figure shown for such a
token is meaningless, and "meaningless number presented as a fact" is the one outcome
Poolix's whole data policy exists to prevent.

#### M-5 — Transaction deadline is bounded only in the UI

`components/swap/slippage-control.tsx:112` clamps the deadline to `0 < minutes <= 180`.
That is the *only* bound. `adapter.ts:179 buildSwap` accepts `deadline: bigint` and encodes
it without checking that it is in the future, finite, or within a sane horizon.

Compare with slippage, which is bounded in the UI **and** re-asserted in the math layer by
`assertBps` (`math.ts:117`). Slippage cannot be smuggled past the UI; the deadline can.

`ESTIMATE_DEADLINE = 2n ** 48n` (`swap-card.tsx:39`) is a far-future value used for gas
estimation. It is not reachable by the send path today — `handleSubmit` rebuilds the call
with a real deadline — but nothing structurally prevents a future refactor from wiring the
estimate call into `flow.execute`.

#### M-6 — The transaction flow does not assert its own targets

`hooks/use-transaction-flow.ts` signs whatever it is handed: `call.to`, `call.data`, and
each approval's `token` and `spender`. Every current caller supplies the configured router,
so this is correct today by construction rather than by check.

For the one code path in Poolix that spends user funds, "correct because all three callers
happen to be right" is weaker than it should be. An assertion at this boundary is the
difference between a bug and a loss.

### LOW

| ID | Finding | Location |
|---|---|---|
| **L-1** | `sanitizeAmountInput` has no input length cap; a pasted 100k-digit string is parsed in full | `lib/amounts.ts:8` |
| **L-2** | `POOLIX_POOL_SCAN_WINDOW` is checked for `> 0` but has no upper bound | `services/pools/discovery.ts:87` |
| **L-3** | `FilesystemStorage.set` swallows write failures with no log, so a read-only volume is silently invisible | `services/storage/storage.ts:89` |
| **L-4** | No final containment assertion after `assertKey` — traversal is blocked by the allowlist alone | `services/storage/storage.ts:68` |
| **L-5** | `generateMetadata` reflects the raw route param into `title`/`description` without validation (escaped by React, so not XSS) | `app/pools/[address]/page.tsx:13`, `app/token/[address]/page.tsx:11` |
| **L-6** | `NEXT_PUBLIC_SITE_URL` silently defaults to `http://localhost:3000`, so production OG images break quietly | `app/layout.tsx:14` |
| **L-7** | `ContractConfig{status:"invalid"}` retains the raw env value for display | `config/resolve.ts:66` |

### INFORMATIONAL

- **I-1** — `services/chain/rpc.ts:11` and `lib/wagmi.ts:11` both state the chain's Multicall
  is a Multicall2 with no `aggregate3`. Phase 6 verified the opposite: Multicall3 is
  deployed at `0xcA11bde05977b3631167028862bE2a173976CA11` and `aggregate3` works. Stale
  comments that contradict verified behaviour are how the next person reintroduces a
  known-fixed problem.
- **I-2** — No API routes exist, so Task 10's checklist is not applicable. Recorded rather
  than silently skipped.
- **I-3** — `npm audit`: 0 vulnerabilities. No major version changes needed.
- **I-4** — Fonts are self-hosted by `next/font`, so no external font origin is required in
  the CSP. The only external host in rendered HTML is the block explorer, and only as
  `<a href>`.

---

## Surfaces verified safe

Each of these was examined and found correct. They are listed so a later reader knows they
were checked rather than missed.

**Wallet and write path**
- `chainId: poolixChain.id` is pinned on every `sendTransactionAsync`, both approval and
  main call (`use-transaction-flow.ts:61,110`).
- Approvals are **exact-amount**. `maxUint256` appears nowhere in the codebase.
- A non-zero existing allowance is cleared to `0` first, for USDT-style tokens
  (`use-transaction-flow.ts:81`).
- Simulation (`publicClient.call`) runs **before** the wallet prompt and before
  `sendTransactionAsync`; a revert throws and is caught, so simulation failure blocks the
  send (`:105–109`).
- The transaction hash is dispatched only after `sendTransactionAsync` resolves — never
  optimistically (`:115`).
- User rejection is classified and lands in a settled `REJECTED` state; there is no retry
  after an uncertain send.
- Calldata is built with `encodeFunctionData` against typed ABIs. No string concatenation
  anywhere in calldata construction.
- Nothing auto-signs or auto-submits; every send originates in a click handler.

**Amount and slippage math**
- All on-chain amounts are `bigint`. No float touches transaction math.
- `parseAmount` returns `null` for empty, malformed or non-positive input and never throws.
- Decimal places beyond the token's `decimals` are truncated, not rounded.
- `assertBps` rejects non-integer, negative and out-of-range slippage in the math layer.
- `applySlippage` cannot produce a negative minimum: `slippageBps <= 5000 < 10000`.
- UI formatting is a separate path and never feeds transaction math.

**RPC and HyperSync**
- Both endpoints are fixed server-side. No user input reaches a URL, a host, or an RPC
  method name. There is no proxy or forwarding primitive, so no SSRF surface.
- The server RPC helper issues only `eth_call` and `eth_blockNumber`.
- Retries are bounded (`MAX_ATTEMPTS = 3`; HyperSync backoff is a fixed 4-element array).
- Paging cannot loop: `next <= cursor` terminates the read.
- `ENVIO_API_TOKEN` is read only inside `server-only` modules and is never logged.

**Route parameters**
- `/pools/[address]` resolves against the already-indexed pool set. An unknown or malformed
  address returns `out-of-scope` — it never becomes a contract call.
- `resolveSearch` identifies a pool by asking the contract for its `factory()` and comparing
  with the configured factory, so a lookalike pair cannot pass itself off as one.
- `fetchTokenMetadata` requires deployed code and a readable `decimals()`, rejecting EOAs
  and non-ERC-20 contracts rather than rendering zeros.

**Storage**
- Storage keys come from a closed character allowlist that rejects `/`, `\`, `..` and null
  bytes. No key is user-derived; every one is a literal plus the configured chain id.
- Writes are temp-file-plus-rename inside the cache directory.
- Schema version and chain id are checked on load; a newer version is never migrated down.

**Errors and logging**
- `classifyError` maps every failure onto a fixed vocabulary in `lib/copy.ts`. Raw error
  text, stack traces and filesystem paths cannot reach the UI through it.
- `app/error.tsx` renders only that vocabulary plus Next's opaque `digest`.
- `formatLog` passes every value through `redact` at the boundary, not at call sites.

---

## What this audit did not cover

- **Real-wallet behaviour.** Everything in the write path was verified by reading code and
  will be verified by tests. Whether a specific wallet renders the approval target
  correctly, and how it behaves on chain switch or mid-flight disconnect, requires a human
  with a funded wallet. Task 18 produces that checklist.
- **Deployed headers.** Header configuration can be asserted in tests; whether a CDN or
  reverse proxy strips or overrides them in the operator's environment cannot.
- **Multi-instance behaviour.** Unchanged from Phase 7 and still a documented limitation:
  local filesystem persistence is development-safe but not multi-instance durable
  production storage.
