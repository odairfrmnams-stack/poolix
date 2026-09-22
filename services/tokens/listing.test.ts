import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { PoolDiscoveryResult } from "@/services/pools/discovery";
import { listTokens } from "@/services/tokens/listing";

const TOKEN_A = "0x0d6b6f604C1BF5b3533C445334bb4e1044145688";
const TOKEN_B = "0xF8c0E9B26971C5Df9b754E5E0F5AD78C35770000";

const pool = (
  address: string,
  token: string,
  symbol: string,
  wethReserve: bigint,
  otherReserve: bigint,
  decimals = 18,
) => ({
  address: address as `0x${string}`,
  other: { address: token as `0x${string}`, symbol, decimals },
  wethReserve: wethReserve.toString(),
  otherReserve: otherReserve.toString(),
});

const result = (pools: PoolDiscoveryResult["pools"]): PoolDiscoveryResult => ({
  pools,
  totalPairs: pools.length,
  scanned: pools.length,
  complete: true,
});

describe("listTokens", () => {
  it("returns one row per token with liquidity summed across its pools", () => {
    const listings = listTokens(
      result([
        pool("0x1111111111111111111111111111111111111111", TOKEN_A, "SMK2", 2n * 10n ** 18n, 10n ** 18n),
        pool("0x2222222222222222222222222222222222222222", TOKEN_A, "SMK2", 3n * 10n ** 18n, 10n ** 18n),
      ]),
    );

    assert.equal(listings.length, 1);
    const [entry] = listings;
    assert.ok(entry);
    assert.equal(entry.poolCount, 2);
    // Each pool contributes twice its WETH side: (2 + 3) * 2 = 10 ETH.
    assert.equal(entry.ethLiquidity, 10n * 10n ** 18n);
  });

  it("prices from the deepest pool, not the last one seen", () => {
    const listings = listTokens(
      result([
        // Shallow pool implying 1 ETH per token.
        pool("0x1111111111111111111111111111111111111111", TOKEN_A, "SMK2", 10n ** 18n, 10n ** 18n),
        // Deeper pool implying 5 ETH per token.
        pool("0x2222222222222222222222222222222222222222", TOKEN_A, "SMK2", 50n * 10n ** 18n, 10n * 10n ** 18n),
      ]),
    );

    const [entry] = listings;
    assert.ok(entry);
    assert.equal(entry.priceEth, 5);
    assert.equal(entry.deepestPool, "0x2222222222222222222222222222222222222222");
  });

  it("keeps the deepest pool's price when a shallower one is seen afterwards", () => {
    const listings = listTokens(
      result([
        pool("0x2222222222222222222222222222222222222222", TOKEN_A, "SMK2", 50n * 10n ** 18n, 10n * 10n ** 18n),
        pool("0x1111111111111111111111111111111111111111", TOKEN_A, "SMK2", 10n ** 18n, 10n ** 18n),
      ]),
    );

    const [entry] = listings;
    assert.ok(entry);
    assert.equal(entry.priceEth, 5);
    assert.equal(entry.deepestPool, "0x2222222222222222222222222222222222222222");
  });

  it("sorts by liquidity, deepest first", () => {
    const listings = listTokens(
      result([
        pool("0x1111111111111111111111111111111111111111", TOKEN_A, "SMK2", 10n ** 18n, 10n ** 18n),
        pool("0x2222222222222222222222222222222222222222", TOKEN_B, "DMC", 9n * 10n ** 18n, 10n ** 18n),
      ]),
    );

    assert.deepEqual(
      listings.map((entry) => entry.symbol),
      ["DMC", "SMK2"],
    );
  });

  it("returns nothing for an empty scan", () => {
    assert.deepEqual(listTokens(result([])), []);
  });
});
