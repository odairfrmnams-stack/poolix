import { encodePacked, getAddress, getCreate2Address, keccak256 } from "viem";

import type { Address } from "@/types/web3";

/**
 * Creation code hash of the canonical UniswapV2Pair. Confirmed against the Robinhood
 * Chain factory by `npm run verify:chain`, which derives live pair addresses with it
 * and compares them to factory.getPair.
 */
export const UNISWAP_V2_INIT_CODE_HASH =
  "0x96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f" as const;

export class IdenticalAddressesError extends Error {
  override readonly name = "IdenticalAddressesError";
}

/** Pairs store the numerically smaller address as token0. */
export function sortTokens(tokenA: Address, tokenB: Address): readonly [Address, Address] {
  const a = getAddress(tokenA);
  const b = getAddress(tokenB);
  if (a === b) throw new IdenticalAddressesError("A pair needs two different tokens.");
  return a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
}

/**
 * Derives a pair address with CREATE2 instead of calling factory.getPair, which saves
 * a round trip on every quote. The caller still has to read the pair to learn whether
 * it exists and holds reserves.
 */
export function computePairAddress(factory: Address, tokenA: Address, tokenB: Address): Address {
  const [token0, token1] = sortTokens(tokenA, tokenB);
  return getCreate2Address({
    from: getAddress(factory),
    salt: keccak256(encodePacked(["address", "address"], [token0, token1])),
    bytecodeHash: UNISWAP_V2_INIT_CODE_HASH,
  });
}

/** Orients a pair's reserves for a swap that sends `tokenIn`. */
export function orientReserves(
  tokenIn: Address,
  token0: Address,
  reserve0: bigint,
  reserve1: bigint,
): { reserveIn: bigint; reserveOut: bigint } {
  return getAddress(tokenIn) === getAddress(token0)
    ? { reserveIn: reserve0, reserveOut: reserve1 }
    : { reserveIn: reserve1, reserveOut: reserve0 };
}
