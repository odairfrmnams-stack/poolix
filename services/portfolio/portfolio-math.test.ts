import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  dedupeAddresses,
  formatSharePercent,
  isUsableAddress,
  lpUnderlying,
  lpValueInEthWei,
  normalizeAddress,
  sameAddress,
  sharePercentScaled,
  SHARE_SCALE,
  totalValuation,
  usdCentsForEth,
  valueInEthWei,
  wethSideOf,
  ZERO_ADDRESS,
} from "@/services/portfolio/portfolio-math";

const ETH = 10n ** 18n;
const ORACLE = { answer: 300_000_000_000n, decimals: 8 }; // $3,000.00
const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const TOKEN = "0xaaaa000000000000000000000000000000000001";
const OTHER = "0xbbbb000000000000000000000000000000000002";

describe("LP ownership", () => {
  it("gives half the reserves for a 50% position", () => {
    const under = lpUnderlying(50n * ETH, 100n * ETH, 10n * ETH, 2_000n * ETH);
    assert.deepEqual(under, { amount0: 5n * ETH, amount1: 1_000n * ETH });
  });

  it("gives the whole pool for a 100% position", () => {
    const under = lpUnderlying(100n * ETH, 100n * ETH, 7n * ETH, 13n * ETH);
    assert.deepEqual(under, { amount0: 7n * ETH, amount1: 13n * ETH });
  });

  it("keeps a tiny position rather than rounding it to nothing", () => {
    // 1 wei of LP against 1e18 supply still claims its exact share of a large reserve.
    const under = lpUnderlying(1n, ETH, 1_000n * ETH, 0n);
    assert.equal(under?.amount0, 1_000n);
    assert.equal(under?.amount1, 0n);
  });

  it("returns nothing for a zero balance, rather than an empty position", () => {
    // Null and {0n, 0n} say different things; only one of them means "not a holder".
    assert.equal(lpUnderlying(0n, ETH, ETH, ETH), null);
  });

  it("returns nothing when there is no supply to take a share of", () => {
    assert.equal(lpUnderlying(ETH, 0n, ETH, ETH), null);
  });

  it("reports a zero reserve as a zero claim on that side, not as unavailable", () => {
    const under = lpUnderlying(ETH / 2n, ETH, 0n, 100n * ETH);
    assert.equal(under?.amount0, 0n);
    assert.equal(under?.amount1, 50n * ETH);
  });

  it("refuses a balance larger than total supply", () => {
    // Not a real chain state; claiming more than the pool holds is worse than refusing.
    assert.equal(lpUnderlying(ETH + 1n, ETH, ETH, ETH), null);
  });

  it("multiplies before dividing, so precision survives", () => {
    // Dividing first would floor the ratio to zero and lose the whole position.
    const under = lpUnderlying(3n, 1_000_000n, 1_000_000n * ETH, 0n);
    assert.equal(under?.amount0, 3n * ETH);
  });

  it("floors like the pair contract does when burning", () => {
    const under = lpUnderlying(1n, 3n, 10n, 0n);
    assert.equal(under?.amount0, 3n); // 10 * 1 / 3 = 3.33 -> 3
  });

  it("stays exact at sizes that would lose precision as a float", () => {
    const supply = 10n ** 30n;
    const under = lpUnderlying(supply / 3n, supply, 10n ** 30n + 7n, 0n);
    assert.equal(typeof under?.amount0, "bigint");
    assert.equal(under?.amount0, (10n ** 30n + 7n) / 3n);
  });
});

describe("pool share", () => {
  it("scales a half share to 50%", () => {
    assert.equal(sharePercentScaled(ETH / 2n, ETH), 50n * SHARE_SCALE);
  });

  it("formats a small share to the decimals a holder reads", () => {
    // 0.184% of the pool.
    const scaled = sharePercentScaled(184n, 100_000n);
    assert.equal(formatSharePercent(scaled), "0.184%");
  });

  it("formats a full share", () => {
    assert.equal(formatSharePercent(sharePercentScaled(ETH, ETH)), "100.000%");
  });

  it("shows a dust share as a bound rather than as zero", () => {
    const scaled = sharePercentScaled(1n, 10n ** 12n);
    assert.equal(formatSharePercent(scaled), "<0.001%");
  });

  it("reports nothing for a zero balance or empty pool", () => {
    assert.equal(sharePercentScaled(0n, ETH), null);
    assert.equal(sharePercentScaled(ETH, 0n), null);
    assert.equal(formatSharePercent(null), null);
  });
});

describe("valuation", () => {
  it("values a token through its pool ratio", () => {
    // 100 tokens against reserves of 1,000 tokens / 10 ETH is 1 ETH.
    assert.equal(valueInEthWei(100n * ETH, 1_000n * ETH, 10n * ETH), ETH);
  });

  it("refuses to price against an empty side", () => {
    assert.equal(valueInEthWei(ETH, 0n, ETH), null);
    assert.equal(valueInEthWei(ETH, ETH, 0n), null);
  });

  it("converts ETH to cents with a validated round", () => {
    assert.equal(usdCentsForEth(ETH, ORACLE), 300_000n);
  });

  it("returns nothing without an oracle rather than inventing a rate", () => {
    assert.equal(usdCentsForEth(ETH, null), null);
    assert.equal(usdCentsForEth(ETH, { answer: 0n, decimals: 8 }), null);
  });

  it("propagates an unpriceable amount rather than zeroing it", () => {
    assert.equal(usdCentsForEth(null, ORACLE), null);
  });

  it("values a WETH LP position as its WETH side doubled", () => {
    const under = { amount0: 2n * ETH, amount1: 500n * ETH };
    assert.equal(lpValueInEthWei(under, "token0"), 4n * ETH);
    assert.equal(lpValueInEthWei({ amount0: 500n * ETH, amount1: 2n * ETH }, "token1"), 4n * ETH);
  });

  it("refuses to value a token/token position", () => {
    // Would need a rate for a third asset that Poolix has not validated.
    assert.equal(lpValueInEthWei({ amount0: ETH, amount1: ETH }, "none"), null);
  });

  it("refuses to value a position that has no underlying", () => {
    assert.equal(lpValueInEthWei(null, "token0"), null);
  });
});

