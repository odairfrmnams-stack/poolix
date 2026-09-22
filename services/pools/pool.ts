import { getAddress, type PublicClient } from "viem";

import { uniswapV2PairAbi } from "@/services/abis/uniswap-v2";
import { poolShareBps, removeLiquidityAmounts } from "@/services/liquidity/uniswap-v2/math";
import { computePairAddress } from "@/services/liquidity/uniswap-v2/pair";
import type { Currency } from "@/services/liquidity/types";
import { fetchTokenMetadata } from "@/services/tokens/metadata";
import type { Address } from "@/types/web3";

export interface PoolState {
  readonly address: Address;
  readonly token0: Currency;
  readonly token1: Currency;
  readonly reserve0: bigint;
  readonly reserve1: bigint;
  readonly totalSupply: bigint;
}

export interface PoolPosition {
  readonly balance: bigint;
  /** Null when the pool has no supply, so a share cannot be expressed. */
  readonly shareBps: number | null;
  readonly amount0: bigint;
  readonly amount1: bigint;
}

export class PoolNotFoundError extends Error {
  override readonly name = "PoolNotFoundError";
}

/**
 * Reads a pool and proves it belongs to the configured factory. Anyone can deploy a
 * contract that answers token0/token1/getReserves, so the factory check is what
 * separates a real pool from a lookalike.
 */
export async function fetchPool(
  client: PublicClient,
  factory: Address,
  pairAddress: Address,
): Promise<PoolState> {
  const address = getAddress(pairAddress);

  let token0Address: Address;
  let token1Address: Address;
  let pairFactory: Address;
  try {
    [token0Address, token1Address, pairFactory] = await Promise.all([
      client.readContract({ address, abi: uniswapV2PairAbi, functionName: "token0" }),
      client.readContract({ address, abi: uniswapV2PairAbi, functionName: "token1" }),
      client.readContract({ address, abi: uniswapV2PairAbi, functionName: "factory" }),
    ]);
  } catch {
    throw new PoolNotFoundError("No liquidity pool was found at that address.");
  }

  if (getAddress(pairFactory) !== getAddress(factory)) {
    throw new PoolNotFoundError("That contract was not created by the configured factory.");
  }

  const [reserves, totalSupply, token0, token1] = await Promise.all([
    client.readContract({ address, abi: uniswapV2PairAbi, functionName: "getReserves" }),
    client.readContract({ address, abi: uniswapV2PairAbi, functionName: "totalSupply" }),
    fetchTokenMetadata(client, token0Address),
    fetchTokenMetadata(client, token1Address),
  ]);

  const [reserve0, reserve1] = reserves;
  return { address, token0, token1, reserve0, reserve1, totalSupply };
}

/** Resolves the pool for a token pair, or null when the pair was never created. */
export async function fetchPoolForPair(
  client: PublicClient,
  factory: Address,
  tokenA: Address,
  tokenB: Address,
): Promise<PoolState | null> {
  const address = computePairAddress(factory, tokenA, tokenB);
  const code = await client.getCode({ address });
  if (code === undefined || code === "0x") return null;
  return fetchPool(client, factory, address);
}

/** An account's share of a pool, expressed as the underlying token amounts. */
export function readPosition(pool: PoolState, balance: bigint): PoolPosition {
  if (balance <= 0n || pool.totalSupply <= 0n) {
    return { balance, shareBps: poolShareBps(balance, pool.totalSupply), amount0: 0n, amount1: 0n };
  }

  try {
    const { amountA, amountB } = removeLiquidityAmounts(
      balance,
      pool.reserve0,
      pool.reserve1,
      pool.totalSupply,
    );
    return {
      balance,
      shareBps: poolShareBps(balance, pool.totalSupply),
      amount0: amountA,
      amount1: amountB,
    };
  } catch {
    // A dust balance can round to nothing against these reserves.
    return { balance, shareBps: poolShareBps(balance, pool.totalSupply), amount0: 0n, amount1: 0n };
  }
}

/** Reserve of `token` held by the pool, or null when the token is not in the pair. */
export function reserveOf(pool: PoolState, token: Address): bigint | null {
  const target = getAddress(token);
  if (pool.token0.kind === "erc20" && getAddress(pool.token0.address) === target) return pool.reserve0;
  if (pool.token1.kind === "erc20" && getAddress(pool.token1.address) === target) return pool.reserve1;
  return null;
}
