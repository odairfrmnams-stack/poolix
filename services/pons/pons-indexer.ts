import "server-only";

import { encodeFunctionData, erc20Abi } from "viem";

import { poolixConfig } from "@/config/poolix";
import { isUsableDecimals, sanitizeName, sanitizeSymbol } from "@/lib/token-text";
import { fetchEthUsdPrice } from "@/services/analytics/eth-price";
import { fetchHyperSyncHeight, fetchLogsPaged, hasHyperSyncToken } from "@/services/analytics/hypersync";
import { pacedCalls, type RpcCall } from "@/services/chain/rpc";
import { marketCapUsdCents, priceInQuoteE18, volumeUsdCents } from "@/services/pons/pons-math";
import { fetchPonsVolume } from "@/services/pons/pons-volume";
import {
  isPonsChain,
  PONS_FACTORY_START_BLOCK,
  PONS_LAST_OBSERVED_LAUNCH_BLOCK,
  PONS_LAUNCH_TOPIC_A,
  PONS_LAUNCH_TOPIC_B,
  PONS_POOL_FEE,
  ponsContracts,
  ponsQuoteToken,
} from "@/services/pons/pons-config";
import { pairLaunches, type RawLog } from "@/services/pons/pons-events";
import {
  loadPonsState,
  PONS_MAX_RECORDS,
  savePonsState,
  type PonsLaunchRecord,
  type PonsState,
} from "@/services/pons/pons-cache";
import { workerLog } from "@/services/storage/log";
import type { Address, Hex } from "@/types/web3";

/*
  The Pons launch indexer.

  DIRECTION MATTERS. The factory's last launch is near block 34,755,546 and the chain head
  is past 68,700,000, so scanning backwards from the head walks roughly 34 million empty
  blocks before finding anything. Indexing therefore runs FORWARD from the factory's start
  block with a persisted checkpoint, exactly like the `history` dataset — each tick extends
  coverage a bounded amount and records how far it got.

  NOTHING IS TRUSTED FROM THE EVENT. The pool address in event B is verified against
  `v3Factory.getPool(token, WETH, 10000)` before a record is marked verified, and the token's
  own metadata is read from its contract. A launch whose pool does not confirm stays in the
  dataset as unverified rather than being dropped — it happened, and hiding it would be its
  own kind of dishonesty — but it cannot qualify.
*/

/*
  Two budgets, not one.

  Sharing a single deadline between the log sweep and the metadata reads meant the sweep
  always consumed it first — the tick indexed thousands of launches and then skipped
  enrichment entirely, so every record stayed unverified and unpriced for ever. They are
  separate phases with separate costs, so they get separate budgets.
*/
/*
  A whole tick must fit comfortably inside fifteen seconds.

  These were three times larger, and the tick ran for about fifty. Because the tick is
  scheduled with `after()`, that time counts towards the page's build budget, and both
  /explore and /analytics started failing prerender with "took more than 60 seconds" —
  /analytics only because it shares the budget with the holder tick. Indexing is
  incremental and checkpointed, so a smaller slice per tick costs more ticks and nothing
  else.
*/
const INDEX_BUDGET_MS = 6_000;
const ENRICH_BUDGET_MS = 5_000;
const PRICE_BUDGET_MS = 4_000;
/** Pools priced per tick. The newest, since those are the ones the view lists. */
const MAX_PRICED_POOLS = 60;
/**
 * Blocks per tick.
 *
 * Sized so the slice actually finishes inside INDEX_BUDGET_MS. At two million the sweep
 * never completed, so the checkpoint never moved and the window stayed pinned at its
 * starting block through every tick — indexing looked like it was working while coverage
 * sat at zero.
 */
const BLOCKS_PER_TICK = 400_000;
/** Metadata reads per tick, so a tick that discovers thousands does not stall on RPC. */
const MAX_METADATA_PER_TICK = 120;

const LOG_FIELDS = ["block_number", "transaction_hash", "log_index", "address", "topic0", "topic1", "topic2", "topic3", "data"];

