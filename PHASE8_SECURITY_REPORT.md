# Poolix Phase 8 — security report

Final engineering phase. Security and production hardening of the Phase 7 baseline, with
no change to any validated analytics behaviour.

Wording in this document is deliberate. **Verified** means asserted by code that runs in
the suite. **Tested** means exercised and observed. **Not tested** means exactly that.
**Manual verification required** means no automated check can settle it. Poolix is not
described as "secure" or "production ready" without qualification, because neither is a
property a codebase can hold on its own.

---

## 1. Phase 8 status

Complete. 18 of 18 gates pass, including the new `verify:security`. Two findings were
introduced *by* the hardening itself and fixed before completion (§5).

No analytics definition, methodology, contract address, chain id or Phase 7 storage
behaviour was changed.

## 2. Audit scope

Full read-only audit performed before any edit, recorded in
[SECURITY_AUDIT.md](SECURITY_AUDIT.md). Covered: every environment variable; every wallet
and contract write path; every contract read; every RPC and HyperSync endpoint; every route
handler; every external fetch; every dynamic route parameter; all user-controlled input; all
filesystem access; all logging and error handling; all calldata construction; all
address/token/pool parsing; all HTML and markdown rendering; all third-party scripts; and
the dependency tree.

Notable scope facts, each of which removes a class of risk rather than mitigating it:

- **No API route handlers exist.** No `app/api`, no `route.ts`. CORS, method validation,
  body-size limits, origin reflection and SSRF-proxy concerns are not applicable — recorded
  rather than silently skipped.
- **No `dangerouslySetInnerHTML`, `innerHTML`, `eval`, `new Function`, `document.write`,
  `<iframe>`, WebSocket or third-party script** anywhere in production source.
- **`npm audit`: 0 vulnerabilities.**

## 3–5. Findings, severity and fixes

### CRITICAL — none found.

### HIGH

| ID | Finding | Fix | Status |
|---|---|---|---|
| **H-1** | `next.config.ts` was empty: no CSP, no `X-Content-Type-Options`, no `Referrer-Policy`, no `Permissions-Policy`, no HSTS, no frame-ancestors. Framing, MIME sniffing and referrer leakage to the block explorer were all possible. | Full header set in `config/security-headers.ts`, built from what the app actually loads. | **Fixed, tested in a browser** |
| **H-2** | `NEXT_PUBLIC_RPC_URL` validated only the protocol. An RPC URL carrying an API key — as userinfo, a query parameter, or a path segment, which is how most commercial providers issue them — passed and was then inlined into the client bundle. | `resolveRpcUrl` now refuses a credentialed URL at startup, naming the *shape* and never the value. | **Fixed, verified** |

### MEDIUM

| ID | Finding | Fix | Status |
|---|---|---|---|
| **M-1** | `redact()` could not terminate. `while (output.includes(value)) output = output.replace(value, label)` loops for ever when the secret is a substring of its own label — an infinite loop on the logging path, reached by every worker warning. | Replaced with `split/join`: one pass, never re-examines what it wrote. | **Fixed, verified** |
| **M-2** | No timeout on any outbound request. Node's `fetch` has no default, and the caller's deadline is only checked *between* batches, so one stalled socket held a tick — and a page render — open indefinitely. | `AbortSignal.timeout` on all four call sites: RPC 10 s/30 s, HyperSync 10 s/45 s. | **Fixed, verified** |
| **M-3** | Token `symbol`/`name` rendered unsanitized: unbounded length, control characters, zero-width characters and bidi overrides. Not XSS (React escapes; no raw-HTML sink exists) but a working impersonation and layout-destruction primitive on a chain where anyone can deploy a pair. | `lib/token-text.ts`: strips control, zero-width and bidi characters, collapses whitespace, caps length with a visible ellipsis, returns `null` when nothing visible survives. | **Fixed, verified** |
| **M-4** | `decimals` accepted up to 255. A valid `uint8` answer of 255 flows into `parseUnits`, producing amounts wrong by ~10²³⁷ and presented as balances. | `MAX_TOKEN_DECIMALS = 36`; beyond it the token is refused, as one with no `decimals()` already was. | **Fixed, verified** |
| **M-5** | The transaction deadline was bounded only in the UI component. `buildSwap` encoded any `bigint` unchecked — unlike slippage, which is re-asserted in the math layer. | `checkDeadline` in the flow: must be positive, still ahead, and ≤ 180 minutes. The `2^48` gas-estimation sentinel is now explicitly rejected. | **Fixed, verified** |
| **M-6** | The signing path trusted its caller for `call.to`, `call.data`, and each approval's `token`/`spender`. Correct today by construction, not by check. | `checkTransactionIntent` and `checkApproval` run before the wallet is opened; every caller must now declare `allowedTargets`. | **Fixed, verified** |

