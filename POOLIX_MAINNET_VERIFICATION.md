# POOLIX — Mainnet Write-Path Verification Procedure

Manual procedure for the seven write paths that have never run a real signed
transaction. Prepared from `POOLIX_CHECKPOINT.md` and re-verified against the code.

**Status: prepared, not executed. No transaction has been sent. Awaiting your go-ahead.**

---

## 0. Checkpoint conformance — re-verified before writing this

| Claim in checkpoint | Method | Result |
|---|---|---|
| Typecheck / lint clean | `npm run typecheck`, `npm run lint` | PASS, PASS |
| 87 tests, 29 suites, 0 fail | `npm test` | Confirmed |
| Addresses verified onchain | `npm run verify:chain` | **30/30 passed** |
| Approvals are exact-amount, never unlimited | grep for `maxUint256` | **No match anywhere**; `approve(spender, approval.amount)` at `use-transaction-flow.ts:87` |
| Zero-clear for USDT-style tokens | code read | `approve(token, spender, 0n)` at `:82`, guarded by `currentAllowance > 0n` |
| Simulation **before** wallet prompt | code read | `publicClient.call(...)` at `:105` runs **before** `REQUEST_CONFIRMATION` (`:107`) and before `sendTransactionAsync` (`:109`) |
| Remove liquidity approves LP token to router | code read | `token: pool.address`, `spender: router`, `amount: liquidity` (`remove-liquidity.tsx:87-90`) |
| 100% removal leaves no dust | code read | `liquidityForPercentage` returns the exact balance at `10_000` bps (`math.ts:179`) |
| Defaults: 0.5% slippage, 20 min deadline | code read | `DEFAULT_SLIPPAGE_BPS = 50`, `DEFAULT_DEADLINE_MINUTES = 20` |
| High-impact gate at 15% | code read | `CONFIRM_IMPACT_BPS = 1_500` |
| Native "Max" holds back gas | code read | `NATIVE_GAS_RESERVE = 0.0005 ETH` |

**Consequence that shapes this procedure:** because simulation runs before the wallet is
prompted, a swap that would revert is caught with **no wallet prompt and no gas spent**.
That is what Test 7 exercises.

---

## 1. Safety rules

**What I will not do:** send or sign any transaction, ask for a private key or seed
phrase, ask you to paste a key anywhere, invent a transaction hash, or change any
contract address. Every hash in the results table must be one you copied from your own
wallet or the explorer.

**What you must do:**
- Use a **throwaway wallet** created for this, holding nothing else.
- Fund it with **0.01 ETH on chain 4663** and treat that as spent.
- Never enter a seed phrase into any page. Poolix never asks for one.

**Unmitigated risk — read this.** The tokens on this chain are unaudited meme/test
tokens. A token can be a honeypot: buyable but not sellable. Poolix cannot detect this in
advance and I have not verified it for the token below. If it is a honeypot, Test 2's
simulation will catch it and you will lose the **0.001 ETH from Test 1** — no more,
because no gas is spent on a failed simulation. Providing liquidity also carries
impermanent loss. None of this is a Poolix defect; §Diagnosis explains how to tell the
difference.

---

## 2. Wallet and funding

1. Create a fresh wallet in your browser extension. Do not import an existing one.
2. Add Robinhood Chain if your wallet does not know it:
   - Chain ID **4663**, currency **ETH**, RPC `https://robinhood-rpc.publicnode.com`,
     explorer `https://robinhoodchain.blockscout.com`
   - Poolix's **Switch Network** button will also offer to add it.
3. Move **0.01 ETH** onto chain 4663 by whichever route you already use. I have not
   verified any bridge, so I am not naming one.
4. Confirm the balance is visible in your wallet before starting.

Budget: ~0.0015 ETH of actual test capital, the rest is gas and headroom. Expect roughly
**10–11 transactions**. Gas on this L2 is cheap (the explorer was showing cents).

---

## 3. Test pool — live data, read-only

Selected from a read-only scan of the 300 newest pairs just now. Deepest pool available,
so price impact on a small trade is the lowest on offer.

| | Value |
|---|---|
| Pool (pair) | `0xd986765F42934aF70717A76AD4230F87D95528d9` |
| Token | **WAIFU** `0xd479A5495ADC2D0a808Dc1113FD1750b65936895`, 18 decimals |
| Pool WETH reserve | **65.12 WETH** |
| 0.001 ETH buys | ≈ **56,573 WAIFU** |
| Effective cost vs mid price | **0.30%** (essentially just the LP fee) |
| Round trip (buy then sell back) | returns ≈ **99.40%** of your ETH |

