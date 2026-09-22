import "server-only";

import { decodeFunctionResult, encodeFunctionData, erc20Abi, getAddress, hexToString } from "viem";

import { poolixConfig } from "@/config/poolix";
import { uniswapV2FactoryAbi, uniswapV2PairAbi } from "@/services/abis/uniswap-v2";
import { aggregate3Bytes, multicallAvailable, MULTICALL_BATCH_SIZE } from "@/services/chain/multicall";
import { batchedCall, pacedCalls, type RpcCall } from "@/services/chain/rpc";
import type { Address, Hex } from "@/types/web3";

/*
  Robinhood Chain's public RPC throttles after a short burst of batched requests, and
  the factory holds tens of thousands of pairs, so Poolix cannot enumerate all of them
  on demand. This module scans a bounded, paced window of the most recently created
  pairs and reports exactly how much it covered, so the UI can say so rather than imply
  the result is a complete ranking.

  Point RPC_URL at a provider with real limits to widen the window.
*/

const DEFAULT_WINDOW = 300;
/**
 * Hard ceiling on a scan. Several pages can prerender at once, each competing for the
 * same throttled endpoint, and a page that never finishes is worse than one that says
 * how far it got. On timeout the scan returns what it has and `scanned` reflects it.
 */
const SCAN_BUDGET_MS = 20_000;
const TOP_POOLS = 25;
/**
 * Pairs below this hold a rounding error rather than tradeable liquidity, and any
 * trade against them is almost entirely price impact. They are excluded from the
 * ranking; the finder still resolves them by pair.
 */
export const MIN_WETH_RESERVE = 10n ** 14n; // 0.0001 ETH

export interface DiscoveredPool {
  readonly address: Address;
  readonly other: { readonly address: Address; readonly symbol: string; readonly decimals: number };
  /** Reserve of WETH held by the pool, in wei. */
  readonly wethReserve: string;
  readonly otherReserve: string;
}

export interface PoolDiscoveryResult {
  readonly pools: readonly DiscoveredPool[];
  /** How many pairs the factory holds in total. */
  readonly totalPairs: number;
  /** How many of them this scan actually looked at. */
  readonly scanned: number;
  readonly complete: boolean;
}

function decodeAddress(value: Hex | null): Address | null {
  if (value === null || value.length !== 66) return null;
  const address = getAddress(`0x${value.slice(26)}`);
  return address === "0x0000000000000000000000000000000000000000" ? null : address;
}

function decodeReserves(value: Hex | null): { reserve0: bigint; reserve1: bigint } | null {
  if (value === null || value.length < 2 + 64 * 3) return null;
  const body = value.slice(2);
  return {
    reserve0: BigInt(`0x${body.slice(0, 64)}`),
    reserve1: BigInt(`0x${body.slice(64, 128)}`),
  };
}

function decodeString(value: Hex | null): string | null {
  if (value === null) return null;
  try {
    return (decodeFunctionResult({ abi: erc20Abi, functionName: "symbol", data: value }) as string).trim() || null;
  } catch {
    try {
      // bytes32 symbol, used by some older tokens.
      return hexToString(value, { size: 32 }).replace(/\0+$/, "").trim() || null;
    } catch {
      return null;
    }
  }
}

function decodeDecimals(value: Hex | null): number | null {
  if (value === null || value.length < 66) return null;
  const decimals = Number(BigInt(value));
  return Number.isInteger(decimals) && decimals >= 0 && decimals <= 255 ? decimals : null;
}

/**
 * Ceiling on the configured scan window.
 *
 * The window is operator configuration, not user input, so this is not a defence against
 * an attacker — it is a guard against a typo. An extra zero in an environment variable turns
 * a 300-pair scan into a 30,000-pair one against a throttled endpoint, which starves every
 * other reader and shows up as the whole site being slow rather than as a bad setting.
 */
const MAX_WINDOW = 2_000;

const scanWindow = (): number => {
  const configured = Number(process.env.POOLIX_POOL_SCAN_WINDOW);
  if (!Number.isInteger(configured) || configured <= 0) return DEFAULT_WINDOW;
  return Math.min(configured, MAX_WINDOW);
};

const AGGREGATE3_PAUSE_MS = 120;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Reads pair state through Multicall3's aggregate3, falling back to individual batched
 * calls when aggregate3 is unavailable.
 *
 * aggregate3 carries up to 250 calls in one eth_call request. For 2,000 pairs that is
 * 6,000 state calls in 24 HTTP requests instead of 150, reducing the pacing floor from
 * ~18 s to ~3 s and letting the scan complete within SCAN_BUDGET_MS.
 */
async function readPairState(
  calls: readonly RpcCall[],
  deadline: number,
): Promise<readonly (Hex | null)[]> {
  if (!(await multicallAvailable())) return pacedCalls(calls, { deadline });

  const results: (Hex | null)[] = [];
  for (let index = 0; index < calls.length; index += MULTICALL_BATCH_SIZE) {
    if (Date.now() > deadline) {
      results.push(...Array<Hex | null>(calls.length - results.length).fill(null));
      return results;
    }
    if (index > 0) await sleep(AGGREGATE3_PAUSE_MS);
    const slice = calls.slice(index, index + MULTICALL_BATCH_SIZE);
    const batch = await aggregate3Bytes(slice);
    results.push(...(batch ?? Array<Hex | null>(slice.length).fill(null)));
  }
  return results;
}

/**
 * Scans the newest pairs and returns those that hold WETH, ranked by how much WETH
 * they hold. Returns an empty, incomplete result rather than throwing when the chain
 * cannot be reached, so the page can show "Data unavailable".
 */