export interface PonsIndexSummary {
  readonly available: boolean;
  readonly records: readonly PonsLaunchRecord[];
  /** Launches held in the dataset. NEVER described as the total number of Pons launches. */
  readonly indexedTokenCount: number;
  readonly verifiedCount: number;
  readonly withMetadataCount: number;
  /** Launches Poolix can actually trade: a Uniswap v2 pair exists. */
  readonly v2AvailableCount: number;
  /** Launches whose v2 factory answer has been read at all. */
  readonly v2CheckedCount: number;
  readonly indexedBlock: number;
  readonly startBlock: number;
  /** The block indexing is working towards: the factory's last observed launch. */
  readonly targetBlock: number;
  readonly chainHead: number | null;
  readonly coveragePercent: number | null;
  readonly complete: boolean;
  /** True when the record cap stopped the window growing, rather than the factory's start. */
  readonly atCapacity: boolean;
  readonly updatedAt: number | null;
  /** The 24-hour window the persisted volume figures describe. */
  readonly volumeFromBlock: number;
  readonly volumeToBlock: number;
  readonly volumeWindowComplete: boolean;
  readonly quoteUsdAvailable: boolean;
  readonly unavailableReason: "not-configured" | "wrong-chain" | "no-indexer-token" | null;
}

const EMPTY: PonsIndexSummary = {
  available: false,
  records: [],
  indexedTokenCount: 0,
  verifiedCount: 0,
  withMetadataCount: 0,
  v2AvailableCount: 0,
  v2CheckedCount: 0,
  indexedBlock: PONS_FACTORY_START_BLOCK,
  startBlock: PONS_FACTORY_START_BLOCK,
  targetBlock: PONS_LAST_OBSERVED_LAUNCH_BLOCK,
  chainHead: null,
  coveragePercent: null,
  complete: false,
  atCapacity: false,
  updatedAt: null,
  volumeFromBlock: 0,
  volumeToBlock: 0,
  volumeWindowComplete: false,
  quoteUsdAvailable: false,
  unavailableReason: "not-configured",
};

const decodeString = (hex: Hex | null): string | null => {
  if (hex === null || hex.length < 130) return null;
  try {
    const length = Number(BigInt(`0x${hex.slice(66, 130)}`));
    if (length === 0 || length > 1024) return null;
    return Buffer.from(hex.slice(130, 130 + length * 2), "hex").toString("utf8");
  } catch {
    return null;
  }
};

const decodeUint = (hex: Hex | null): bigint | null => {
  if (hex === null || hex.length < 66) return null;
  try {
    return BigInt(hex.slice(0, 66));
  } catch {
    return null;
  }
};

const padWord = (value: string) => value.replace("0x", "").toLowerCase().padStart(64, "0");

/** getPool(address,address,uint24) on the V3 factory — Pons reference data only. */
function encodeGetPool(token: Address, quote: Address, fee: number): Hex {
  return `0x1698ee82${padWord(token)}${padWord(quote)}${fee.toString(16).padStart(64, "0")}` as Hex;
}

/**
 * getPair(address,address) on the Uniswap v2 factory.
 *
 * This is the question that decides whether Poolix can trade a token at all. It is asked
 * of the v2 factory directly and is never inferred from Pons data — the existence of a v3
 * pool says nothing about whether a v2 pair exists, and the Phase 9A audit found that for
 * Pons tokens it usually does not.
 */
function encodeGetPair(token: Address, quote: Address): Hex {
  return `0xe6a43905${padWord(token)}${padWord(quote)}` as Hex;
}

/*
  Reads go through the batched JSON-RPC path, NOT through aggregate3.

  This is not a preference. `services/chain/multicall.ts` decodes a result only when it is
  an explicit success carrying exactly one 32-byte word — a deliberate Phase 6 rule that
  makes it impossible for a failed `balanceOf` to be mistaken for a zero balance, and the
  holder pipeline depends on it. Pons enrichment needs `symbol()`, which returns a dynamic
  string across several words, so every such call came back null: symbols were silently
  missing from every record until this was traced.

  Loosening the codec would weaken a control the holder count rests on. `pacedCalls`
  returns raw result data of any length and is already paced and retried, so it is the
  right tool here and the Phase 6 rule stays exactly as it is.
*/
async function readCalls(calls: readonly RpcCall[], deadline: number): Promise<readonly (Hex | null)[]> {
  if (calls.length === 0) return [];
  return pacedCalls(calls, { deadline });
}

/**
 * Reads metadata and confirms the pool for a batch of launches.
 *
 * Six reads per launch, issued as one flat batch so the multicall does the work rather
 * than six sequential passes.
 */
