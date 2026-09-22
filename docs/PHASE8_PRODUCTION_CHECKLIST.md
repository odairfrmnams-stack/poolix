# Production checklist

What an operator must set, verify and understand before running Poolix in production.

Items marked **operator decision** cannot be settled by this repository — they depend on
where and how you deploy.

---

## Environment

### Server-only — never `NEXT_PUBLIC_`

| Variable | Required | Notes |
|---|---|---|
| `ENVIO_API_TOKEN` | **yes** | HyperSync access. Without it every historical figure reads `--`. |
| `RPC_URL` | no | Server-side read endpoint. Use this — not the public variable — for any endpoint that carries a credential. |
| `POOLIX_POOL_SCAN_WINDOW` | no | Pairs per discovery pass. Default 300, capped at 2,000. |
| `POOLIX_LOG` | no | `1` enables debug/info worker logs. Warnings and errors always emit. |

- [ ] `ENVIO_API_TOKEN` is set in the deployment's secret store, not in a committed file.
- [ ] `.env.local` is **not** committed. (`.gitignore` covers `.env*` with an
      `!.env.example` exception.)
- [ ] No secret is passed as a `NEXT_PUBLIC_*` variable. `verify:security` fails the build
      if one is named like a credential.

### Public — inlined into the browser bundle by design

| Variable | Required | Notes |
|---|---|---|
| `NEXT_PUBLIC_POOLIX_NETWORK` | no | `mainnet` (default) or `testnet`. Anything else throws at startup. |
| `NEXT_PUBLIC_RPC_URL` | no | **Must be a public endpoint.** A credentialed URL is refused at startup — see below. |
| `NEXT_PUBLIC_UNISWAP_V2_FACTORY_ADDRESS` | no | Overrides the verified constant. |
| `NEXT_PUBLIC_UNISWAP_V2_ROUTER_ADDRESS` | no | Overrides the verified constant. |
| `NEXT_PUBLIC_SITE_URL` | **yes in production** | Absolute base for OpenGraph images. Defaults to `http://localhost:3000`, which silently breaks social previews. |

- [ ] `NEXT_PUBLIC_SITE_URL` is set to the real origin.
- [ ] `NEXT_PUBLIC_RPC_URL` is either unset or a public endpoint with no key in the
      userinfo, path or query. Poolix **refuses to start** otherwise, because this value is
      published to every visitor and cannot be un-published once served.

### Chain constants — verify, do not assume

- [ ] Chain ID **4663**
- [ ] WETH `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73`
- [ ] Factory `0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f`
- [ ] Router — confirm against `/docs/contracts` and the explorer
- [ ] Primary RPC `https://robinhood-rpc.publicnode.com` (PublicNode). Robinhood's own
      `*.chain.robinhood.com` endpoints are configured as an alternate and are unreachable
      from some networks.
- [ ] `npm run verify:chain` passes — this reads the deployment on chain rather than
      trusting the constants.

---

## Security

- [ ] `npm run verify:security` passes.
- [ ] `npm audit` reports no runtime vulnerability. **operator decision** whether a
      development-only advisory blocks release.
- [ ] Security headers are served. Confirm on the deployed origin, not just locally — a CDN
      or reverse proxy can strip or override them:

```bash
curl -sI https://YOUR_ORIGIN/ | grep -iE 'content-security-policy|x-content-type|referrer-policy|permissions-policy|strict-transport|x-frame-options'
```

- [ ] The production CSP contains **no `unsafe-eval`**. (Development grants it because
      React's dev build requires it; production must not.)
- [ ] `x-powered-by` is absent.
- [ ] HSTS is present, and you accept its consequences: `includeSubDomains; preload` commits
      every subdomain of the origin to HTTPS for two years. **operator decision** — do not
      enable preload on a domain whose subdomains you do not control.
- [ ] TLS terminates before Poolix. The app sets HSTS but cannot enforce HTTPS itself.
- [ ] Error output carries no stack traces or filesystem paths. Poolix maps every error to
      a fixed vocabulary; confirm your host does not add its own error page that does.

---

## Data

- [ ] `.poolix-cache/` is writable. If it is not, every dataset rebuilds on every tick for
      ever; the symptom is a slow site, and the cause appears only as a `persist` warning in
      the logs.
- [ ] Schema versions match what the build expects — `npm run verify:infrastructure`.
- [ ] A cold start is acceptable to you: historical volume takes **hours** to rebuild from
      empty. Run `npm run bootstrap:history` ahead of cutover, or accept `--` on the
      historical figures until it completes.
- [ ] **Backup recommendation:** back up `.poolix-cache/history-<chain>.json` only. Every
      other dataset rebuilds in minutes. Nothing in the cache is a system of record, so a
      backup buys time, not correctness.
- [ ] You have read [PHASE7_RECOVERY.md](../PHASE7_RECOVERY.md).

### The single-instance limitation

> **Local filesystem persistence is development-safe but not multi-instance durable
> production storage.**

- [ ] Poolix runs as **one instance**. Two instances cannot detect each other: both read,
      both compute, the later write wins, and neither can tell it happened.
- [ ] You understand that on a serverless host the cache is per-instance and does not
      survive a cold start. That costs a rebuild, not accuracy.
- [ ] **Migration path when you need more than one instance:** implement the `Storage`
      interface in `services/storage/storage.ts` against a shared backend that supports
      compare-and-swap, set `supportsCompareAndSwap` to `true`, and wire the leases in
      `services/storage/lease.ts` into the tick path. No analytics module changes. Until
      then, the leases are scaffolding and are not a distributed lock — do not treat them
      as one.

---

## Wallet

- [ ] The router address shown at `/docs/contracts` matches the chain.
- [ ] A real swap has been completed end to end on mainnet by a human following
      [PHASE8_WALLET_SECURITY_CHECKLIST.md](PHASE8_WALLET_SECURITY_CHECKLIST.md).
- [ ] Approval prompts name the router and an exact amount — confirmed by eye, in a wallet.
- [ ] Simulation failure blocks the wallet prompt — confirmed by eye.
- [ ] Rejection, chain switch, refresh-during-pending and RPC-failure paths all settle
      without a duplicate transaction — confirmed on the explorer.
- [ ] Default slippage (0.5%) and deadline (20 min) are appropriate for your users.
      **operator decision.**

---

## Operations

- [ ] Logging: warnings and errors always emit; set `POOLIX_LOG=1` for tick-level detail.
      Every logged value passes through redaction, so no credential reaches the log.
- [ ] Monitoring: `npm run verify:infrastructure` reports per-dataset health
      (`healthy | bootstrapping | stale | incomplete | failed`) and an overall status that
      is the **worst** of them. Run it on a schedule. **operator decision** how to alert.
- [ ] Failure behaviour is understood: a failed request never becomes zero data, a partial
      window is withheld rather than published short, and an incomplete holder snapshot
      renders as "rebuilding" rather than as a number.
- [ ] Rate limits are understood: HyperSync throttles **bursts**, not volume — requests are
      paced ~120 ms apart. Do not run verifiers in parallel or alongside a dev server; they
      contend for the same endpoint.
- [ ] Every outbound request is bounded: RPC 10 s / 30 s, HyperSync 10 s / 45 s, with
      bounded retries and no unbounded backoff.
- [ ] Recovery has been rehearsed at least once against a disposable copy of the cache.

---

## Release gate

Run sequentially — they share a rate-limited endpoint:

```bash
npm test && npm run typecheck && npm run lint && npm run build
npm run verify:security
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

Three gates need state prepared first — see
[PHASE7_RECOVERY.md §9](../PHASE7_RECOVERY.md#9-verifying-after-recovery).
