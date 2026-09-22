import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { decodeFunctionData } from "viem";

import { uniswapV2RouterAbi } from "@/services/abis/uniswap-v2";
import type { Currency } from "@/services/liquidity/types";
import {
  buildAddLiquidity,
  buildRemoveLiquidity,
  UnsupportedPairError,
} from "@/services/liquidity/uniswap-v2/liquidity";
import type { Address } from "@/types/web3";

const ROUTER: Address = "0x89e5DB8B5aA49aA85AC63f691524311AEB649eba";
const RECIPIENT: Address = "0x000000000000000000000000000000000000dEaD";
const DEADLINE = 1_900_000_000n;

const ETH: Currency = { kind: "native", symbol: "ETH", decimals: 18 };
const TOKEN_A: Currency = {
  kind: "erc20",
  address: "0x0d6b6f604C1BF5b3533C445334bb4e1044145688",
  symbol: "SMK2",
  name: "SmokeV2 Token",
  decimals: 18,
};
const TOKEN_B: Currency = {
  kind: "erc20",
  address: "0xF8c0E9B26971C5Df9b754E5E0F5AD78C35770000",
  symbol: "DMC",
  name: "Democratize",
  decimals: 18,
};

/*
  Canonical UniswapV2Router02 selectors. Asserting the literal values catches a typo in
  an ABI signature string, which encodeFunctionData would otherwise turn into a call to
  a function that does not exist on the router.
*/
const SELECTORS = {
  addLiquidity: "0xe8e33700",
  addLiquidityETH: "0xf305d719",
  removeLiquidity: "0xbaa2abde",
  removeLiquidityETH: "0x02751cec",
} as const;

const selectorOf = (data: string) => data.slice(0, 10);

const base = {
  router: ROUTER,
  slippageBps: 50,
  recipient: RECIPIENT,
  deadline: DEADLINE,
};

describe("buildAddLiquidity", () => {
  it("uses addLiquidity for two ERC-20 sides and carries no value", () => {
    const call = buildAddLiquidity({
      ...base,
      currencyA: TOKEN_A,
      currencyB: TOKEN_B,
      amountA: 1_000n,
      amountB: 2_000n,
    });

    assert.equal(call.to, ROUTER);
    assert.equal(call.value, 0n);
    assert.equal(selectorOf(call.data), SELECTORS.addLiquidity);

    const decoded = decodeFunctionData({ abi: uniswapV2RouterAbi, data: call.data });
    assert.equal(decoded.functionName, "addLiquidity");
    assert.deepEqual(decoded.args, [
      TOKEN_A.kind === "erc20" ? TOKEN_A.address : "",
      TOKEN_B.kind === "erc20" ? TOKEN_B.address : "",
      1_000n,
      2_000n,
      995n, // 0.5% below desired
      1_990n,
      RECIPIENT,
      DEADLINE,
    ]);
  });

  it("uses addLiquidityETH and sends the native side as value, whichever side it is", () => {
    const nativeFirst = buildAddLiquidity({
      ...base,
      currencyA: ETH,
      currencyB: TOKEN_A,
      amountA: 10n ** 18n,
      amountB: 5_000n,
    });
    assert.equal(selectorOf(nativeFirst.data), SELECTORS.addLiquidityETH);
    assert.equal(nativeFirst.value, 10n ** 18n);

    const nativeSecond = buildAddLiquidity({
      ...base,
      currencyA: TOKEN_A,
      currencyB: ETH,
      amountA: 5_000n,
      amountB: 10n ** 18n,
    });
    assert.equal(selectorOf(nativeSecond.data), SELECTORS.addLiquidityETH);
    assert.equal(nativeSecond.value, 10n ** 18n);

    // Both orderings must encode identically: same token, token amount and ETH minimum.
    assert.equal(nativeFirst.data, nativeSecond.data);

    const decoded = decodeFunctionData({ abi: uniswapV2RouterAbi, data: nativeFirst.data });
    assert.equal(decoded.functionName, "addLiquidityETH");
    assert.deepEqual(decoded.args, [
      TOKEN_A.kind === "erc20" ? TOKEN_A.address : "",
      5_000n,
      4_975n,
      995_000_000_000_000_000n,
      RECIPIENT,
      DEADLINE,
    ]);
  });

  it("rejects a pair of two native sides", () => {
    assert.throws(
      () => buildAddLiquidity({ ...base, currencyA: ETH, currencyB: ETH, amountA: 1n, amountB: 1n }),
      UnsupportedPairError,
    );
  });

  it("passes the desired amounts through unchanged and only floors the minimums", () => {
    const call = buildAddLiquidity({
      ...base,
      slippageBps: 0,
      currencyA: TOKEN_A,
      currencyB: TOKEN_B,
      amountA: 7n,
      amountB: 9n,
    });
    const decoded = decodeFunctionData({ abi: uniswapV2RouterAbi, data: call.data });
    // With no tolerance the minimums equal the desired amounts.
    assert.deepEqual(decoded.args?.slice(2, 6), [7n, 9n, 7n, 9n]);
  });
});

describe("buildRemoveLiquidity", () => {
  it("uses removeLiquidity for two ERC-20 sides", () => {
    const call = buildRemoveLiquidity({
      ...base,
      currencyA: TOKEN_A,
      currencyB: TOKEN_B,
      liquidity: 500n,
      amountA: 1_000n,
      amountB: 2_000n,
    });

    assert.equal(call.value, 0n);
    assert.equal(selectorOf(call.data), SELECTORS.removeLiquidity);

    const decoded = decodeFunctionData({ abi: uniswapV2RouterAbi, data: call.data });
    assert.equal(decoded.functionName, "removeLiquidity");
    assert.deepEqual(decoded.args?.slice(2, 5), [500n, 995n, 1_990n]);
  });

  it("uses removeLiquidityETH when a side is native and never sends value", () => {
    const call = buildRemoveLiquidity({
      ...base,
      currencyA: ETH,
      currencyB: TOKEN_A,
      liquidity: 500n,
      amountA: 10n ** 18n,
      amountB: 4_000n,
    });

    assert.equal(call.value, 0n);
    assert.equal(selectorOf(call.data), SELECTORS.removeLiquidityETH);

    const decoded = decodeFunctionData({ abi: uniswapV2RouterAbi, data: call.data });
    assert.equal(decoded.functionName, "removeLiquidityETH");
    assert.deepEqual(decoded.args, [
      TOKEN_A.kind === "erc20" ? TOKEN_A.address : "",
      500n,
      3_980n, // token minimum
      995_000_000_000_000_000n, // ETH minimum
      RECIPIENT,
      DEADLINE,
    ]);
  });

  it("rejects a pair of two native sides", () => {
    assert.throws(
      () =>
        buildRemoveLiquidity({
          ...base,
          currencyA: ETH,
          currencyB: ETH,
          liquidity: 1n,
          amountA: 1n,
          amountB: 1n,
        }),
      UnsupportedPairError,
    );
  });
});