async function enrich(
  records: PonsLaunchRecord[],
  deadline: number,
): Promise<{ enriched: number; verified: number }> {
  const quote = ponsQuoteToken();
  const v2 = poolixConfig.contracts.uniswapV2.factory;
  const v2Factory = v2.status === "configured" ? v2.address : null;
  const calls: RpcCall[] = [];
  for (const record of records) {
    const token = record.tokenAddress as Address;
    calls.push({ to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "name" }) });
    calls.push({ to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "symbol" }) });
    calls.push({ to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "decimals" }) });
    calls.push({ to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "totalSupply" }) });
    calls.push({ to: ponsContracts.v3Factory, data: encodeGetPool(token, quote, PONS_POOL_FEE) });
    // token0() on the pool named by the event: proves the address is a pool at all.
    calls.push({ to: record.poolAddress as Address, data: "0x0dfe1681" as Hex });
    // The v2 question: can Poolix actually trade this token?
    calls.push(
      v2Factory === null
        ? { to: token, data: "0x313ce567" as Hex } // placeholder, ignored below
        : { to: v2Factory, data: encodeGetPair(token, quote) },
    );
  }

  const results = await readCalls(calls, deadline);

  let enriched = 0;
  let verified = 0;
  for (const [index, record] of records.entries()) {
    const base = index * 7;
    const name = sanitizeName(decodeString(results[base] ?? null));
    const symbol = sanitizeSymbol(decodeString(results[base + 1] ?? null));
    const decimalsRaw = decodeUint(results[base + 2] ?? null);
    const supply = decodeUint(results[base + 3] ?? null);
    const poolFromFactory = results[base + 4] ?? null;
    const poolToken0 = results[base + 5] ?? null;
    const v2PairResult = results[base + 6] ?? null;

    /*
      The v2 pair, read straight from the v2 factory.

      A null RESULT means the call did not answer, which is not the same as "no pair" —
      `v2CheckedAt` stays null so the record is retried rather than being recorded as
      untradeable on the strength of a failed read.
    */
    if (v2Factory !== null && v2PairResult !== null && v2PairResult.length >= 66) {
      const pair = `0x${v2PairResult.slice(26, 66)}`.toLowerCase();
      record.v2PairAddress = pair === `0x${"0".repeat(40)}` ? null : pair;
      record.v2CheckedAt = Date.now();
    }

    const decimals = decimalsRaw === null ? null : Number(decimalsRaw);
    /*
      Metadata is only accepted whole. A token with a readable symbol but an unreadable or
      out-of-range `decimals` cannot have any amount rendered for it correctly, so it is
      left without metadata rather than shown with a plausible-looking half.
    */
    if (decimals !== null && isUsableDecimals(decimals) && supply !== null && supply > 0n) {
      record.name = name;
      record.symbol = symbol;
      record.decimals = decimals;
      record.totalSupply = supply.toString();
      enriched++;
    }

    /*
      Pool verification: the factory must independently return the same address the event
      carried, AND that address must behave like a pool. Either check alone is weaker —
      a non-zero factory answer proves a pool exists, and token0() proves the address in
      the event is the thing being described.
    */
    if (poolFromFactory !== null && poolToken0 !== null) {
      const factoryPool = `0x${poolFromFactory.slice(26, 66)}`.toLowerCase();
      const eventPool = record.poolAddress.toLowerCase();
      const token0 = `0x${poolToken0.slice(26, 66)}`.toLowerCase();
      const quoteLower = quote.toLowerCase();
      const tokenLower = record.tokenAddress.toLowerCase();

      const poolsAgree = factoryPool === eventPool && factoryPool !== "0x" + "0".repeat(40);
      const token0Known = token0 === tokenLower || token0 === quoteLower;
      if (poolsAgree && token0Known) {
        record.poolVerified = true;
        record.quoteIsToken1 = token0 === tokenLower;
        verified++;
      } else {
        record.poolVerified = false;
      }
    }
  }
  return { enriched, verified };
}

const decodeSqrtPrice = (hex: Hex | null): bigint | null => {
  if (hex === null || hex.length < 66) return null;
  try {
    const value = BigInt(hex.slice(0, 66));
    return value > 0n ? value : null;
  } catch {
    return null;
  }
};

