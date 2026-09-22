# Poolix build handoff

This file extends the Poolix master prompt. Give Claude Code both documents. Where they conflict, this file wins: it records decisions and verified facts from after the master prompt was written.

Prepared 2026-09-17.

## Decisions

**Liquidity architecture: hybrid.** Poolix launches on Uniswap's existing Robinhood Chain deployments behind the `LiquiditySource` interface in `services/liquidity/types.ts`. Poolix's own contracts arrive later as another adapter, without UI changes.

**First adapter: Uniswap v2.** Quote, swap, add, and remove are fully onchain with fungible LP tokens, so the whole lifecycle can be tested end to end. v3 and v4 adapters follow. Ecosystem projects on this chain already trade through v3 and v4, so a v2-only swap may quote worse than the Uniswap interface until those adapters land.

**The shared interface covers swapping only.** Liquidity management stays source-specific. v2 uses fungible LP tokens, v3 and v4 use ranged positions, and v4 identifies pools by ID rather than address.

**Default network: ~~testnet~~ mainnet.** Superseded during the build — see *Resolved
2026-09-17* below. Uniswap is not deployed on 46630, so a testnet default made every
product surface read Contract Not Configured. Testnet is selected with
`NEXT_PUBLIC_POOLIX_NETWORK=testnet`.

## Verified chain facts

Sources, checked 2026-09-17:
- https://docs.robinhood.com/chain/connecting
- https://docs.robinhood.com/chain/protocol-contracts

These values are encoded in `config/chains.ts`.

| | Mainnet | Testnet |
|---|---|---|
| Chain ID | 4663 | 46630 |
| Native currency | ETH | ETH |
| Public RPC (rate-limited) | https://rpc.mainnet.chain.robinhood.com | https://rpc.testnet.chain.robinhood.com |
| Explorer | https://robinhoodchain.blockscout.com | https://explorer.testnet.chain.robinhood.com |
| WETH | 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73 | 0x7943e237c7F95DA44E0301572D358911207852Fa |
| L2 Multicall | 0x2cAC2D899eCC914d704FeaAE33ac1bF36277DaD1 | 0xa432504b6F04Cafe775b09D8AA92e8dbe41Ec7a8 |
| Permit2 | 0x000000000022D473030F116dDEE9F6B43aC78BA3 | 0x000000000022D473030F116dDEE9F6B43aC78BA3 |

Blockscout is the only explorer in config. Some provider docs list other explorer domains, and lookalike sites target this chain.

## Verify before use

Nothing in this section enters config until it has been checked. Record the evidence in the pull request.

1. **Uniswap addresses.** Get the v2 Factory and Router02 first, then v3, v4, Universal Router, and quoters, for chain 4663. Also check whether any are deployed on 46630. Take addresses only from Uniswap's official deployments list, then confirm onchain:
   - `router.WETH()` equals the WETH address above.
   - `router.factory()` equals the factory.
   - A pair returned by `factory.getPair(WETH, token)` reports the same `factory()`.
   - The source is verified on Blockscout.

   At least one ecosystem project documents several router lookalikes on this chain, including a modified Universal Router whose calldata differs from stock Uniswap.
2. **Pair fee and revert strings.** Confirm the deployed UniswapV2Pair and Router02 match canonical v2: the 0.3% fee in `services/liquidity/uniswap-v2/math.ts` and the strings in `revert-reasons.ts`.
3. **L2 Multicall ABI.** Confirm whether Robinhood's L2 Multicall is Multicall3 before wiring it into viem's `multicall3` slot.
4. **Error names.** `lib/errors.ts` matches viem and wagmi error class names plus EIP-1193 codes. Add a test that instantiates the real classes from the installed package versions.
5. **Chainlink feeds** for USD pricing: https://docs.robinhood.com/chain/oracles-and-price-feeds. Apply staleness and sequencer-uptime checks.
6. **Testnet liquidity.** If Uniswap has no testnet deployment, testnet swap shows Contract Not Configured. Integration tests then run against a mainnet fork (`anvil --fork-url`).

## Resolved 2026-09-17

Everything in *Verify before use* has now been checked. `npm run verify:chain` re-runs
every assertion; it reported 30/30 passing against mainnet.

1. **Uniswap addresses — confirmed and in config.** From Uniswap's official deployments
   list for chain 4663, then verified onchain:

   | | Address |
   |---|---|
   | UniswapV2Factory | `0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f` |
   | UniswapV2Router02 | `0x89e5DB8B5aA49aA85AC63f691524311AEB649eba` |

   `router.factory()` returns the factory, `router.WETH()` returns the WETH already in
   config, both are verified source on Blockscout under their canonical names, and the
   factory held 43,7xx pairs with 4.6M router transactions. Not deployed on 46630: both
   addresses hold zero code there, so testnet reports Contract Not Configured.

2. **Pair fee and revert strings — canonical.** `router.getAmountsOut` matched
   `math.ts` byte for byte on every sampled amount across four live pairs, confirming
   997/1000. The CREATE2 derivation with the canonical init code hash
   (`0x96e8ac42…845f`) reproduces live pair addresses, so `factory.getPair` is never
   needed to locate a pair. Covered by `services/liquidity/uniswap-v2/pair.test.ts`,
   which pins three live mainnet pairs as fixtures.

3. **L2 Multicall — it is a Multicall2, not a Multicall3.** `aggregate` and
   `tryAggregate` are present; `aggregate3` reverts. It is therefore *not* wired into
   viem's `multicall3` slot. Reads are batched at the JSON-RPC layer instead
   (`http(url, { batch: … })`). Note `Multicall3.getBlockNumber()` disagrees with
   `eth_blockNumber` here; that is node lag, not a different chain.

