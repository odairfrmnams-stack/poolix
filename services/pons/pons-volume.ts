import "server-only";

import { fetchHyperSyncHeight, fetchLogsPaged } from "@/services/analytics/hypersync";
import { V3_SWAP_TOPIC } from "@/services/pons/pons-config";
import { decodeV3Swap, type RawLog } from "@/services/pons/pons-events";
import { swapQuoteVolumeWei } from "@/services/pons/pons-math";

/*
  24-hour trading volume for Pons pools, from Uniswap V3 Swap events.

  A SEPARATE MODULE ON PURPOSE. Poolix's existing volume pipeline reads Uniswap V2 Swap
  events, whose shape and semantics are different: V2 emits four unsigned amounts, V3 emits
  two signed ones. Feeding V3 logs through the V2 aggregator would produce numbers that are
  wrong in a way nothing would catch, and modifying the V2 aggregator to understand both
  would change a methodology that four verifiers depend on. So this is its own code path
  and shares nothing with it but the transport.

  COMPLETENESS IS PART OF THE ANSWER. The window is 24 hours of blocks; if the read does
  not cover all of them, the figure is withheld rather than reported low. A partial sum is
  always an undercount and never announces itself, which is exactly the failure that
  Phase 5 spent a week removing from the V2 path.
*/

/** Robinhood Chain produces roughly 10 blocks per second. */
const BLOCKS_PER_SECOND = 10;
const WINDOW_SECONDS = 24 * 60 * 60;
export const VOLUME_WINDOW_BLOCKS = WINDOW_SECONDS * BLOCKS_PER_SECOND;

/** Kept small: the sweep runs inside an indexer tick that must fit in ~15 s overall. */
const TICK_BUDGET_MS = 6_000;
/** Pools per query. Keeps the address filter to a size the indexer answers quickly. */
const POOLS_PER_QUERY = 150;

export interface PoolVolume {
  /** Absolute WETH turnover over the window, in wei. */
  readonly quoteVolumeWei: bigint;
  readonly swaps: number;
}

export interface VolumeWindow {
  readonly available: boolean;
  /** False when the block range was not fully read; every figure is then unusable. */
  readonly complete: boolean;
  readonly fromBlock: number;
  readonly toBlock: number;
  readonly byPool: ReadonlyMap<string, PoolVolume>;
  readonly poolsQueried: number;
  readonly swapsCounted: number;
  readonly updatedAt: number;
}

const EMPTY: VolumeWindow = {
  available: false,
  complete: false,
  fromBlock: 0,
  toBlock: 0,
  byPool: new Map(),
  poolsQueried: 0,
  swapsCounted: 0,
  updatedAt: 0,
};

export interface PoolScope {
  readonly pool: string;
  /** Which side of the pool holds WETH; decided when the pool was verified. */
  readonly quoteIsToken1: boolean;
}

/**
 * Sums WETH turnover per pool over the last 24 hours.
 *
 * Only pools whose WETH side is already known are accepted — without it there is no way to
 * tell which of a swap's two amounts is the quote asset, and guessing would attribute a
 * token amount as if it were ETH.
 */
export async function fetchPonsVolume(scopes: readonly PoolScope[]): Promise<VolumeWindow> {
  if (scopes.length === 0) return { ...EMPTY, available: true, complete: true, updatedAt: Date.now() };

  const head = await fetchHyperSyncHeight();
  if (head === null) return EMPTY;

  const toBlock = head;
  const fromBlock = Math.max(head - VOLUME_WINDOW_BLOCKS, 0);
  const deadline = Date.now() + TICK_BUDGET_MS;

  const sideByPool = new Map<string, boolean>();
  for (const scope of scopes) sideByPool.set(scope.pool.toLowerCase(), scope.quoteIsToken1);

  const byPool = new Map<string, PoolVolume>();
  let swapsCounted = 0;
  let complete = true;

  const pools = [...sideByPool.keys()];
  for (let index = 0; index < pools.length; index += POOLS_PER_QUERY) {
    if (Date.now() >= deadline) {
      complete = false;
      break;
    }
    const slice = pools.slice(index, index + POOLS_PER_QUERY);
    const page = await fetchLogsPaged<RawLog>({
      fromBlock,
      toBlock,
      addresses: slice,
      topics: [[V3_SWAP_TOPIC]],
      fields: ["block_number", "address", "topic0", "data"],
      deadline,
    });

    // One short read makes the whole window incomplete: the caller cannot use a figure
    // that is missing an unknown share of its trades.
    if (!page.complete) complete = false;

    for (const log of page.logs) {
      const swap = decodeV3Swap(log);
      if (swap === null) continue;
      const quoteIsToken1 = sideByPool.get(swap.pool);
      if (quoteIsToken1 === undefined) continue;

      const volume = swapQuoteVolumeWei(swap.amount0, swap.amount1, quoteIsToken1);
      const existing = byPool.get(swap.pool);
      byPool.set(swap.pool, {
        quoteVolumeWei: (existing?.quoteVolumeWei ?? 0n) + volume,
        swaps: (existing?.swaps ?? 0) + 1,
      });
      swapsCounted++;
    }
  }

  return {
    available: true,
    complete,
    fromBlock,
    toBlock,
    byPool,
    poolsQueried: pools.length,
    swapsCounted,
    updatedAt: Date.now(),
  };
}
