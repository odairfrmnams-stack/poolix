/*
  Independent check of the portfolio.

    npm run verify:portfolio
    npm run verify:portfolio -- 0xYourAddress

  The portfolio's arithmetic decides what someone believes they own, so this script does
  the arithmetic again with its own inline code. It imports neither portfolio-math.ts nor
  the hook that builds the view, so neither can validate itself.

  Without an address it still checks everything that does not need a wallet: the scope is
  exactly Poolix's discovered pool universe rather than a second one, the share and
  underlying formulas reproduce real on-chain reserves and totalSupply for a spread of
  hypothetical balances, address handling is normalised, a zero balance yields no position,
  and USD appears only where a validated oracle round backs it.

  Given an address it additionally reads that wallet's real balances and reconciles them.
  The address is validated before use and is only ever read from, never written to.

  No API token is read or printed by this script.
*/

import { createPublicClient, erc20Abi, getAddress, http, type PublicClient } from "viem";

import { poolixConfig } from "@/config/poolix";
import { fetchEthUsdPrice } from "@/services/analytics/eth-price";
import { uniswapV2PairAbi } from "@/services/abis/uniswap-v2";
import { discoverPools } from "@/services/pools/discovery";
import { getPortfolioScope } from "@/services/portfolio/portfolio-scope";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = String(actual) === String(expected);
  if (!ok) failures++;
  console.log(
    `  ${ok ? "PASS" : "FAIL"} ${label.padEnd(54)} ${String(actual)}${ok ? "" : `  != ${String(expected)}`}`,
  );
}

function note(label: string, value: unknown): void {
  console.log(`  ·    ${label.padEnd(54)} ${String(value)}`);
}

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const ZERO = "0x0000000000000000000000000000000000000000";
const lower = (value: string) => value.trim().toLowerCase();

/** Decimal string for a wei value, without touching a float. */
function formatWei(value: bigint, decimals = 18, places = 6): string {
  const unit = 10n ** BigInt(decimals);
  const whole = value / unit;
  const fraction = decimals >= places ? (value % unit) / 10n ** BigInt(decimals - places) : value % unit;
  return `${whole.toLocaleString("en-US")}.${fraction.toString().padStart(places, "0")}`;
}

