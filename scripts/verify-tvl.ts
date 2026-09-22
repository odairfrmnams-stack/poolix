/*
  Independent check of the TVL figure.

    npm run verify:tvl

  Reads the same scanned liquidity the analytics page uses, reads the Chainlink round
  directly, recomputes the USD value here, and asserts every validation rule the UI
  relies on. It does not import services/analytics/eth-price.ts, so a bug in that path
  cannot validate itself.

  No API token is involved: this is plain contract reads over the public RPC.
*/

import { createPublicClient, http, parseAbi, type PublicClient } from "viem";

import { poolixConfig } from "@/config/poolix";
import { isUniswapV2Available } from "@/config/resolve";
import { formatUsd } from "@/lib/format";
import {
  centsToNumber,
  EXPECTED_FEED_DECIMALS,
  MAX_PRICE_AGE_SECONDS,
  priceAgeSeconds,
  usdCentsFrom,
  validateRound,
  type ChainlinkRound,
} from "@/services/analytics/tvl-math";
import { discoverPools } from "@/services/pools/discovery";

const aggregatorAbi = parseAbi([
  "function decimals() view returns (uint8)",
  "function description() view returns (string)",
  "function version() view returns (uint256)",
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
]);

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = String(actual) === String(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"} ${label.padEnd(38)} ${String(actual)}${ok ? "" : `  != ${String(expected)}`}`);
}

async function main(): Promise<void> {
  const feed = poolixConfig.contracts.chainlinkEthUsd;
  console.log("Poolix TVL verification");
  console.log(`network : ${poolixConfig.chain.name} (${poolixConfig.chain.id})`);
  console.log(`feed    : ${feed ?? "(not configured)"}\n`);
  if (feed === null) throw new Error("No ETH/USD feed configured for this network.");

  const client = createPublicClient({
    transport: http(process.env.RPC_URL?.trim() || poolixConfig.rpcUrl, { batch: { wait: 16 } }),
  }) as PublicClient;

  // 1. The liquidity side, from the very same source the page reads.
  const discovery = isUniswapV2Available(poolixConfig)
    ? await discoverPools()
    : { pools: [], totalPairs: 0, scanned: 0, complete: false };
  const liquidityWei = discovery.pools.reduce((total, pool) => total + BigInt(pool.wethReserve) * 2n, 0n);

  console.log("-- liquidity (scanned pools only) --");
  console.log(`  pools counted   : ${discovery.pools.length}`);
  console.log(`  pairs scanned   : ${discovery.scanned.toLocaleString("en-US")} of ${discovery.totalPairs.toLocaleString("en-US")}`);
  console.log(`  liquidity       : ${(Number(liquidityWei) / 1e18).toFixed(4)} ETH`);

  // 2. The price side, read straight from the aggregator.
  const code = await client.getCode({ address: feed });
  check("feed has contract code", code !== undefined && code !== "0x", "true");

  const [decimals, description, version, raw] = await Promise.all([
    client.readContract({ address: feed, abi: aggregatorAbi, functionName: "decimals" }),
    client.readContract({ address: feed, abi: aggregatorAbi, functionName: "description" }),
    client.readContract({ address: feed, abi: aggregatorAbi, functionName: "version" }),
    client.readContract({ address: feed, abi: aggregatorAbi, functionName: "latestRoundData" }),
  ]);

  const round: ChainlinkRound = {
    roundId: raw[0],
    answer: raw[1],
    startedAt: raw[2],
    updatedAt: raw[3],
    answeredInRound: raw[4],
  };
  const now = BigInt(Math.floor(Date.now() / 1000));
  const age = priceAgeSeconds(round, now);

  console.log("\n-- Chainlink ETH/USD --");
  console.log(`  description()   : ${description}`);
  console.log(`  version()       : ${version}`);
  console.log(`  roundId         : ${round.roundId}`);
  console.log(`  answer          : ${round.answer}`);
  console.log(`  updatedAt       : ${round.updatedAt}  (${new Date(Number(round.updatedAt) * 1000).toISOString()})`);
  console.log(`  age             : ${age}s  (${(Number(age) / 3600).toFixed(2)}h of a ${MAX_PRICE_AGE_SECONDS / 3600}h limit)`);
  console.log(`  price           : ${formatUsd(centsToNumber(usdCentsFrom(10n ** 18n, round.answer, Number(decimals))))}`);

  console.log("\n-- validation --");
  check("description is ETH / USD", description.replace(/\s+/g, ""), "ETH/USD");
  check("decimals()", Number(decimals), EXPECTED_FEED_DECIMALS);
  check("answer > 0", round.answer > 0n, "true");
  check("updatedAt > 0", round.updatedAt > 0n, "true");
  check("roundId > 0", round.roundId > 0n, "true");
  check("answeredInRound >= roundId", round.answeredInRound >= round.roundId, "true");
  check("not stale", age <= BigInt(MAX_PRICE_AGE_SECONDS), "true");

  const validation = validateRound(round, { nowSeconds: now, decimals: Number(decimals) });
  check("validateRound accepts", validation.ok, "true");

  // 3. Recompute TVL here and compare with the shared helper.
  console.log("\n-- TVL --");
  if (!validation.ok) {
    console.log(`  feed rejected (${validation.reason}) — the page shows "--", which is correct.`);
  } else {
    const cents = usdCentsFrom(liquidityWei, round.answer, Number(decimals));
    // Recomputed independently from the formula, not via the helper.
    const manual = (liquidityWei * round.answer * 100n) / (10n ** 18n * 10n ** BigInt(decimals));
    check("independent recomputation", cents, manual);
    console.log(`  TVL             : ${formatUsd(centsToNumber(cents))}`);
    console.log(`  (= ${(Number(liquidityWei) / 1e18).toFixed(4)} ETH x ${formatUsd(centsToNumber(usdCentsFrom(10n ** 18n, round.answer, Number(decimals))))})`);
  }

  console.log(`\n${failures === 0 ? "All checks passed." : `${failures} CHECK(S) FAILED`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
