import "server-only";


import { encodeFunctionData, erc20Abi, getAddress } from "viem";

import { poolixConfig } from "@/config/poolix";
import { workerLog } from "@/services/storage/log";
import { analyticsStore } from "@/services/storage/storage";
import { isUniswapV2Available } from "@/config/resolve";
import { uniswapV2FactoryAbi, uniswapV2PairAbi } from "@/services/abis/uniswap-v2";
import { batchedCall, pacedCalls, type RpcCall } from "@/services/chain/rpc";
import { MIN_WETH_RESERVE } from "@/services/pools/discovery";
import {
  acceptVerified,
  mayQualify,
  preferReading,
  qualifyPair,
  selectTokens,
  stillQualifies,
  type TokenCandidate,
  type TokenVerification,
} from "@/services/tokens/universe-math";
import type { Address, Hex } from "@/types/web3";

/*
  The tracked token universe: up to TRACK_LIMIT unique non-WETH tokens drawn from pools
  that clear the pool scanner's own bar.

  Why this is a separate, incremental scan rather than a wider synchronous one. Measured
  on this endpoint before building:

    - Of the newest 300 pairs, 283 hold nothing at all and only 2-4 qualify. The factory
      gains roughly 750 pairs an hour, almost all empty, so the newest-300 window is
      mostly shells. Reaching ten tokens needs about 1,200 pairs.
    - The endpoint's quota counts calls, not requests. 1,200 pairs read the old way is
      ~4,800 calls and took 103-240s with repeated 429s; pushed harder it returned
      nothing at all. That is five to twelve times a page render's budget.
    - Concurrency makes it worse, not better: four lanes over the same 300 pairs produced
      31 throttles and decoded 259 of 300, against 300 of 300 and zero throttles
      sequentially.

  So the scan is spread over time instead of parallelised. Each tick reads one bounded
  slice of the pair space, and the quota refills between renders. Two things make a slice
  cheap: batches are large (the endpoint answered 800 calls in one request at 1.1ms per
  call, against 12.2ms at 40), and reserves are read before tokens so the ~94% of pairs
  holding nothing never cost a token read.

  The pool scanner in services/pools/discovery.ts is deliberately untouched. TVL,
  Liquidity Scanned, Pairs Created and Top Pools keep reading exactly what they read
  before; this module only adds a token universe beside them.
*/

/** Ceiling on how many tokens are tracked. Never a claim about how many were found. */
export const TRACK_LIMIT = 10;

/** Pair indices examined per tick. One slice is two requests at the batch size below. */
const SLICE = 400;
/**
 * Calls per JSON-RPC request. Measured: this endpoint answers 800 in one request, and
 * its quota counts calls rather than requests, so large batches cut latency without
 * spending more quota. Kept below the measured ceiling for headroom.
 */
const BATCH_SIZE = 500;
const BATCH_PAUSE_MS = 150;
/** Wall-clock ceiling for one tick, well inside a page render. */
const TICK_BUDGET_MS = 12_000;
/** How long a completed universe stands before the next slice is scanned. */
const REFRESH_MS = 20_000;
/** How long a token's ERC-20 verification stands. */
const VERIFY_TTL_MS = 30 * 60_000;
/** Candidates retained. Beyond this the oldest-seen are dropped. */
const MAX_CANDIDATES = 500;
/**
 * How long a reserve reading stands before it is re-read.
 *
 * A stored reserve decides the ranking, so an old one ranks a token by liquidity it may
 * no longer hold. Pools on this chain drain within minutes, so this is short.
 */
const RESERVE_TTL_MS = 5 * 60_000;
/**
 * Stored candidates re-read per tick, deepest first.
 *
 * Only the top of the ranking can affect what is published, so refreshing the whole store
 * would spend the budget confirming entries that were never in contention. Bounded well
 * above TRACK_LIMIT so a drained token has somewhere to fall to.
 */
const REFRESH_CONTENDERS = 40;

const STATE_VERSION = 1;

interface FoundToken {
  pair: string;
  wethReserve: string;
  seenAt: number;
  /** null until the contract has been asked; false when it failed to answer. */
  verified: boolean | null;
  verifiedAt: number;
  decimals: number | null;
}