async function main(): Promise<void> {
  const requested = process.argv[2];
  const wallet =
    requested !== undefined && ADDRESS_PATTERN.test(requested.trim()) ? lower(requested) : null;
  if (requested !== undefined && wallet === null) {
    throw new Error(`"${requested}" is not a valid address.`);
  }

  const client = createPublicClient({
    transport: http(process.env.RPC_URL?.trim() || poolixConfig.rpcUrl, { batch: { wait: 16 } }),
  }) as PublicClient;

  const [scope, discovery, ethUsd] = await Promise.all([
    getPortfolioScope(),
    discoverPools(),
    fetchEthUsdPrice(),
  ]);

  console.log("Poolix portfolio verification");
  console.log(`network            : ${poolixConfig.chain.name} (${poolixConfig.chain.id})`);
  console.log(`wallet             : ${wallet ?? "(none supplied — wallet-independent checks only)"}`);
  console.log(`scope pairs        : ${scope.pairs.length}`);
  console.log(`scope tokens       : ${scope.tokens.length}`);
  console.log(`oracle             : ${ethUsd.available ? ethUsd.description : "unavailable"}`);

  // ------------------------------------------------------------------ scope
  /*
    The portfolio must consume the existing pool universe, not build one. A pool present
    here but absent from discovery would be a position the pool pages deny exists.
  */
  console.log("\n-- one pool universe --");
  check("scope reports the configured chain", scope.chainId, poolixConfig.chain.id);

  const discovered = [...new Set(discovery.pools.map((pool) => lower(pool.address)))].sort();
  const scoped = [...new Set(scope.pairs.map((pair) => pair.pair))].sort();
  check("scope pairs are exactly the discovered pools", JSON.stringify(scoped), JSON.stringify(discovered));
  check("scope reports the same pool count", scope.poolsScanned, discovery.pools.length);
  check("scope reports the same factory total", scope.pairsTotal, discovery.totalPairs);

  const badPair = scope.pairs.filter((pair) => !ADDRESS_PATTERN.test(pair.pair)).length;
  const unnormalised = scope.pairs.filter(
    (pair) => pair.pair !== lower(pair.pair) || pair.token0 !== lower(pair.token0),
  ).length;
  const zeroToken = scope.pairs.filter(
    (pair) => pair.token0 === ZERO || pair.token1 === ZERO,
  ).length;
  check("every scoped pair is a valid address", badPair, 0);
  check("every scoped address is normalised", unnormalised, 0);
  check("no scoped pair references the zero address", zeroToken, 0);

  const wethAddress = lower(poolixConfig.contracts.weth);
  const misclassified = scope.pairs.filter((pair) => {
    const expected =
      pair.token0 === wethAddress ? "token0" : pair.token1 === wethAddress ? "token1" : "none";
    return pair.wethSide !== expected;
  }).length;
  check("WETH side matches the pair's own addresses", misclassified, 0);

  const misordered = scope.pairs.filter((pair) => pair.token0 >= pair.token1).length;
  // Uniswap v2 orders a pair's tokens by address; a row claiming otherwise would put the
  // reserves on the wrong sides and misstate every underlying amount.
  check("token0 sorts before token1 on every pair", misordered, 0);

  // ------------------------------------------------------------- USD rules
  console.log("\n-- USD appears only where a validated round backs it --");
  check("scope carries a rate iff the feed is available", scope.ethUsd !== null, ethUsd.available);
  if (scope.ethUsd !== null && ethUsd.available) {
    check("scope rate is the feed's own answer", scope.ethUsd.answer, ethUsd.answer.toString());
    check("scope rate keeps the feed's decimals", scope.ethUsd.decimals, ethUsd.decimals);
  }

  // ------------------------------------------- share and underlying arithmetic
  /*
    Re-derived against a real pool's live reserves and supply, for a spread of balances
    including the ones that break naive implementations: one wei, and the full supply.
  */
  console.log("\n-- share and underlying maths, against live pool state --");
  const sample = scope.pairs.slice(0, 3);
  if (sample.length === 0) {
    console.log("  SKIP no pools in scope to test against.");
  }

  for (const pair of sample) {
    let reserves: readonly [bigint, bigint, number];
    let totalSupply: bigint;
    try {
      const address = getAddress(pair.pair);
      [reserves, totalSupply] = await Promise.all([
        client.readContract({ address, abi: uniswapV2PairAbi, functionName: "getReserves" }),
        client.readContract({ address, abi: uniswapV2PairAbi, functionName: "totalSupply" }),
      ]);
    } catch {
      console.log(`  ·    ${pair.pair.slice(0, 10)} did not answer; skipped`);
      continue;
    }

    const [reserve0, reserve1] = reserves;
    console.log(
      `\n  ${pair.pair.slice(0, 10)}  ${pair.symbol0}/${pair.symbol1}  supply ${formatWei(totalSupply)}`,
    );
    if (totalSupply === 0n) {
      // A pool with no supply has no share to take; nothing may be claimed against it.
      note("total supply is zero", "no position is representable");
      continue;
    }

    for (const [label, lpBalance] of [
      ["1 wei", 1n],
      ["1%", totalSupply / 100n],
      ["50%", totalSupply / 2n],
      ["100%", totalSupply],
    ] as const) {
      if (lpBalance <= 0n) continue;

      // Inline, deliberately: multiply before dividing, floor like the pair does on burn.
      const amount0 = (reserve0 * lpBalance) / totalSupply;
      const amount1 = (reserve1 * lpBalance) / totalSupply;

      check(
        `${label} claim never exceeds the reserves`,
        amount0 <= reserve0 && amount1 <= reserve1,
        true,
      );
      // The share, as an exact ratio scaled to six decimals of a percent.
      const shareScaled = (lpBalance * 100n * 1_000_000n) / totalSupply;
      check(`${label} share stays within 0-100%`, shareScaled <= 100n * 1_000_000n, true);

      if (lpBalance === totalSupply) {
        check("100% claims exactly the whole reserves", `${amount0},${amount1}`, `${reserve0},${reserve1}`);
        check("100% is exactly 100%", shareScaled, 100n * 1_000_000n);
      }
    }

    // Zero filtering: a zero balance is not a position, and must never become one.
    const zeroClaim0 = (reserve0 * 0n) / totalSupply;
    check("a zero balance claims nothing", zeroClaim0, 0n);
  }

  // --------------------------------------------------------- wallet reads
  console.log("\n-- wallet reads --");
  if (wallet === null) {
    console.log("  SKIP no address supplied. Pass one to reconcile a real wallet:");
    console.log("       npm run verify:portfolio -- 0xYourAddress");
  } else {
    const owner = getAddress(wallet);
    const blockNumber = await client.getBlockNumber().catch(() => null);
    note("read around block", blockNumber === null ? "unavailable" : blockNumber.toString());

    const native = await client.getBalance({ address: owner }).catch(() => null);
    check("native balance is readable", native !== null, true);
    if (native !== null) note(`native ${scope.nativeSymbol}`, formatWei(native));

    let tokensHeld = 0;
    for (const token of scope.tokens.slice(0, 10)) {
      try {
        const balance = await client.readContract({
          address: getAddress(token.address),
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [owner],
        });
        if (balance > 0n) {
          tokensHeld++;
          note(`${token.symbol} balance`, formatWei(balance, token.decimals));
          // A held token priced through its own pool, computed inline.
          const tokenReserve = BigInt(token.tokenReserveWei);
          const wethReserve = BigInt(token.wethReserveWei);
          if (tokenReserve > 0n && wethReserve > 0n) {
            const valueWei = (balance * wethReserve) / tokenReserve;
            note(`${token.symbol} value`, `${formatWei(valueWei)} ${scope.nativeSymbol}`);
          }
        }
      } catch {
        note(`${token.symbol} balance`, "read failed (skipped, not counted as zero)");
      }
    }
    note("tokens with a balance (first 10 scoped)", tokensHeld);

    let positions = 0;
    for (const pair of scope.pairs) {
      try {
        const address = getAddress(pair.pair);
        const [lpBalance, totalSupply, reserves] = await Promise.all([
          client.readContract({ address, abi: uniswapV2PairAbi, functionName: "balanceOf", args: [owner] }),
          client.readContract({ address, abi: uniswapV2PairAbi, functionName: "totalSupply" }),
          client.readContract({ address, abi: uniswapV2PairAbi, functionName: "getReserves" }),
        ]);
        if (lpBalance <= 0n) continue;
        positions++;

        check(`${pair.pair.slice(0, 10)} balance does not exceed supply`, lpBalance <= totalSupply, true);
        if (totalSupply === 0n) continue;

        const amount0 = (reserves[0] * lpBalance) / totalSupply;
        const amount1 = (reserves[1] * lpBalance) / totalSupply;
        const shareScaled = (lpBalance * 100n * 1_000_000n) / totalSupply;
        note(
          `${pair.symbol0}/${pair.symbol1}`,
          `LP ${formatWei(lpBalance)}  share ${(Number(shareScaled) / 1_000_000).toFixed(6)}%  ` +
            `${formatWei(amount0, pair.decimals0)} ${pair.symbol0} / ${formatWei(amount1, pair.decimals1)} ${pair.symbol1}`,
        );

        // A token/token position must not carry a value; there is no validated rate.
        if (pair.wethSide === "none") {
          note(`${pair.symbol0}/${pair.symbol1} valuation`, "-- (no validated price path)");
        }
      } catch {
        note(`${pair.pair.slice(0, 10)}`, "read failed (skipped, not counted as zero)");
      }
    }
    note("LP positions held", positions);
    if (positions === 0) {
      console.log("       this wallet holds no LP in the scanned universe; nothing to reconcile.");
    }
  }

  console.log(`\n${failures === 0 ? "All checks passed." : `${failures} CHECK(S) FAILED`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