async function scanPools(): Promise<PoolDiscoveryResult> {
  const deadline = Date.now() + SCAN_BUDGET_MS;
  const { uniswapV2, weth } = poolixConfig.contracts;
  const empty: PoolDiscoveryResult = { pools: [], totalPairs: 0, scanned: 0, complete: false };
  if (uniswapV2.factory.status !== "configured") return empty;

  const factory = uniswapV2.factory.address;
  const wethAddress = getAddress(weth);

  const [lengthResult] = await batchedCall([
    { to: factory, data: encodeFunctionData({ abi: uniswapV2FactoryAbi, functionName: "allPairsLength" }) },
  ]);
  if (lengthResult === null || lengthResult === undefined) return empty;

  const totalPairs = Number(BigInt(lengthResult));
  if (!Number.isSafeInteger(totalPairs) || totalPairs === 0) return { ...empty, totalPairs };

  const window = Math.min(scanWindow(), totalPairs);
  const start = totalPairs - window;

  const addressResults = await pacedCalls(
    Array.from({ length: window }, (_, offset) => ({
      to: factory,
      data: encodeFunctionData({
        abi: uniswapV2FactoryAbi,
        functionName: "allPairs",
        args: [BigInt(start + offset)],
      }),
    })),
    { deadline },
  );

  const pairs = addressResults.map(decodeAddress).filter((address): address is Address => address !== null);
  if (pairs.length === 0) return { ...empty, totalPairs };

  const token0Data = encodeFunctionData({ abi: uniswapV2PairAbi, functionName: "token0" });
  const token1Data = encodeFunctionData({ abi: uniswapV2PairAbi, functionName: "token1" });
  const reservesData = encodeFunctionData({ abi: uniswapV2PairAbi, functionName: "getReserves" });

  const stateResults = await readPairState(
    pairs.flatMap((pair) => [
      { to: pair, data: token0Data },
      { to: pair, data: token1Data },
      { to: pair, data: reservesData },
    ]),
    deadline,
  );

  const candidates: { address: Address; other: Address; wethReserve: bigint; otherReserve: bigint }[] = [];
  // Counted rather than assumed: a scan cut short by the budget inspected fewer pairs
  // than it listed, and the page reports the real figure.
  let inspected = 0;

  for (const [index, pair] of pairs.entries()) {
    const token0 = decodeAddress(stateResults[index * 3] ?? null);
    const token1 = decodeAddress(stateResults[index * 3 + 1] ?? null);
    const reserves = decodeReserves(stateResults[index * 3 + 2] ?? null);
    if (token0 === null || token1 === null || reserves === null) continue;
    inspected++;
    if (reserves.reserve0 === 0n || reserves.reserve1 === 0n) continue;

    const wethIsToken0 = token0 === wethAddress;
    if (!wethIsToken0 && token1 !== wethAddress) continue;

    const wethReserve = wethIsToken0 ? reserves.reserve0 : reserves.reserve1;
    if (wethReserve < MIN_WETH_RESERVE) continue;

    candidates.push({
      address: pair,
      other: wethIsToken0 ? token1 : token0,
      wethReserve,
      otherReserve: wethIsToken0 ? reserves.reserve1 : reserves.reserve0,
    });
  }

  candidates.sort((a, b) => (b.wethReserve > a.wethReserve ? 1 : b.wethReserve < a.wethReserve ? -1 : 0));
  const top = candidates.slice(0, TOP_POOLS);

  const symbolData = encodeFunctionData({ abi: erc20Abi, functionName: "symbol" });
  const decimalsData = encodeFunctionData({ abi: erc20Abi, functionName: "decimals" });
  const metadata = await pacedCalls(
    top.flatMap((candidate) => [
      { to: candidate.other, data: symbolData },
      { to: candidate.other, data: decimalsData },
    ]),
    // Metadata is the last step, so give it a little room past the scan budget.
    { deadline: deadline + 5_000 },
  );

  const pools: DiscoveredPool[] = [];
  for (const [index, candidate] of top.entries()) {
    const decimals = decodeDecimals(metadata[index * 2 + 1] ?? null);
    if (decimals === null) continue; // Without decimals the amounts cannot be shown correctly.
    pools.push({
      address: candidate.address,
      other: {
        address: candidate.other,
        symbol: decodeString(metadata[index * 2] ?? null) ?? `${candidate.other.slice(0, 6)}...`,
        decimals,
      },
      wethReserve: candidate.wethReserve.toString(),
      otherReserve: candidate.otherReserve.toString(),
    });
  }

  return { pools, totalPairs, scanned: inspected, complete: inspected >= totalPairs };
}

const SUCCESS_TTL_MS = 300_000;
/**
 * A throttled or timed-out scan comes back empty. Caching that for the full period
 * would leave the page empty long after the endpoint recovered, so a failure is held
 * only briefly and the next visit retries.
 */
const FAILURE_TTL_MS = 20_000;

let cached: { readonly at: number; readonly value: PoolDiscoveryResult } | null = null;
let inFlight: Promise<PoolDiscoveryResult> | null = null;

/**
 * Shared between requests so the scan does not run per visit, which the public
 * endpoint would throttle and every visitor would wait for. Concurrent callers join
 * the same scan rather than starting their own.
 */
export async function discoverPools(): Promise<PoolDiscoveryResult> {
  const ttl = cached !== null && cached.value.pools.length > 0 ? SUCCESS_TTL_MS : FAILURE_TTL_MS;
  if (cached !== null && Date.now() - cached.at < ttl) return cached.value;
  if (inFlight !== null) return inFlight;

  inFlight = scanPools()
    .then((value) => {
      cached = { at: Date.now(), value };
      return value;
    })
    .catch(() => {
      const value: PoolDiscoveryResult = { pools: [], totalPairs: 0, scanned: 0, complete: false };
      cached = { at: Date.now(), value };
      return value;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}