4. **Error names — checked against the installed packages.** Every name in
   `lib/errors.ts` exists in viem 2.56. `ConnectorNotConnectedError` exists in
   `@wagmi/core` but is not re-exported from `wagmi`; matching is by `error.name` at
   runtime, so this is fine. Note wagmi v3 renamed `useAccount` to `useConnection`.

5. **Chainlink feeds — not wired in.** No verified feed, so no USD anywhere. Token
   prices are quoted in ETH as the mid price implied by pool reserves, and TVL reads
   `--`. This is stated on every page that would otherwise show a dollar figure.

6. **Testnet liquidity — none.** Uniswap has no 46630 deployment, so integration
   testing against testnet is not possible; a mainnet fork is still the route.

### Also found during the build

**The public RPC is archive-restricted.** `eth_getLogs` returns *"Archive requests
require a personal token"* for any block range. Volume, fees, APR, holders and
transaction history are therefore uncomputable, and every one of them renders `--` with
an on-page explanation rather than an estimate.

**The public RPC throttles bulk reads.** It 429s after roughly eight batched requests,
so the 43,7xx pairs cannot be enumerated on demand. `services/pools/discovery.ts` scans
a bounded, paced window with a hard time budget, caches the result, and reports its own
coverage. Set `RPC_URL` to a keyed provider to widen it.

**`*.chain.robinhood.com` was DNS-blocked on the build machine**, resolving to a block
page. The default RPC is PublicNode's gateway; Robinhood's endpoint stays in config
under `rpcUrls.robinhood`.

**Mainnet WETH `name()` is `"WETH"`, not `"Wrapped Ether"`** — worth checking rather
than assuming when building a token entry.

## Deviations from the master prompt

**Section 39 environment variables.** Chain ID, explorer, and WETH are verified constants in code, not env vars, because a mistyped chain ID in env is a silent misconfiguration. Env selects the network and holds only values that vary by deployment. See `.env.example`.

**RPC.** Robinhood's public endpoints are rate-limited and not meant for production. Browser reads use the public endpoint or `NEXT_PUBLIC_RPC_URL`. Keyed provider URLs go in server-only `RPC_URL`, used by route handlers and the indexer.

**ABIs** come from verified Blockscout source or official Uniswap packages. Never write them by hand.

## Stock tokens

Stock tokens are 18-decimal ERC-20s that also implement ERC-8056, a corporate-action multiplier.
- AMM math uses raw `balanceOf` amounts.
- `balanceOfUI` is only for displaying share equivalents.
- Subscribe to `UIMultiplierUpdated`.

They are issued as tokenized debt securities. Get legal review before including them in Poolix's default token list.

## Included foundation

| File | Purpose |
|---|---|
| `config/chains.ts` | Verified network definitions, compatible with viem `defineChain` |
| `config/resolve.ts` | Env validation; unknown network or insecure RPC throws; contract status |
| `config/poolix.ts` | Resolved config (literal `process.env` references for Next.js inlining) |
| `lib/copy.ts` | English glossary as the single source of truth for UI text |
| `lib/errors.ts` | Maps wallet, RPC, and revert errors to glossary copy |
| `lib/format.ts` | `--` for missing data, truncating token amounts, USD, basis points, explorer links |
| `lib/transactions/machine.ts` | Transaction state reducer; ignores stale hashes and receipts |
| `services/liquidity/types.ts` | Liquidity source adapter interface |
| `services/liquidity/uniswap-v2/math.ts` | v2 quote, price impact, slippage, add and remove previews |
| `services/liquidity/uniswap-v2/revert-reasons.ts` | v2 revert strings mapped to error copy |
| `types/web3.ts` | Address and hash types |

**Verified in the sandbox:** `tsc --noEmit` passes with strict, noUncheckedIndexedAccess, and noUnused checks, and `tsx --test` passes 46 of 46 tests. `getAmountOut` is checked against UniswapV2Pair's K invariant on 203 cases: the returned output passes, and one unit more fails.

**Not run:** ESLint and `next build`, because dependencies couldn't be installed in the sandbox.

### Integration

1. Copy `config/`, `lib/`, `services/`, `types/`, and `.env.example` into the project root.
2. Replace `types/web3.ts` with `export type { Address, Hash, Hex } from "viem";`.
3. In `tsconfig.json`, set `target` to ES2020 or later (bigint literals fail on create-next-app's ES2017 default), add `"strict": true` and `"noUncheckedIndexedAccess": true`, and keep the `@/*` alias.
4. Add scripts: `"typecheck": "tsc --noEmit"` and `"test": "tsx --test \"{config,lib,services}/**/*.test.ts\""`, with `tsx` as a dev dependency.
5. Pass `robinhoodNetworks[network].chain` to viem's `defineChain`, and build the wagmi config from `poolixConfig`.

## Phase 1 notes

- Stack: create-next-app (App Router, TypeScript, Tailwind, ESLint), then wagmi, viem, TanStack Query, shadcn/ui, and Motion.
- The brief fixes the visual direction as near-black with a restrained green. Keep the green muted (emerald, not neon), use one type family, and avoid all-caps labels except abbreviations like TVL and APR.
- Use one orchestrated motion moment on the landing page, the liquidity visualization, rather than fade-up effects on every section. Motion elsewhere should respond to user actions.
- Gates: lint, typecheck, test, build.

## Glossary additions

Added to `lib/copy.ts` per master prompt section 54:
- Status: Approved.
- Error titles: Price Impact Too High, Price Moved, Transaction Expired, Network Unavailable, Unexpected Error.
- Error messages: Quote Unavailable, Token Approval Failed, Contract Not Configured.