/** slot0() per pool. Seven words, so this uses the batched RPC path, not aggregate3. */
async function readSlot0(pools: readonly string[], deadline: number): Promise<Map<string, bigint>> {
  const prices = new Map<string, bigint>();
  if (pools.length === 0) return prices;

  const calls: RpcCall[] = pools.map((pool) => ({ to: pool as Address, data: "0x3850c7bd" as Hex }));
  const results = await pacedCalls(calls, { deadline });

  for (const [index, pool] of pools.entries()) {
    const sqrtPrice = decodeSqrtPrice(results[index] ?? null);
    if (sqrtPrice !== null) prices.set(pool, sqrtPrice);
  }
  return prices;
}

/**
 * Prices a bounded slice of verified pools and sums their 24-hour volume, writing the
 * results onto the records.
 *
 * Newest first, matching what the view lists. Only verified pools with known decimals and
 * a known WETH side are priced: without the orientation the two pool amounts cannot be
 * told apart, and a guess would report a token amount as if it were ETH.
 */
async function priceRecords(state: PonsState): Promise<void> {
  const priceable = Object.values(state.byToken)
    .filter((record) => record.poolVerified && record.decimals !== null && record.quoteIsToken1 !== null)
    .sort((a, b) => b.launchBlock - a.launchBlock)
    .slice(0, MAX_PRICED_POOLS);

  if (priceable.length === 0) return;

  const deadline = Date.now() + PRICE_BUDGET_MS;
  const [ethUsd, sqrtPrices] = await Promise.all([
    fetchEthUsdPrice(),
    readSlot0(priceable.map((record) => record.poolAddress), deadline),
  ]);

  /*
    The swap sweep runs every tick, for exactly the pools being priced.

    Skipping it on "fresh" ticks was a false economy: the set of priced pools changes as
    enrichment reaches new records, so a record priced on a skipped tick was left with no
    volume figure at all and could never qualify. It is one indexer query for the whole
    batch, not one per pool, so the saving was small and the cost was a permanently
    incomplete column.
  */
  const now = Date.now();
  const volume = await fetchPonsVolume(
    priceable.map((record) => ({
      pool: record.poolAddress,
      quoteIsToken1: record.quoteIsToken1 === true,
    })),
  );

  const quoteUsdAnswer = ethUsd.available ? ethUsd.answer : null;
  const quoteUsdDecimals = ethUsd.available ? ethUsd.decimals : null;

  for (const record of priceable) {
    const sqrtPriceX96 = sqrtPrices.get(record.poolAddress) ?? null;
    const decimals = record.decimals;
    if (decimals === null || record.quoteIsToken1 === null) continue;

    const price =
      sqrtPriceX96 === null
        ? null
        : priceInQuoteE18({
            sqrtPriceX96,
            quoteIsToken1: record.quoteIsToken1,
            tokenDecimals: decimals,
            quoteDecimals: 18,
          });

    const cap = marketCapUsdCents({
      priceInQuoteE18: price,
      totalSupply: record.totalSupply === null ? null : BigInt(record.totalSupply),
      tokenDecimals: decimals,
      quoteUsdAnswer,
      quoteUsdDecimals,
    });

    record.priceInQuoteE18 = price === null ? null : price.toString();
    record.marketCapUsdCents = cap === null ? null : cap.toString();
    record.pricedAt = now;

    // Volume is only rewritten on a tick that actually re-read the window; otherwise the
    // record keeps the figures from the last complete read.
    if (volume !== null) {
      const poolVolume = volume.byPool.get(record.poolAddress);
      const volumeCents = !volume.available
        ? null
        : volumeUsdCents({
            quoteVolumeWei: poolVolume?.quoteVolumeWei ?? 0n,
            windowComplete: volume.complete,
            quoteUsdAnswer,
            quoteUsdDecimals,
          });
      record.volume24hUsdCents = volumeCents === null ? null : volumeCents.toString();
      record.volume24hSwaps = volume.complete ? (poolVolume?.swaps ?? 0) : null;
    }
  }

  if (volume !== null) {
    state.volumeFromBlock = volume.fromBlock;
    state.volumeToBlock = volume.toBlock;
    state.volumeWindowComplete = volume.complete;
  }
  state.quoteUsdAvailable = ethUsd.available;
}

let inFlight: Promise<PonsIndexSummary> | null = null;