### LOW — all seven fixed

`sanitizeAmountInput` length cap (80); `POOLIX_POOL_SCAN_WINDOW` ceiling (2,000); silent
storage write failures now logged by errno code (not path); filesystem path containment
assertion added beyond the key allowlist; stale route-param reflection and
`NEXT_PUBLIC_SITE_URL` default documented in the production checklist; invalid-contract env
value retained only for display.

### INFORMATIONAL

Stale comments in `services/chain/rpc.ts` and `lib/wagmi.ts` asserted the chain's Multicall
had no `aggregate3`, contradicting Phase 6's verified finding. Corrected — a comment that
contradicts verified behaviour is how a fixed problem gets reintroduced.

### Two findings introduced by the hardening, and fixed

Recorded because they are the honest record of the work:

1. **Tab and newline were deleted, not collapsed.** The first version of `token-text.ts`
   stripped all control characters before collapsing whitespace, so `"Wrapped\tEther"`
   became `"WrappedEther"` — the same visual mangling the file exists to prevent, arrived
   at from the other direction. Caught by a test. Whitespace controls now become a space
   first.
2. **`verify:security` reported its own documentation as findings.** Five checks matched
   the words inside comments — including comments stating that those very things are
   absent. Fixed by stripping comments before pattern-matching, and by replacing the
   `unsafe-eval` text search with a check on the *generated* policy. A security gate that
   cries wolf is how the next real finding gets dismissed.

## 6. Remaining limitations

- **Multi-instance storage.** Unchanged and still true: *local filesystem persistence is
  development-safe but not multi-instance durable production storage.* Two instances cannot
  detect each other; the later write wins. Run one instance. The `Storage` interface is
  shaped for a shared backend, and `lease.ts` is scaffolding for it — **not** a distributed
  lock, and not presented as one.
- **`script-src` retains `'unsafe-inline'` in production.** Next's App Router streams its
  payload through inline `<script>` blocks; removing this requires a per-request nonce,
  which would make every route dynamic and end the static/ISR model the whole analytics
  design rests on. Hash allowlisting is not viable — the payload differs per page and per
  build. What makes the trade acceptable is that the injection surface is *empty*, not
  merely small (§2). **`'unsafe-eval'` is never granted in production.**
- **`style-src` retains `'unsafe-inline'`.** Motion computes `style=""` attributes at
  runtime — 195 on the analytics page alone. Inline style affects layout, not execution.
- **Deployed headers cannot be asserted from here.** A CDN or reverse proxy can strip or
  override them. **Manual verification required** — the `curl` command is in the production
  checklist.
- **Real-wallet behaviour is not automated.** See §8 and §14.
- **Rate limits are shared.** HyperSync throttles bursts; verifiers must run sequentially.

## 7. Secret handling

**Verified.** The decisive check runs in `verify:security`: the configured
`ENVIO_API_TOKEN`'s literal value is searched for in **every file the browser is served**.
Result: **0 hits across 49 client bundle files.** The token is never printed by any script.