interface PersistedState {
  version: number;
  chainId: number;
  /** Pair indices below this have been examined. */
  scannedFrom: number;
  /** Pair indices at or above this have not. Walks up as new pairs are created. */
  scannedTo: number;
  totalPairs: number;
  /** Every qualifying token seen, keyed by lower-cased address. */
  found: Record<string, FoundToken>;
  updatedAt: number;
  published: PublishedUniverse | null;
}

interface PublishedUniverse {
  tokens: string[];
  discovered: number;
  selected: number;
  verified: number;
  pairsExamined: number;
  totalPairs: number;
  at: number;
}

export interface TokenUniverseSummary {
  readonly available: boolean;
  /** The tracked tokens: deduplicated, deterministic, verified. At most TRACK_LIMIT. */
  readonly tokens: readonly string[];
  /** Unique qualifying tokens discovered so far, before the cap. */
  readonly discovered: number;
  /** How many of those the cap admitted. */
  readonly selected: number;
  /** How many of the selected answered as an ERC-20. This is what `tokens` holds. */
  readonly verified: number;
  readonly pairsExamined: number;
  readonly totalPairs: number;
  /** True once the whole pair space has been walked at least once. */
  readonly sweepComplete: boolean;
  /** True when the cap is filled, which is when the backward walk stops widening. */
  readonly atLimit: boolean;
  readonly limit: number;
  readonly updatedAt: number | null;
}

const EMPTY: TokenUniverseSummary = {
  available: false,
  tokens: [],
  discovered: 0,
  selected: 0,
  verified: 0,
  pairsExamined: 0,
  totalPairs: 0,
  sweepComplete: false,
  atLimit: false,
  limit: TRACK_LIMIT,
  updatedAt: null,
};


// ---------------------------------------------------------------- persistence

function emptyState(): PersistedState {
  return {
    version: STATE_VERSION,
    chainId: poolixConfig.chain.id,
    scannedFrom: 0,
    scannedTo: 0,
    totalPairs: 0,
    found: {},
    updatedAt: 0,
    published: null,
  };
}

/*
  Persistence goes through the storage layer rather than straight to a file.

  The key, the schema check and the atomic write all live in one place now, so this module
  no longer carries its own copy of "what does an unreadable cache mean". The answer is
  unchanged and deliberate: discard and rebuild. Every dataset here is derived from
  HyperSync and the chain, so a doubtful cache costs time to replace, while reinterpreting
  one costs correctness in a number someone acts on.
*/
const store = analyticsStore<PersistedState>(
  "tokens",
  STATE_VERSION,
  poolixConfig.chain.id,
  (value: unknown): value is PersistedState =>
    typeof value === "object" && value !== null && typeof (value as PersistedState).found === "object",
);

async function loadState(): Promise<PersistedState> {
  const result = await store.load();
  if (result.value === null) {
    // "missing" is an ordinary cold start; anything else means state was thrown away and
    // is worth saying out loud rather than silently rebuilding.
    if (result.outcome !== "missing") {
      workerLog.warn({ dataset: "tokens", reason: "load", error: result.detail });
    }
    return emptyState();
  }
  const state = result.value;
  return {
    ...emptyState(),
    ...state,
    found: state.found ?? {},
  };
}

async function saveState(state: PersistedState): Promise<void> {
  await store.save(state);
}

// -------------------------------------------------------------------- decoding

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

function decodeDecimals(value: Hex | null): number | null {
  if (value === null || value.length < 66) return null;
  const decimals = Number(BigInt(value));
  return Number.isInteger(decimals) && decimals >= 0 && decimals <= 255 ? decimals : null;
}

// ------------------------------------------------------------------- scanning

interface Slice {
  readonly from: number;
  readonly to: number;
}

/**
 * Picks the next range of pair indices to examine.
 *
 * Newly created pairs come first, so a freshly funded pool is seen quickly; after that
 * the scan walks backwards through older indices, which is where the funded pools are.
 * Returns null once the whole space has been covered and nothing new exists.
 */
