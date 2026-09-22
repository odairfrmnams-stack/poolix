# Poolix

Liquidity infrastructure for Robinhood Chain: swap, provide liquidity, and explore
onchain markets from one interface.

Poolix is an interface to public contracts. It takes no custody, adds no fee of its own,
and shows `--` wherever a number cannot be derived from a source it can verify.

## Quick start

```bash
npm install
cp .env.example .env.local   # optional; the defaults work
npm run dev
```

Open http://localhost:3000.

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Development server |
| `npm run build` | Production build |
| `npm run typecheck` | `tsc --noEmit`, strict with `noUncheckedIndexedAccess` |
| `npm run lint` | ESLint |
| `npm test` | Unit tests via the Node test runner |
| `npm run verify:chain` | Asserts every shipped address against the live chain |

`npm run verify:chain -- testnet` checks the testnet instead.

## Network

Poolix targets Robinhood Chain only.

| | Mainnet | Testnet |
|---|---|---|
| Chain ID | 4663 | 46630 |
| Uniswap v2 | Deployed | **Not deployed** |
| Default RPC | `robinhood-rpc.publicnode.com` | `robinhood-sepolia-rpc.publicnode.com` |
| Explorer | Blockscout | Blockscout |

Mainnet is the default. On testnet the swap and pool surfaces report
**Contract Not Configured**, because no liquidity source is deployed there.

Chain IDs, the explorer, WETH and the Uniswap v2 deployment are constants in
`config/chains.ts`, not environment variables: a mistyped address in an env file is a
silent misconfiguration that would route funds to the wrong contract. `.env` selects the
network and holds only values that vary per deployment.

Robinhood's own endpoint (`rpc.mainnet.chain.robinhood.com`) is rate limited and blocked
on some networks, so it is kept in config under `rpcUrls.robinhood` rather than used as
the default.

## What is real, and what reads `--`

Everything Poolix displays comes from the chain. Where it cannot, it says so rather than
estimating.

**Read live from contracts:** pool reserves, LP supply, your positions and balances,
swap quotes (`router.getAmountsOut`, cross-checked against Poolix's own v2 arithmetic),
token metadata, and token prices as the mid price implied by a pool's reserves.

**Unavailable on this deployment:**

| Metric | Why |
|---|---|
| TVL in USD | No verified price feed is wired in |
| Volume, fees, APR | The public RPC rejects archive/log queries |
| Holders, active users, transaction history | Needs a transfer and transaction index |

The pool list is also partial by construction: the factory holds ~43,000 pairs and the
public endpoint throttles bulk reads, so Poolix scans a bounded window of the newest
pairs, ranks those, and states the coverage on the page. The pool finder resolves **any**
pair regardless, because pair addresses are derived with CREATE2 rather than looked up.

Point `RPC_URL` at a provider with real limits to widen the scan.

## Architecture

```
app/          routes; server components by default
components/   UI, grouped by surface
hooks/        React bindings over the services
services/     chain logic, no React
  liquidity/  LiquiditySource interface + Uniswap v2 adapter
  pools/      pool reads, discovery, pricing
  tokens/     metadata, listings
lib/          copy glossary, formatting, errors, transaction machine
config/       verified chain constants and env resolution
scripts/      verify-deployments.ts
```

Liquidity sources sit behind one interface (`services/liquidity/types.ts`), so the swap
surface does not know which protocol quoted it. Adding v3, v4 or Poolix's own pools means
adding an adapter, not changing the UI. Liquidity *management* stays source-specific on
purpose: v2 uses fungible LP tokens, v3 and v4 use ranged positions.

All user-facing text comes from the glossary in `lib/copy.ts`, so terminology stays
consistent and stays English.

## Verification

`npm run verify:chain` re-runs every assertion behind the shipped addresses:

- `router.factory()` and `router.WETH()` match the configured addresses
- both contracts are verified source on Blockscout under their canonical names
- pair addresses derived offchain from the canonical init code hash match
  `factory.getPair` for live pairs
- `router.getAmountsOut` matches Poolix's own v2 math exactly across sampled pools,
  confirming the deployed 0.30% fee

One finding worth knowing: the chain's L2 Multicall is a **Multicall2**. It has
`aggregate` and `tryAggregate` but no `aggregate3`, so it is deliberately not wired into
viem's `multicall3` slot, where it would revert. Reads are batched at the JSON-RPC layer
instead.

## Security

Poolix is **unaudited**, and it routes through third-party contracts it did not deploy.
Router lookalikes are documented on this chain. Check addresses on `/docs/contracts`
against the explorer before approving anything.

Approvals are for the exact amount being spent, never unlimited. Every transaction is
simulated before the wallet is prompted, so a revert surfaces its real reason.

## Tokens

Poolix ships **no curated token list**. There is no published list for this chain that
could be verified, and inventing one would put unverified addresses in front of users.
Only the native currency and WETH are built in; everything else is imported by address,
read from its own contract, and stored in the browser.