- Every variable is classified SERVER_ONLY / PUBLIC / BUILD_TIME_ONLY / OPTIONAL in
  [SECURITY_AUDIT.md](SECURITY_AUDIT.md) and the production checklist.
- No credential uses `NEXT_PUBLIC_`. A `NEXT_PUBLIC_*` variable *named* like a secret fails
  the gate regardless of its value.
- `NEXT_PUBLIC_ENVIO_API_TOKEN` appears nowhere. The abandoned Alchemy dependency appears
  nowhere. PublicNode remains the primary RPC.
- No private key, seed phrase or signing secret exists in source, configuration or
  persisted state. `verify:infrastructure` separately asserts no dataset contains
  credential-shaped material.
- Every logged value passes through `redact` at the boundary, not at call sites.
- Storage write errors log the errno code, never the filesystem path.

## 8. Wallet security

**Verified by code and 28 dedicated tests:** chain pinned to 4663 on every send; exact-amount
approvals with `maxUint256` refused and absent from the entire codebase; zero-clear first for
USDT-style tokens; simulation before the wallet prompt, with failure blocking the send;
destination restricted to declared `allowedTargets`; deadline positive, future, ≤ 180 min;
calldata from typed ABIs only; bigint-only amounts; bounded slippage; hash surfaced only
after submission; no blind retry; nothing auto-signs or auto-submits.

**Manual verification required**, and not claimed as done: whether a specific wallet's
confirmation screen shows the correct spender and amount; behaviour on chain switch,
mid-flight disconnect, refresh during pending, and RPC failure during pending. A wallet's
confirmation screen is the last thing between a user and a signature, and no test can read
it. See [docs/PHASE8_WALLET_SECURITY_CHECKLIST.md](docs/PHASE8_WALLET_SECURITY_CHECKLIST.md).

**No real transaction was executed by this work.** No private key was requested, generated
or handled. No transaction hash was fabricated. No contract address was changed.

## 9. RPC and HyperSync security

**Verified.** Endpoints are fixed server-side constants; no user input reaches a URL, host
or method name. No proxy or forwarding primitive exists, so there is no SSRF surface. The
server RPC helper issues only `eth_call` and `eth_blockNumber` — asserted by extracting the
method names from source and comparing against an allowlist. Retries bounded (3 attempts;
4-element backoff). Paging cannot loop. Both modules are `server-only`. Every request now
carries a timeout. Query ranges are set by the caller, never by a browser request.

## 10. HTTP security

**Verified in a browser against both a development and a production server.** Production
response headers observed live:

```
content-security-policy: default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline';
  img-src 'self' data:; font-src 'self'; connect-src 'self' https://robinhood-rpc.publicnode.com
  https://robinhood-sepolia-rpc.publicnode.com; object-src 'none'; frame-src 'none';
  frame-ancestors 'none'; form-action 'self'; base-uri 'self'; worker-src 'self' blob:;
  manifest-src 'self'; upgrade-insecure-requests
strict-transport-security: max-age=63072000; includeSubDomains; preload
referrer-policy: strict-origin-when-cross-origin
x-content-type-options: nosniff
x-frame-options: DENY
cross-origin-opener-policy: same-origin
permissions-policy: accelerometer=(), camera=(), geolocation=(), microphone=(), payment=(), usb=(), …
x-powered-by: (absent)
```

`/swap`, `/analytics`, `/pools` and `/portfolio` were loaded under this policy with **zero
console errors**, and `/analytics` rendered its full dataset (TVL, volume series, chart).

Two CSP breakages were found **by testing rather than by assumption**, and both were fixed
as development-only grants that never reach production: React's development build requires
`eval()` (its own error states it never does so in production), and Next's dev server needs
`ws://localhost:*` for hot-module reload. `verify:security` asserts the production policy
contains neither.

## 11. Filesystem security

