import { poolixConfig } from "@/config/poolix";
import type { Address } from "@/types/web3";

/*
  Pons constants, every one of them verified on chain during the Phase 9A audit.

  See PONS_INTEGRATION_AUDIT.md for the evidence behind each address: code size, the
  interface probes that responded, and the cross-references that hold (the position
  manager, swap router and quoter all name the V3 factory below, and the locker names the
  Pons factory below).

  WHAT THE CHAIN SAYS ABOUT THIS FACTORY, which the brief's label does not:

    Its last launch is near block 34,755,546 — 2026-08-12, about 40 days before this was
    written. It has emitted no launch since, no successor factory was found creating 1%
    pools, and no position has entered or left the locker in the most recent 300,000
    blocks. The contract is exactly what the brief says it is; it is simply no longer
    receiving launches.

  That has one hard consequence for the indexer: scanning backwards from the chain head
  finds roughly 34 million empty blocks. Indexing must run FORWARD from the start block
  with a checkpoint, the same shape as the `history` dataset.
*/

/** Verified: first log from the factory lands exactly here. */
export const PONS_FACTORY_START_BLOCK = 8_991_118;

/**
 * The last block at which a launch was observed, located by binary search.
 *
 * Recorded so the indexer and the UI can describe coverage against the factory's actual
 * working range rather than against the chain head, which would make a fully indexed
 * dataset look permanently 50% complete.
 */
export const PONS_LAST_OBSERVED_LAUNCH_BLOCK = 34_755_546;

export const ponsContracts = {
  /** Emits both launch events. 24,353 bytes. */
  factory: "0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB" as Address,
  /** Holds the LP position after launch; `factory()` returns the Pons factory. */
  locker: "0x736D76699C26D0d966744cAe304C000d471f7F35" as Address,
  /** Uniswap V3 factory; named by the position manager, router and quoter. */
  v3Factory: "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA" as Address,
  /** `name()` = "Uniswap V3 Positions NFT-V1". */
  positionManager: "0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3" as Address,
  swapRouter: "0xCaf681a66D020601342297493863E78C959E5cb2" as Address,
  quoterV2: "0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7" as Address,
} as const;

/**
 * The only fee tier Pons uses.
 *
 * Verified twice: the factory's configuration event carries `0x2710`, and every sampled
 * pool reports `fee()` = 10000. `getPool` at 500 and 3000 returns the zero address for
 * these tokens, so a pool at another tier is not a Pons pool.
 */
export const PONS_POOL_FEE = 10_000;

/*
  Event signatures, identified by hash.

  The factory is not verified on the block explorer, so the event NAMES are unknown and are
  deliberately not invented here. Field meanings were established empirically and are
  documented in pons-events.ts.

  Of the factory's seven signatures, five occur exactly once (deployment and configuration).
  Only these two are per-launch, and they fire together in the same transaction — 40,240
  times each across the scanned range, with no divergence.
*/
export const PONS_LAUNCH_TOPIC_A =
  "0x1461370115e1c2be79cb529f8cfcbd11316e789d9c6099fc83417b0b4c48c62a";
export const PONS_LAUNCH_TOPIC_B =
  "0xdb51ea9ad51ab453a65a4cb7e60c3cb378c9501bb002609f8f97778fb6c4235a";

/** Canonical Uniswap V3 `Swap(address,address,int256,int256,uint160,uint128,int24)`. */
export const V3_SWAP_TOPIC =
  "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";

/**
 * Thresholds for the "Qualified" filter.
 *
 * One exported object so the numbers live in exactly one place. Nothing in the UI may
 * restate them as literals — the displayed figures are read from here, so a change of
 * policy is a change of this object and nothing else.
 *
 * These are a numeric filter and carry no judgement: a token that qualifies is not "safe",
 * "good" or "recommended", and nothing in Poolix may describe it that way.
 */
export const PONS_DISCOVERY_CONFIG = {
  minMarketCapUsd: 20_000,
  minVolume24hUsd: 20_000,
} as const;

/** WETH is the quote asset for every Pons pool; taken from the verified Poolix config. */
export const ponsQuoteToken = (): Address => poolixConfig.contracts.weth;

/** Pons only ever existed on Robinhood Chain mainnet. */
export const PONS_CHAIN_ID = 4663;

export function isPonsChain(chainId: number): boolean {
  return chainId === PONS_CHAIN_ID;
}