function nextSlice(state: PersistedState, totalPairs: number, holdsLimit: boolean): Slice | null {
  if (totalPairs <= 0) return null;

  // First pass ever: start at the newest end.
  if (state.scannedTo === 0 && state.scannedFrom === 0) {
    return { from: Math.max(0, totalPairs - SLICE), to: totalPairs };
  }
  // Pairs created since the last tick. Always worth reading: a pool funded a minute ago
  // can be deeper than anything already found, and this is the only way to see it.
  if (totalPairs > state.scannedTo) {
    return { from: state.scannedTo, to: Math.min(totalPairs, state.scannedTo + SLICE) };
  }
  /*
    Widening backwards stops once the cap is actually filled. The factory holds tens of
    thousands of pairs and walking all of them would spend a slice of every render
    forever, to refine a ranking that is already full. If a tracked token later drops out
    — its pool drained, its contract stopped answering — the count falls below the cap
    and the walk resumes on the next tick.
  */
  if (!holdsLimit && state.scannedFrom > 0) {
    return { from: Math.max(0, state.scannedFrom - SLICE), to: state.scannedFrom };
  }
  return null;
}

/** Reads one slice and returns the qualifying tokens in it. */
async function scanSlice(
  factory: Address,
  weth: string,
  slice: Slice,
  deadline: number,
): Promise<{ candidates: TokenCandidate[]; examined: number }> {
  const count = slice.to - slice.from;
  if (count <= 0) return { candidates: [], examined: 0 };

  const addressCalls: RpcCall[] = Array.from({ length: count }, (_, offset) => ({
    to: factory,
    data: encodeFunctionData({
      abi: uniswapV2FactoryAbi,
      functionName: "allPairs",
      args: [BigInt(slice.from + offset)],
    }),
  }));

  const addressResults = await pacedCalls(addressCalls, {
    deadline,
    batchSize: BATCH_SIZE,
    pauseMs: BATCH_PAUSE_MS,
  });
  const pairs = addressResults.map(decodeAddress).filter((address): address is Address => address !== null);
  if (pairs.length === 0) return { candidates: [], examined: 0 };

  // Stage one: reserves only. Most pairs die here and never cost a token read.
  const reservesData = encodeFunctionData({ abi: uniswapV2PairAbi, functionName: "getReserves" });
  const reserveResults = await pacedCalls(
    pairs.map((pair) => ({ to: pair, data: reservesData })),
    { deadline, batchSize: BATCH_SIZE, pauseMs: BATCH_PAUSE_MS },
  );

  const survivors: { pair: Address; reserve0: bigint; reserve1: bigint }[] = [];
  let examined = 0;
  for (const [index, pair] of pairs.entries()) {
    const reserves = decodeReserves(reserveResults[index] ?? null);
    if (reserves === null) continue;
    examined++;
    if (!mayQualify(reserves.reserve0, reserves.reserve1, MIN_WETH_RESERVE)) continue;
    survivors.push({ pair, ...reserves });
  }
  if (survivors.length === 0) return { candidates: [], examined };

  // Stage two: which side is WETH, for the survivors only.
  const token0Data = encodeFunctionData({ abi: uniswapV2PairAbi, functionName: "token0" });
  const token1Data = encodeFunctionData({ abi: uniswapV2PairAbi, functionName: "token1" });
  const tokenResults = await pacedCalls(
    survivors.flatMap((entry) => [
      { to: entry.pair, data: token0Data },
      { to: entry.pair, data: token1Data },
    ]),
    { deadline, batchSize: BATCH_SIZE, pauseMs: BATCH_PAUSE_MS },
  );

  const candidates: TokenCandidate[] = [];
  for (const [index, entry] of survivors.entries()) {
    const token0 = decodeAddress(tokenResults[index * 2] ?? null);
    const token1 = decodeAddress(tokenResults[index * 2 + 1] ?? null);
    if (token0 === null || token1 === null) continue;

    const candidate = qualifyPair(
      { pair: entry.pair, token0, token1, reserve0: entry.reserve0, reserve1: entry.reserve1 },
      weth,
      MIN_WETH_RESERVE,
    );
    if (candidate !== null) candidates.push(candidate);
  }

  return { candidates, examined };
}

/**
 * Re-reads the reserves behind the deepest stored candidates.
 *
 * Without this the ranking is a memory rather than a measurement. The backward walk stops
 * once the shortlist is full, so a token already in the store is only ever re-read when
 * its own slice happens to come around again — which, with the walk halted, is never. The
 * published set then ages in place, and on a chain whose pools drain in minutes it ends up
 * listing pools that hold nothing at all.
 *
 * A pair that has fallen below the qualifying threshold is deleted rather than kept at its
 * new value: the same rule that refused to admit it now refuses to keep it. That drops the
 * verified count below the cap, which is what resumes the backward walk and lets a real
 * pool take its place.
 *
 * A pair that does not answer is left alone. Silence is not evidence of an empty pool, and
 * deleting on it would discard a good token because one call was throttled.
 */