describe("portfolio total", () => {
  it("totals a fully priced portfolio and calls it complete", () => {
    const total = totalValuation([100n, 250n, 50n]);
    assert.equal(total.cents, 400n);
    assert.equal(total.complete, true);
    assert.equal(total.unvalued, 0);
  });

  it("sums only what it can price and reports the rest as partial", () => {
    const total = totalValuation([100n, null, 50n]);
    assert.equal(total.cents, 150n);
    assert.equal(total.complete, false);
    assert.equal(total.valued, 2);
    assert.equal(total.unvalued, 1);
  });

  it("never counts an unpriceable holding as zero", () => {
    // The distinction: two priced rows plus an unknown is not the same as three rows.
    const withUnknown = totalValuation([100n, null]);
    const withZero = totalValuation([100n, 0n]);
    assert.equal(withUnknown.cents, withZero.cents);
    assert.equal(withUnknown.complete, false);
    assert.equal(withZero.complete, true);
  });

  it("reports nothing at all when no holding can be priced", () => {
    const total = totalValuation([null, null]);
    assert.equal(total.cents, null);
    assert.equal(total.complete, false);
  });

  it("reports nothing for an empty portfolio rather than $0.00", () => {
    assert.equal(totalValuation([]).cents, null);
    assert.equal(totalValuation([]).complete, false);
  });

  it("counts a genuine zero balance as valued", () => {
    const total = totalValuation([0n]);
    assert.equal(total.cents, 0n);
    assert.equal(total.complete, true);
  });
});

describe("address handling", () => {
  it("compares case-insensitively", () => {
    assert.equal(sameAddress(TOKEN.toUpperCase(), TOKEN), true);
    assert.equal(normalizeAddress(`  ${TOKEN.toUpperCase()}  `), TOKEN);
  });

  it("rejects the zero address and malformed input", () => {
    assert.equal(isUsableAddress(ZERO_ADDRESS), false);
    assert.equal(isUsableAddress("0x123"), false);
    assert.equal(isUsableAddress("not-an-address"), false);
    assert.equal(isUsableAddress(`${TOKEN}00`), false);
    assert.equal(isUsableAddress(TOKEN), true);
  });

  it("deduplicates case-insensitively and keeps first-seen order", () => {
    assert.deepEqual(dedupeAddresses([OTHER, TOKEN, TOKEN.toUpperCase(), OTHER]), [OTHER, TOKEN]);
  });

  it("drops unusable addresses while deduplicating", () => {
    assert.deepEqual(dedupeAddresses([ZERO_ADDRESS, "0xnope", TOKEN]), [TOKEN]);
  });
});

describe("pair classification", () => {
  it("finds WETH on either side", () => {
    assert.equal(wethSideOf(WETH, TOKEN, WETH), "token0");
    assert.equal(wethSideOf(TOKEN, WETH, WETH), "token1");
  });

  it("classifies a token/token pair as having no WETH side", () => {
    assert.equal(wethSideOf(TOKEN, OTHER, WETH), "none");
  });

  it("does not depend on how the addresses were cased", () => {
    assert.equal(wethSideOf(WETH.toUpperCase(), TOKEN, WETH), "token0");
  });

  it("treats a degenerate WETH/WETH pair as WETH on token0", () => {
    // Not a pair the factory can create, but the classifier must stay total rather than
    // throwing on input it did not expect.
    assert.equal(wethSideOf(WETH, WETH, WETH), "token0");
  });
});

describe("LP discovery shapes", () => {
  /** A position is only listed when the wallet actually holds LP for it. */
  const held = (lpBalance: bigint, totalSupply: bigint) =>
    lpUnderlying(lpBalance, totalSupply, 10n * ETH, 1_000n * ETH) !== null;

  it("lists nothing when the wallet owns no LP", () => {
    assert.equal(held(0n, ETH), false);
  });

  it("lists a position the wallet does own", () => {
    assert.equal(held(ETH / 4n, ETH), true);
  });

  it("handles several positions independently", () => {
    const positions = [
      lpUnderlying(ETH / 2n, ETH, 10n * ETH, 0n),
      lpUnderlying(0n, ETH, 10n * ETH, 0n),
      lpUnderlying(ETH, ETH, 4n * ETH, 0n),
    ];
    assert.equal(positions.filter((p) => p !== null).length, 2);
  });

  it("collapses duplicate pair addresses to one row", () => {
    const pairs = dedupeAddresses([TOKEN, TOKEN.toUpperCase(), OTHER]);
    assert.equal(pairs.length, 2);
  });

  it("keeps a token that appears in several pools as several positions", () => {
    // Dedup is by PAIR, not by token: one token can legitimately have many pools.
    const pairs = dedupeAddresses([TOKEN, OTHER]);
    assert.equal(pairs.length, 2);
  });

  it("survives a pair that reports zero total supply", () => {
    assert.equal(lpUnderlying(ETH, 0n, ETH, ETH), null);
  });

  it("survives a failed read reported as nulls", () => {
    // A metadata or RPC failure must not take the position down with it.
    assert.equal(lpValueInEthWei(null, "token0"), null);
    assert.equal(usdCentsForEth(null, ORACLE), null);
    assert.equal(formatSharePercent(null), null);
  });
});