async function runTick(): Promise<PonsIndexSummary> {
  if (!isPonsChain(poolixConfig.chain.id)) {
    return { ...EMPTY, unavailableReason: "wrong-chain" };
  }
  if (!hasHyperSyncToken()) {
    return { ...EMPTY, unavailableReason: "no-indexer-token" };
  }

  const indexDeadline = Date.now() + INDEX_BUDGET_MS;
  const state = await loadPonsState();
  const chainHead = await fetchHyperSyncHeight();

  /*
    The target is the factory's last observed launch, not the chain head.

    Measuring coverage against the head would peg a fully indexed dataset at about 50%
    forever, because the factory has been silent for roughly 34 million blocks. Coverage
    against the working range is the honest figure, and the head is reported separately so
    the gap is visible rather than hidden.
  */
  /*
    Walk backwards: this tick reads the slice immediately below what has been read, so the
    newest launches are indexed first and each tick extends the window further back.
  */
  const to = state.scannedFrom;
  const from = Math.max(to - BLOCKS_PER_TICK, PONS_FACTORY_START_BLOCK);
  const atCapacity = Object.keys(state.byToken).length >= PONS_MAX_RECORDS;

  if (state.phase === "index" && to > PONS_FACTORY_START_BLOCK && !atCapacity) {
    const page = await fetchLogsPaged<RawLog>({
      fromBlock: from,
      toBlock: to,
      addresses: [ponsContracts.factory.toLowerCase()],
      topics: [[PONS_LAUNCH_TOPIC_A, PONS_LAUNCH_TOPIC_B]],
      fields: LOG_FIELDS,
      deadline: indexDeadline,
    });

    const launches = pairLaunches(page.logs);
    /*
      Deduplicated on BOTH keys: a token address can only be launched once, and a
      transaction can only carry one launch. The transaction set is rebuilt per tick from
      the records rather than persisted alongside them — at ten thousand records that is a
      few milliseconds, and it removes a second index that could drift out of step with
      the first.
    */
    const seenTx = new Set(Object.values(state.byToken).map((record) => record.launchTxHash));

    let added = 0;
    for (const launch of launches) {
      if (Object.keys(state.byToken).length >= PONS_MAX_RECORDS) break;
      if (state.byToken[launch.token] !== undefined) continue;
      if (seenTx.has(launch.transactionHash)) continue;

      state.byToken[launch.token] = {
        tokenAddress: launch.token,
        creatorAddress: launch.creator,
        launchBlock: launch.blockNumber,
        launchTxHash: launch.transactionHash,
        poolAddress: launch.pool,
        positionTokenId: launch.positionTokenId.toString(),
        name: null,
        symbol: null,
        decimals: null,
        totalSupply: null,
        poolVerified: false,
        quoteIsToken1: null,
        source: "pons",
        indexedAt: Date.now(),
        indexedBlock: launch.blockNumber,
        v2PairAddress: null,
        v2CheckedAt: null,
        priceInQuoteE18: null,
        marketCapUsdCents: null,
        volume24hUsdCents: null,
        volume24hSwaps: null,
        pricedAt: null,
      };
      seenTx.add(launch.transactionHash);
      added++;
    }

    /*
      The checkpoint only moves over a range that was READ COMPLETELY.

      A partial page means the sweep stopped early; moving the checkpoint down to `from`
      anyway would silently skip every launch it did not reach, and nothing downstream
      could ever tell. On a partial read the window stays where it was and the next tick
      retries the same slice.
    */
    if (page.complete) state.scannedFrom = from;

    workerLog.info({
      dataset: "pons",
      reason: "index",
      fromBlock: from,
      toBlock: to,
      received: page.logs.length,
      accepted: added,
      checkpointIn: to,
      checkpointOut: state.scannedFrom,
      published: page.complete,
      withheldBecause: page.complete ? undefined : "the block range was not fully read",
    });
  }

  /*
    Enrich the NEWEST un-enriched records first.

    The view lists launches newest-first, so enriching oldest-first would populate the end
    of a 40,000-row list while every visible row stayed blank — which is what happened
    before this ordering was corrected. Newest-first means the rows a reader actually sees
    are the ones that get a price, and the indexing frontier stays the priority as it
    advances.
  */
  if (state.phase === "enrich") {
    const pending = Object.values(state.byToken)
      .filter(
        (record) =>
          record.decimals === null || !record.poolVerified || record.v2CheckedAt === null,
      )
      .sort((a, b) => b.launchBlock - a.launchBlock)
      .slice(0, MAX_METADATA_PER_TICK);

    if (pending.length > 0) {
      await enrich(pending, Date.now() + ENRICH_BUDGET_MS);
    }
  }

  /*
    Price and volume are computed HERE, by the worker, and persisted.

    Doing this during a render cost 85 seconds of static generation and pulled the
    indexer's short-lived fetch into /explore's cache window. A render must only read.
  */
  if (state.phase === "price") {
    await priceRecords(state);
  }

  // Round-robin, so each phase gets an equal share of ticks and none starves another.
  state.phase = state.phase === "index" ? "enrich" : state.phase === "enrich" ? "price" : "index";
  state.updatedAt = Date.now();
  await savePonsState(state);

  return summarise(state, chainHead);
}