async function refreshContenders(
  state: PersistedState,
  weth: string,
  now: number,
  deadline: number,
): Promise<void> {
  const stale = Object.entries(state.found)
    .filter(([, entry]) => now - entry.seenAt > RESERVE_TTL_MS)
    .sort((a, b) => (BigInt(b[1].wethReserve) > BigInt(a[1].wethReserve) ? 1 : -1))
    .slice(0, REFRESH_CONTENDERS);
  if (stale.length === 0) return;

  const reservesData = encodeFunctionData({ abi: uniswapV2PairAbi, functionName: "getReserves" });
  const token0Data = encodeFunctionData({ abi: uniswapV2PairAbi, functionName: "token0" });
  const results = await pacedCalls(
    stale.flatMap(([, entry]) => [
      { to: entry.pair as Address, data: reservesData },
      { to: entry.pair as Address, data: token0Data },
    ]),
    { deadline, batchSize: BATCH_SIZE, pauseMs: BATCH_PAUSE_MS },
  );

  const wethAddress = weth.toLowerCase();
  for (const [index, [token, entry]] of stale.entries()) {
    const reserves = decodeReserves(results[index * 2] ?? null);
    const token0 = decodeAddress(results[index * 2 + 1] ?? null);
    if (reserves === null || token0 === null) continue;

    const wethReserve =
      token0.toLowerCase() === wethAddress ? reserves.reserve0 : reserves.reserve1;

    if (!stillQualifies(reserves.reserve0, reserves.reserve1, wethReserve, MIN_WETH_RESERVE)) {
      delete state.found[token];
      continue;
    }
    entry.wethReserve = wethReserve.toString();
    entry.seenAt = now;
  }
}

/**
 * Asks each token's contract whether it behaves like an ERC-20.
 *
 * `decimals()` must answer, because amounts cannot be shown without it, and `balanceOf`
 * must answer, because holders cannot be counted without it. The pair is used as the
 * balance subject: it demonstrably holds the token, so a revert means the contract, not
 * the address.
 */
async function verifyTokens(
  selected: readonly TokenCandidate[],
  deadline: number,
): Promise<Map<string, TokenVerification>> {
  const verifications = new Map<string, TokenVerification>();
  if (selected.length === 0) return verifications;

  const decimalsData = encodeFunctionData({ abi: erc20Abi, functionName: "decimals" });

  const calls: RpcCall[] = selected.flatMap((candidate) => [
    { to: candidate.token as Address, data: decimalsData },
    {
      to: candidate.token as Address,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [candidate.pair as Address],
      }),
    },
  ]);

  const results = await pacedCalls(calls, { deadline, batchSize: BATCH_SIZE, pauseMs: BATCH_PAUSE_MS });

  for (const [index, candidate] of selected.entries()) {
    const decimals = decodeDecimals(results[index * 2] ?? null);
    const balance = results[index * 2 + 1] ?? null;
    verifications.set(candidate.token, {
      decimals,
      balanceReadable: balance !== null && balance.length === 66,
    });
  }

  return verifications;
}

// ----------------------------------------------------------------------- tick

function candidatesFrom(state: PersistedState): TokenCandidate[] {
  return Object.entries(state.found).map(([token, entry]) => ({
    token,
    pair: entry.pair,
    wethReserve: BigInt(entry.wethReserve),
  }));
}

let inFlight: Promise<TokenUniverseSummary> | null = null;
let cached: { at: number; value: TokenUniverseSummary } | null = null;