Backups if WAIFU misbehaves: **LOX** `0xd125a2f04D48dD4992e1f9a18d946148Dae84A81`
(14.91 WETH, **9 decimals** — also a useful decimals edge case), or **GROKBOOK**
`0xAb09BE58b6Db998dC7b5770f106Ed6De6Cf17ba1` (2.60 WETH, 9 decimals).

Reserves drift. Treat every number above as approximate and compare against what Poolix
shows at the time.

**Before Test 1**, open the token on the explorer and confirm it looks like a plain
ERC-20 with verified source:
`https://robinhoodchain.blockscout.com/token/0xd479A5495ADC2D0a808Dc1113FD1750b65936895`

---

## 4. Pre-flight

```bash
npm run verify:chain     # expect: All 30 checks passed.
npm run dev              # http://localhost:3000
```

Then, in the browser:
1. Header shows **POOLIX**, no "Testnet" chip (chip only appears on 46630).
2. Click **Connect Wallet**, approve. The button becomes `0x…` with a green dot.
3. No **Switch Network** state. If you see it, click it and approve chain 4663.
4. Go to `/swap` → **Select Token** → paste the WAIFU address → it reads the contract
   and offers **Import WAIFU** with an unverified-token warning → Import.

**Bug if:** the header still says Connect Wallet after approving; "Wrong Network" persists
after switching; or the token import shows a symbol other than WAIFU.

### Recommended order

**6 → 1 → 2 → 7 → 3 → 4 → 5.** Test 6 costs nothing and validates the dialog before you
spend anything. Test 7 needs a price move, so it reuses a repeat of Test 1.

---

## Test 1 — Native ETH → token swap

Exercises: no-approval path, native value transfer, `swapExactETHForTokens` (`0x7ff36ab5`).

**Click:** `/swap` → From = **ETH**, To = **WAIFU** → type `0.001` in the From field →
wait for the quote → **Confirm Swap**.

**Amount:** `0.001` ETH.

**Before clicking, check the details panel:**
- Rate ≈ 1 ETH = 56,000,000–57,000,000 WAIFU
- Price Impact ≈ **0.30%** (muted grey — amber only above 3%)
- Minimum Received ≈ received × 0.995 (0.5% default slippage)
- Network Fee shows a real ETH figure, **not** `--` (native input needs no approval, so
  estimation succeeds)
- Route reads **ETH → WAIFU**

**In the wallet:** exactly **one** prompt. A contract interaction with
`0x89e5DB8B5aA49aA85AC63f691524311AEB649eba` (UniswapV2Router02), **value = 0.001 ETH**.

**Dialog should progress:** `Confirming` ("Confirm the swap in your wallet") →
`Transaction Pending` → **`Transaction Confirmed`** + **View on Explorer** + **Done**.

**Success =** all of:
- Explorer shows status Success, a Swap event on the pair, and WAIFU transferred to you
- WAIFU received **≥ Minimum Received** shown before signing
- Your WAIFU balance appears in the From selector after switching direction

**Bug if:**
- Two wallet prompts (there is no token to approve when spending native ETH)
- Value in the prompt ≠ 0.001 ETH, or recipient ≠ the router address above
- Received **< Minimum Received** (slippage protection failed — **stop and report**)
- Dialog stays on Pending after the explorer shows Success
- Network Fee shows `--` despite being connected

---

## Test 2 — Token → native ETH swap

Exercises: the **approval path**, exact-amount approval, `swapExactTokensForETH`.

**Click:** on `/swap`, press the **↓ switch** button so From = WAIFU, To = ETH → enter
**half** your WAIFU balance → button reads **Approve WAIFU** → click it.

**Amount:** half of what Test 1 gave you (≈ **28,280 WAIFU**). Keep the other half for
Test 3. Do not use **Max**.

**In the wallet:** **two** prompts, in order.
1. **Approve** on the WAIFU token contract. **Inspect the amount** — it must be the exact
   number of WAIFU you typed, **not** unlimited. If your wallet shows "Unlimited", that
   contradicts the code and is a **stop-and-report** bug.
2. **Swap** on the router.