function summarise(state: PonsState, chainHead: number | null): PonsIndexSummary {
  const records = Object.values(state.byToken);
  const target = PONS_LAST_OBSERVED_LAUNCH_BLOCK;
  const span = target - PONS_FACTORY_START_BLOCK;
  // Coverage is how far BACK the window now reaches from the last observed launch.
  const covered = target - Math.max(state.scannedFrom, PONS_FACTORY_START_BLOCK);

  return {
    available: true,
    records,
    indexedTokenCount: records.length,
    verifiedCount: records.filter((record) => record.poolVerified).length,
    withMetadataCount: records.filter((record) => record.decimals !== null).length,
    v2AvailableCount: records.filter((record) => record.v2PairAddress !== null).length,
    v2CheckedCount: records.filter((record) => record.v2CheckedAt !== null).length,
    indexedBlock: state.scannedFrom,
    startBlock: PONS_FACTORY_START_BLOCK,
    targetBlock: target,
    chainHead,
    coveragePercent: span > 0 ? Math.round((covered / span) * 1000) / 10 : null,
    /*
      "Complete" means the window stopped growing, for either of two reasons: it reached
      the factory's first block, or it hit the record cap. Both are honest stopping points
      and the UI states the block range either way.
    */
    complete: state.scannedFrom <= PONS_FACTORY_START_BLOCK || records.length >= PONS_MAX_RECORDS,
    atCapacity: records.length >= PONS_MAX_RECORDS,
    updatedAt: state.updatedAt,
    volumeFromBlock: state.volumeFromBlock,
    volumeToBlock: state.volumeToBlock,
    volumeWindowComplete: state.volumeWindowComplete,
    quoteUsdAvailable: state.quoteUsdAvailable,
    unavailableReason: null,
  };
}

/**
 * Shortest gap between ticks.
 *
 * Prerendering runs pages in parallel and retries a page that overruns, so without this a
 * single build could fire several Pons ticks, each competing with the holder tick for the
 * same rate-limited endpoints. That contention was enough to push /analytics past its
 * 60-second prerender budget twice. Indexing is incremental, so declining a tick costs
 * nothing but a little time.
 */
const MIN_TICK_INTERVAL_MS = 60_000;

/** Advances the index by one bounded tick. Concurrent callers share it. */
export async function indexPons(): Promise<PonsIndexSummary> {
  if (inFlight !== null) return inFlight;

  // Cheap check before committing to any network work.
  const current = await loadPonsState();
  if (current.updatedAt !== null && Date.now() - current.updatedAt < MIN_TICK_INTERVAL_MS) {
    return summarise(current, null);
  }
  inFlight = runTick()
    .catch((error: unknown) => {
      workerLog.error({
        dataset: "pons",
        reason: "index",
        published: false,
        withheldBecause: "the tick threw",
        error: error instanceof Error ? error.message : String(error),
      });
      return EMPTY;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/**
 * Reads the indexed dataset without touching the network.
 *
 * The same split Phase 7 established for holders: a render reads, a worker advances. Not
 * one byte leaves this process — which is what keeps /explore's static generation fast and
 * keeps the indexer's short revalidate out of that route's cache window.
 */
export async function readPonsIndex(): Promise<PonsIndexSummary> {
  if (!isPonsChain(poolixConfig.chain.id)) {
    return { ...EMPTY, unavailableReason: "wrong-chain" };
  }
  const state = await loadPonsState();
  if (state.updatedAt === null) {
    return { ...EMPTY, unavailableReason: hasHyperSyncToken() ? null : "no-indexer-token", available: false };
  }
  return summarise(state, null);
}