async function runTick(): Promise<TokenUniverseSummary> {
  if (!isUniswapV2Available(poolixConfig)) return EMPTY;
  const { uniswapV2, weth } = poolixConfig.contracts;
  if (uniswapV2.factory.status !== "configured") return EMPTY;

  const factory = uniswapV2.factory.address;
  const deadline = Date.now() + TICK_BUDGET_MS;
  const state = await loadState();
  const now = Date.now();

  const [lengthResult] = await batchedCall([
    { to: factory, data: encodeFunctionData({ abi: uniswapV2FactoryAbi, functionName: "allPairsLength" }) },
  ]);
  if (lengthResult === null || lengthResult === undefined) return EMPTY;

  const totalPairs = Number(BigInt(lengthResult));
  if (!Number.isSafeInteger(totalPairs)) return EMPTY;
  state.totalPairs = totalPairs;

  const previouslyVerified = state.published?.verified ?? 0;
  const slice = nextSlice(state, totalPairs, previouslyVerified >= TRACK_LIMIT);
  if (slice !== null) {
    const { candidates, examined } = await scanSlice(factory, weth, slice, deadline);
    void examined;

    for (const candidate of candidates) {
      const existing = state.found[candidate.token];
      const stored =
        existing === undefined
          ? undefined
          : { pair: existing.pair, wethReserve: BigInt(existing.wethReserve) };
      const kept = preferReading(stored, candidate) || stored === undefined ? candidate : stored;

      state.found[candidate.token] = {
        pair: kept.pair,
        wethReserve: kept.wethReserve.toString(),
        seenAt: now,
        verified: existing?.verified ?? null,
        verifiedAt: existing?.verifiedAt ?? 0,
        decimals: existing?.decimals ?? null,
      };
    }

    // The cursor only moves for a slice that was actually read, so a throttled tick
    // re-reads it rather than leaving a hole the scan would never come back to.
    if (candidates.length > 0 || examined > 0) {
      if (slice.to > state.scannedTo) state.scannedTo = slice.to;
      if (state.scannedFrom === 0 && state.scannedTo === slice.to) state.scannedFrom = slice.from;
      else if (slice.from < state.scannedFrom) state.scannedFrom = slice.from;
    }
  }

  // Keep the store bounded: the deepest pools are what the cap selects from anyway.
  const entries = Object.entries(state.found);
  if (entries.length > MAX_CANDIDATES) {
    entries
      .sort((a, b) => (BigInt(b[1].wethReserve) > BigInt(a[1].wethReserve) ? 1 : -1))
      .slice(MAX_CANDIDATES)
      .forEach(([token]) => delete state.found[token]);
  }

  // Before ranking, make sure the numbers being ranked are still true.
  await refreshContenders(state, weth, now, deadline);

  const discovered = Object.keys(state.found).length;
  const selected = selectTokens(candidatesFrom(state), TRACK_LIMIT);

  // Verify anything unverified or long unchecked; a cached verdict stands otherwise.
  const needsCheck = selected.filter((candidate) => {
    const entry = state.found[candidate.token];
    return entry === undefined || entry.verified === null || now - entry.verifiedAt > VERIFY_TTL_MS;
  });
  if (needsCheck.length > 0) {
    const fresh = await verifyTokens(needsCheck, deadline);
    for (const [token, verification] of fresh) {
      const entry = state.found[token];
      if (entry === undefined) continue;
      entry.verified = verification.decimals !== null && verification.balanceReadable;
      entry.decimals = verification.decimals;
      entry.verifiedAt = now;
    }
  }

  const verifications = new Map<string, TokenVerification>();
  for (const candidate of selected) {
    const entry = state.found[candidate.token];
    if (entry === undefined || entry.verified === null) continue;
    verifications.set(candidate.token, {
      decimals: entry.verified ? entry.decimals : null,
      balanceReadable: entry.verified,
    });
  }

  const accepted = acceptVerified(selected, verifications);
  const tokens = accepted.map((candidate) => candidate.token);
  const pairsExamined = Math.max(0, state.scannedTo - state.scannedFrom);

  const summary: TokenUniverseSummary = {
    available: true,
    tokens,
    discovered,
    selected: selected.length,
    verified: tokens.length,
    pairsExamined,
    totalPairs,
    sweepComplete: state.scannedFrom === 0 && state.scannedTo >= totalPairs,
    atLimit: tokens.length >= TRACK_LIMIT,
    limit: TRACK_LIMIT,
    updatedAt: now,
  };

  state.updatedAt = now;
  state.published = {
    tokens,
    discovered,
    selected: selected.length,
    verified: tokens.length,
    pairsExamined,
    totalPairs,
    at: now,
  };
  await saveState(state);

  return summary;
}

/**
 * The tracked token universe. Concurrent callers share one tick, and a completed result
 * stands briefly so a render does not scan a slice per component.
 */
export async function getTokenUniverse(): Promise<TokenUniverseSummary> {
  if (cached !== null && Date.now() - cached.at < REFRESH_MS) return cached.value;
  if (inFlight !== null) return inFlight;

  inFlight = runTick()
    .then((value) => {
      cached = { at: Date.now(), value };
      return value;
    })
    .catch(() => EMPTY)
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}
