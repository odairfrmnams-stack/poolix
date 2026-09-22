# Wallet security checklist — manual verification before mainnet

Everything in Poolix's write path is verified by code and tests **except what a real wallet
does with it**. This is that gap, written down.

Nothing here can be automated. A wallet's confirmation screen is the last thing standing
between a user and a signature, and no test can tell you whether it showed the right
contract. A human has to look.

> **Do not run these against a wallet holding significant funds.** Use a wallet funded with
> the minimum needed to complete a trade.
>
> **Poolix never executes a transaction automatically.** Every signature below is one you
> deliberately approve.

---

## What is already verified, and how

Do not re-test these by hand; they are asserted on every run of the suite. They are listed
so you know what the manual checks are *adding to*, not duplicating.

| Property | Verified by |
|---|---|
| Chain is pinned to 4663 on every send | `use-transaction-flow.ts`, asserted in `verify:security` |
| Approvals are exact-amount, never `maxUint256` | `checkApproval`, and a repo-wide scan in `verify:security` |
| Existing non-zero allowance is cleared to 0 first | `use-transaction-flow.ts:81` |
| Simulation runs before the wallet is opened | ordering asserted in `verify:security` |
| Destination must be the configured router | `checkTransactionIntent` + 28 guard tests |
| Deadline is in the future and ≤ 180 minutes | `checkDeadline` |
| Calldata is built from typed ABIs, never strings | `verify:security` |
| Amounts are bigint throughout; no float math | `lib/amounts.ts` + tests |
| Slippage is bounded and cannot go negative | `assertBps` in `math.ts` |

---

## Before you start

- [ ] A wallet with a **small** balance of the chain's native token.
- [ ] A second token with a live WETH pair (check `/pools`).
- [ ] The block explorer open: <https://robinhoodchain.blockscout.com>
- [ ] Record the expected router address from `/docs/contracts`. Every approval and swap
      confirmation must name **this** address and no other.

Router (mainnet, chain 4663): `0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f`

---

## 1. Connect

- [ ] Click **Connect Wallet**. The wallet prompts; approve.
- [ ] The header shows a truncated address with a connected indicator.
- [ ] **No "Switch Network" state appears.** If it does, the wallet is not on 4663.

## 2. Chain

- [ ] The wallet reports chain **4663**.
- [ ] Switch the wallet to a different chain manually. Poolix must show **Wrong Network**
      and must **not** offer to swap.
- [ ] Click the switch prompt; approve. Poolix returns to normal.
- [ ] Attempt a swap while on the wrong chain — confirm it is refused **before** any wallet
      prompt appears.

## 3. Token selection and display

- [ ] Select a token by symbol. The listed address matches the explorer.
- [ ] Paste a token address directly. It resolves to the same token.
- [ ] Paste a **non-contract** address (an ordinary wallet). Poolix must say no contract is
      deployed there rather than showing a zero-balance token.
- [ ] Paste a contract that is not an ERC-20. It must be refused, not shown with `--`.
- [ ] Check any token with an unusual symbol: the symbol must render on one line, with no
      reversed or invisible characters, and must not break the table layout.

## 4. Amount entry

- [ ] Type an amount with more decimals than the token has. The extra digits are truncated,
      not rounded up.
- [ ] Type `0`. The swap button stays disabled.
- [ ] Paste a very long number. The field does not hang or accept nonsense.
- [ ] Click **Max** on the native token. The amount is less than the full balance — gas is
      held back.
- [ ] Enter more than the balance. Poolix shows insufficient balance and does not prompt.

## 5. Quote and slippage

- [ ] The quoted output matches what the router returns (compare via the explorer's read
      interface if you want certainty).
- [ ] Set slippage to a custom value. Above 5% a warning appears; below 0.1% a different
      warning appears.
- [ ] Try to set slippage above 50%. It clamps.
- [ ] Try to enter a negative slippage. It is refused.
- [ ] Set the deadline to 0 or above 180. It is refused.

## 6. Approval — **the critical screen**

For an ERC-20 → anything swap:

- [ ] The wallet opens an **approval** prompt.
- [ ] **The spender shown is the router address recorded above.** Compare every character,
      not just the first and last four. This is the single most important check on this
      page.
- [ ] **The amount is exactly what you are spending** — not "unlimited", not "max", not a
      number larger than your input.
- [ ] Reject it. Poolix returns to a settled state with a rejection message, no spinner,
      and **no second prompt**.
- [ ] Repeat and approve. The approval confirms and the flow proceeds on its own.

If the token already has a non-zero allowance:

- [ ] You see `approve(0)` first, then `approve(exact)`. Two prompts is correct here.

## 7. Swap

- [ ] The wallet opens a **transaction** prompt.
- [ ] **The destination is the router address**, not a token, not an unknown contract.
- [ ] For a native-in swap, the value shown equals your input amount. For a token-in swap,
      the value is zero.
- [ ] Reject it. Poolix settles cleanly and does not resend.
- [ ] Repeat and confirm. A transaction hash appears **only after** the wallet returns.
- [ ] Open the hash in the explorer: status success, `to` is the router, and the token
      transfers match the quote within your slippage.
- [ ] Balances update in Poolix after confirmation.

## 8. Failure paths

- [ ] **Simulation failure.** Set slippage to 0.01% on a volatile pair, or let a quote go
      stale, then submit. Poolix must report the reason and must **not** open the wallet.
- [ ] **Deadline expiry.** Set the deadline to 1 minute and delay confirming past it. The
      revert is reported as an expired deadline.
- [ ] **Refresh during a pending transaction.** Reload the page while the wallet is open or
      while confirming. Poolix must not resend on return; check the explorer to confirm
      exactly one transaction exists.
- [ ] **RPC failure mid-flight.** Disconnect the network after submitting. Poolix reports a
      network error. Reconnect: **confirm on the explorer that only one transaction was
      broadcast.**
- [ ] **Wallet provider failure.** Lock the wallet mid-flow. Poolix reports the failure and
      settles.
- [ ] **Disconnect.** Disconnect from the wallet side. Poolix returns to the connect state
      without errors.
- [ ] **Reconnect.** Reconnect and confirm the previous state does not leak into the new
      session.

## 9. Liquidity

Repeat sections 6–8 for:

- [ ] **Add liquidity.** Two approvals (or one, plus native value). Both spenders are the
      router.
- [ ] **Remove liquidity 25%.** The LP token is approved **to the router**; the amount is
      the LP quantity, not the underlying.
- [ ] **Remove liquidity 100%.** The LP balance afterwards is exactly zero.

---

## Recording the run

| # | Check | Tx hash | Spender/destination correct? | Notes |
|---|---|---|---|---|
| 1 | ETH → token | | Y / N | |
| 2 | token → ETH | approve:<br>swap: | Y / N | Approval exact? Y/N |
| 3 | Add liquidity | approve:<br>add: | Y / N | |
| 4 | Remove 25% | approve:<br>remove: | Y / N | |
| 5 | Remove 100% | remove: | Y / N | LP balance after = 0? |

**A "no" in the spender/destination column is a stop-ship.** It means the guard in
`lib/transactions/guards.ts` was bypassed or misconfigured, and no amount of other passing
checks compensates for signing the wrong contract.
