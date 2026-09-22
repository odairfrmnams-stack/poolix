import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { computePairAddress, IdenticalAddressesError, orientReserves, sortTokens } from "@/services/liquidity/uniswap-v2/pair";
import type { Address } from "@/types/web3";

const FACTORY: Address = "0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f";
const WETH: Address = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";

/*
  Live pairs read from Robinhood Chain mainnet on 2026-09-17 via
  factory.allPairs(n). If the init code hash or the factory address ever changes,
  these derivations stop matching, which is exactly the failure worth catching.
*/
const LIVE_PAIRS: readonly { token: Address; pair: Address }[] = [
  { token: "0x0d6b6f604c1bf5b3533c445334bb4e1044145688", pair: "0x4b26f2f37Db21DFe226465307E7fcE8D5910064F" },
  { token: "0xc7af5f827da6a292b260e0733d8a51df86b2940d", pair: "0x7D9Ac796a32FDA332264B884F531581ED2477e4A" },
  { token: "0xf8c0e9b26971c5df9b754e5e0f5ad78c35770000", pair: "0x40Dfb6326DEcc3b1E59f824D4774351E538d9221" },
];

describe("computePairAddress", () => {
  it("derives live mainnet pairs from the factory and init code hash", () => {
    for (const { token, pair } of LIVE_PAIRS) {
      assert.equal(computePairAddress(FACTORY, WETH, token), pair);
    }
  });

  it("is independent of argument order", () => {
    for (const { token, pair } of LIVE_PAIRS) {
      assert.equal(computePairAddress(FACTORY, token, WETH), pair);
    }
  });

  it("accepts lowercase input and returns a checksummed address", () => {
    const [first] = LIVE_PAIRS;
    assert.ok(first);
    assert.equal(computePairAddress(FACTORY.toLowerCase() as Address, WETH.toLowerCase() as Address, first.token), first.pair);
  });

  it("rejects a pair of one token", () => {
    assert.throws(() => computePairAddress(FACTORY, WETH, WETH), IdenticalAddressesError);
  });
});

describe("sortTokens", () => {
  it("puts the numerically smaller address first regardless of input order", () => {
    const [first] = LIVE_PAIRS;
    assert.ok(first);
    // WETH (0x0Bd7…) sorts before 0x0d6b….
    assert.deepEqual(sortTokens(first.token, WETH), [WETH, "0x0d6b6f604C1BF5b3533C445334bb4e1044145688"]);
  });
});

describe("orientReserves", () => {
  const token0: Address = WETH;

  it("maps reserves to in/out by which side the input token is on", () => {
    assert.deepEqual(orientReserves(WETH, token0, 10n, 20n), { reserveIn: 10n, reserveOut: 20n });
    assert.deepEqual(orientReserves("0x0d6b6f604c1bf5b3533c445334bb4e1044145688", token0, 10n, 20n), {
      reserveIn: 20n,
      reserveOut: 10n,
    });
  });
});