**Dialog should progress:** `Awaiting Approval` ("Confirm the token approval in your
wallet") → `Approving` → `Approved` → `Confirming` → `Transaction Pending` →
**`Transaction Confirmed`**.

**Success =**
- Approval tx confirmed, then swap tx confirmed, both visible on the explorer
- ETH balance increases by ≥ the Minimum Received shown
- Re-running a smaller sell **skips the approval entirely** if allowance remains — the
  dialog goes straight to `Confirming`

**Bug if:**
- Approval is for an unlimited amount
- Approval is sent to anything other than the router `0x89e5DB8B…9eba`
- A second approval is requested when the existing allowance already covers the amount
- Approval confirms but the dialog never advances past `Approved`

**Not a Poolix bug:** if the **simulation** blocks the swap with a revert before any
wallet prompt, the token is likely restricting sales (honeypot). Zero gas is spent. See
§Diagnosis.

---

## Test 3 — Add liquidity

Exercises: ratio enforcement, `addLiquidityETH` (`0xf305d719`), ETH as call value.

**Click:** `/pools` → **Find a pool** → ETH + WAIFU → the result card → on the pool page
choose the **Add Liquidity** tab. Leave **"Use ETH instead of WETH"** ticked.

**Amount:** type your **remaining WAIFU balance** (≈ 28,280) into the WAIFU field. The
ETH field should auto-fill to ≈ **0.0005 ETH**.

**Before signing, check:**
- Editing either field recomputes the other — the pool fixes the ratio
- "LP tokens received" and "Pool Share" both show real numbers
- Slippage Tolerance reads **0.50%**
- There is **no** orange "pool holds no liquidity" banner (that appears only for empty
  pools; this pool has 65 WETH)

**In the wallet:** **two** prompts — Approve WAIFU (exact amount), then `addLiquidityETH`
on the router with **value ≈ 0.0005 ETH**. The ETH side needs no approval.

**Success =**
- Both confirmed; explorer shows a Mint event on the pair
- Reloading the pool page shows a non-zero **Your Liquidity** with LP tokens and both
  pooled amounts
- **Pool Share** in the stat grid is no longer `--`
- `/dashboard` lists the position under Your Liquidity

**Bug if:**
- Three prompts (ETH should never need approval)
- Value in the prompt ≠ the ETH amount displayed
- Ratio does not recompute when you edit a field
- Position does not appear after confirmation

---

## Test 4 — Remove 25% liquidity

Exercises: LP-token approval to the router, `removeLiquidityETH` (`0x02751cec`).

**Click:** same pool page → **Remove Liquidity** tab → **25%** preset → **Remove
Liquidity**.

**Amount:** 25% of your LP balance.

**Before signing, check:** both "received" rows show ≈ a quarter of your pooled amounts,
and Minimum Received is ≈ 0.5% below each.

**In the wallet:** **two** prompts — Approve on the **pair contract**
`0xd986765F…28d9` (the LP token, *not* WAIFU) for the exact LP amount, then
`removeLiquidityETH` on the router with **value = 0**.

**Success =**
- Both confirmed; explorer shows a Burn event
- You receive **both** ETH and WAIFU, each ≥ its Minimum Received
- ETH arrives as native ETH, not WETH (that is what `removeLiquidityETH` is for)
- Your Liquidity now shows ≈ 75% of the previous position

**Bug if:**
- Approval targets the WAIFU token rather than the pair contract
- The removal transaction carries a non-zero ETH value
- You receive WETH instead of ETH while "Use ETH" was ticked
- Amounts received fall below Minimum Received (**stop and report**)

---

## Test 5 — Remove 100% liquidity

Exercises: the exact-balance path (`percentBps === 10_000` returns the balance
untouched, so no dust is stranded), and possibly the **zero-clear** approval branch.

**Click:** same tab → **100%** preset → **Remove Liquidity**.

**Amount:** your entire remaining LP balance.

**In the wallet:** two prompts normally. **Three if** Test 4 left an unspent LP
allowance — you would then see `approve(0)`, then `approve(exact)`, then the removal.
That third prompt is the documented USDT-style zero-clear branch working, **not** a bug.

**Success =**
- Confirmed; **Your Liquidity shows the empty state** ("No liquidity positions yet")
- LP balance is exactly **0** — check `balanceOf` on the pair in the explorer. Any dust
  remainder means the 100% path is wrong
- **Pool Share** returns to `--` once disconnected, or 0 while connected
- Position disappears from `/dashboard`

**Bug if:** a non-zero LP balance remains; or the button stays enabled with a zero
balance (it should read "No liquidity positions yet" and be disabled).

---

## Test 6 — Wallet rejection handling

Costs nothing. **Run this first.**

**Click:** `/swap`, set up any valid ETH → WAIFU swap of `0.001`, click **Confirm Swap**,
then press **Reject/Cancel** in the wallet.

**Success =**
- Dialog shows **"Transaction Rejected"** / "The transaction was rejected."
- A **Try Again** button is offered
- **No** spinner is left running, no hash, no explorer link
- Closing and reopening the dialog works; **Try Again** re-prompts the wallet
- Your balance is unchanged and no transaction appears on the explorer

**Also try:** reject the **approval** prompt in a token → ETH swap. Same result expected —
the flow must not be left stuck in `Awaiting Approval`.

**Bug if:** the dialog hangs on `Confirming`; a generic/raw error appears instead of the
Poolix copy; or Try Again is missing.

---

## Test 7 — Slippage / revert simulation handling

Exercises the property that makes Poolix safe to click: a doomed transaction is caught in
simulation, **before** the wallet is prompted, so it costs no gas.

You need the price to move between the quote and the click. Use two browser tabs.

1. **Tab A:** `/swap`, ETH → WAIFU, amount `0.001`. Open the ⚙ settings and set slippage
   to **0.01%** (type `0.01` in the custom box). Wait for the quote. **Do not click yet.**
2. **Tab B:** the same swap, default 0.5% slippage — execute it for real. This is a repeat
   of Test 1 and moves the pool price.
3. **Tab A:** once Tab B confirms, click **Confirm Swap** on the now-stale quote.

**Success =**
- **No wallet prompt appears at all**
- Dialog shows **"Price Moved"** / "The price changed beyond your slippage tolerance.
  Review the quote and try again." — mapped from
  `UniswapV2Router: INSUFFICIENT_OUTPUT_AMOUNT`
- **Try Again** is offered
- Your wallet shows **no new transaction** and **no gas spent** — confirm on the explorer

**Bug if:**
- A wallet prompt appears and you are asked to sign a transaction that will revert
  (simulation was skipped — **stop and report**)
- Gas is spent on a failed transaction
- A raw viem/RPC error string is shown instead of "Price Moved"

**If the timing is too tight**, raise the Tab B amount to `0.01` ETH to move the price
further, or set Tab A's slippage to `0.01%` and simply leave the tab idle for a minute on
an actively traded pool.

**Bonus check (free):** set slippage to `6%` and watch for the warning copy; set it above
50% and confirm it clamps at `MAX_SLIPPAGE_BPS` (50%).

---

## Diagnosis — Poolix bug vs. token or chain behaviour

| Symptom | Likely cause |
|---|---|
| Simulation blocks a **sell** but buys work | Token restricts transfers (honeypot). Not Poolix. Confirm on the explorer. |
| "Insufficient Liquidity" on a tiny trade | Pool reserves too small. Pick a deeper pool. |
| Received below Minimum Received | **Poolix bug.** Stop, record the hash, report. |
| Unlimited approval requested | **Poolix bug.** Contradicts `use-transaction-flow.ts:87`. Stop. |
| Wallet prompt for a transaction that then reverts | **Poolix bug** — simulation was bypassed. Stop. |
| Dialog stuck while the explorer shows Success | **Poolix bug** in receipt handling. Record the hash. |
| Raw error text instead of Poolix copy | Gap in `classifyError`. Record the exact string. |
| First page load slow (~9–12s) on /pools | Known: cold pool-scan cache. Not a bug. |

---

## Recording results

Fill this in as you go. Paste **only real hashes** from your wallet or the explorer.

| # | Test | Result | Tx hash(es) | Notes |
|---|---|---|---|---|
| 6 | Wallet rejection | | — | |
| 1 | ETH → WAIFU | | | |
| 2 | WAIFU → ETH | | approve: <br>swap: | Approval exact? Y/N |
| 7 | Slippage revert | | — (expect none) | Wallet prompted? Y/N |
| 3 | Add liquidity | | approve: <br>add: | |
| 4 | Remove 25% | | approve: <br>remove: | |
| 5 | Remove 100% | | approve(s): <br>remove: | LP balance after = 0? |

When complete, copy this table into `HANDOFF.md` as the write-path verification record,
and update `POOLIX_CHECKPOINT.md` §11 from "never exercised" to verified.

**Stop immediately and report** if you hit any row marked *stop and report*, or anything
that moves more value than the amount you entered.