**Verified.** Storage keys come from a closed character allowlist rejecting `/`, `\`, `..`
and null bytes; 13 traversal attempts are tested. A second, independent containment check
now resolves the final path and refuses anything outside the cache root — belt and braces,
because the two defences fail differently. Writes remain temp-file-plus-rename inside the
cache directory. Only `services/storage/storage.ts` performs runtime filesystem I/O, and
that is asserted repo-wide. No rendered page contains a filesystem path (15 pages scanned).
**Existing dataset filenames are unchanged and no state was invalidated.**

## 12. Dependency audit

`npm audit`: **0 vulnerabilities** — no runtime, development-only or transitive advisory.
**No dependency was added, upgraded or downgraded.** No framework version was changed to
make the audit look clean, because nothing needed changing.

## 13. Recovery behaviour

Unchanged from Phase 7 and re-verified: corrupt cache rebuilds; wrong schema version
rebuilds; a **newer** version is never migrated downward; wrong chain id is rejected; a
partial dataset is never published as complete; a failed request never becomes zero data;
incomplete holders render as "rebuilding" rather than a number; historical coverage stays
contiguous; checkpoints cannot move backwards; bucket boundaries cannot invert; duplicate
event keys stay rejected; pool creation cannot predate `PairCreated`; the token and holder
universes stay synchronised. All asserted by `verify:infrastructure` and the existing gates.
See [PHASE7_RECOVERY.md](PHASE7_RECOVERY.md).

## 14. Manual launch checks

Not done by this work, and required before mainnet:

1. The full wallet checklist, by a human with a funded wallet —
   [docs/PHASE8_WALLET_SECURITY_CHECKLIST.md](docs/PHASE8_WALLET_SECURITY_CHECKLIST.md).
2. Header verification against the **deployed** origin, since a CDN can strip them.
3. The production configuration checklist —
   [docs/PHASE8_PRODUCTION_CHECKLIST.md](docs/PHASE8_PRODUCTION_CHECKLIST.md).
4. A recovery rehearsal against a disposable copy of the cache.

## 15. Final regression results

Run sequentially. **18 of 18 pass.**

| # | Gate | Result |
|---|---|---|
| 1 | `npm test` | PASS — **716 tests**, 138 suites, 0 failures |
| 2 | `typecheck` | PASS |
| 3 | `lint` | PASS |
| 4 | `build` | PASS — 18/18 pages |
| 5 | `verify:security` | PASS — **new gate**; token in 0 of 49 client bundles |
| 6 | `verify:chain` | PASS — 30 checks |
| 7 | `verify:swaps` | PASS |
| 8 | `verify:transactions` | PASS |
| 9 | `verify:tvl` | PASS |
| 10 | `verify:holders` | PASS — drift 5, tolerance 43; 72,213/72,213 confirmed |
| 11 | `verify:tokens` | PASS — drift 0 |
| 12 | `verify:historical` | PASS |
| 13 | `verify:liquidity-history` | PASS — 168/168, 720/720 |
| 14 | `verify:apr` | PASS — 100% both windows |
| 15 | `verify:pool-analytics` | PASS — creation blocks match the factory |
| 16 | `verify:dashboard` | PASS |
| 17 | `verify:portfolio` | PASS — share math exercised against a live pool |
| 18 | `verify:infrastructure` | PASS — overall health `healthy`, all 8 datasets |

**No verifier was weakened, no tolerance raised and no test deleted.** Three verifiers were
made *stricter* during this phase: `verify:infrastructure` gained a real `history` boundary
invariant and a working secret check (its previous summary line could never fail), and
`verify:security` is new.

Two gates needed state prepared first, as documented rather than as a workaround: the
hourly series were ticked before the 100%-coverage gates (an hour boundary passes during
the long holder run), and the token/holder universes were paired before
`verify:infrastructure`.

One diagnosis worth recording: mid-run, pool discovery began returning zero pools and
scanning only 200 of 300 pairs. That was **endpoint throttling from this session's own
sustained load**, not a regression from the new request timeouts — confirmed by letting the
endpoint rest and re-running, which restored 300/300 and a normal pool count.
