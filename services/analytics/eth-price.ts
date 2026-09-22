import { createPublicClient, http, parseAbi, type PublicClient } from "viem";

import { poolixConfig } from "@/config/poolix";
import {
  priceAgeSeconds,
  validateRound,
  type ChainlinkRound,
  type PriceRejection,
} from "@/services/analytics/tvl-math";

/*
  Reads the Chainlink ETH/USD aggregator.

  Everything the feed exposes is checked before the price is used, and a failure returns
  a reason rather than a number: an unusable oracle must surface as "--", never as a
  stale or mis-scaled dollar figure.
*/

/** Standard Chainlink AggregatorV3Interface, only the parts Poolix reads. */
const aggregatorV3Abi = parseAbi([
  "function decimals() view returns (uint8)",
  "function description() view returns (string)",
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
]);

export type PriceUnavailableReason = PriceRejection | "not-configured" | "unreachable";

export type EthUsdPrice =
  | {
      readonly available: true;
      readonly answer: bigint;
      readonly decimals: number;
      readonly description: string;
      readonly roundId: bigint;
      readonly updatedAt: bigint;
      readonly ageSeconds: bigint;
    }
  | { readonly available: false; readonly reason: PriceUnavailableReason };

/**
 * Fetches and validates the latest round.
 *
 * `decimals()` is read from the contract rather than assumed, and a value other than the
 * expected one is rejected outright: silently trusting a different scale would be off by
 * orders of magnitude.
 */
export async function fetchEthUsdPrice(nowSeconds?: bigint): Promise<EthUsdPrice> {
  const feed = poolixConfig.contracts.chainlinkEthUsd;
  if (feed === null) return { available: false, reason: "not-configured" };

  const rpcUrl = process.env.RPC_URL?.trim() || poolixConfig.rpcUrl;
  const client = createPublicClient({
    transport: http(rpcUrl, { batch: { wait: 16 }, retryCount: 2 }),
  }) as PublicClient;

  let decimals: number;
  let description: string;
  let round: ChainlinkRound;
  try {
    const [rawDecimals, rawDescription, rawRound] = await Promise.all([
      client.readContract({ address: feed, abi: aggregatorV3Abi, functionName: "decimals" }),
      client.readContract({ address: feed, abi: aggregatorV3Abi, functionName: "description" }),
      client.readContract({ address: feed, abi: aggregatorV3Abi, functionName: "latestRoundData" }),
    ]);

    decimals = Number(rawDecimals);
    description = rawDescription;
    round = {
      roundId: rawRound[0],
      answer: rawRound[1],
      startedAt: rawRound[2],
      updatedAt: rawRound[3],
      answeredInRound: rawRound[4],
    };
  } catch {
    return { available: false, reason: "unreachable" };
  }

  const now = nowSeconds ?? BigInt(Math.floor(Date.now() / 1000));
  const validation = validateRound(round, { nowSeconds: now, decimals });
  if (!validation.ok) return { available: false, reason: validation.reason };

  return {
    available: true,
    answer: round.answer,
    decimals,
    description,
    roundId: round.roundId,
    updatedAt: round.updatedAt,
    ageSeconds: priceAgeSeconds(round, now),
  };
}
