/*
  Pure selection of the tracked token universe. No I/O, no state, no network.

  The tracked tokens are the non-WETH side of pools that clear the same bar the pool
  scanner uses: both reserves non-zero, WETH on one side, and a WETH reserve at or above
  the minimum. Nothing here invents a token — every candidate comes from a pair the
  scanner actually read.

  Selection is deterministic. Two runs over the same candidates produce the same tokens in
  the same order, because a figure that shuffles between refreshes is not a measurement.
*/

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

export interface PairState {
  readonly pair: string;
  readonly token0: string;
  readonly token1: string;
  readonly reserve0: bigint;
  readonly reserve1: bigint;
}

export interface TokenCandidate {
  /** Lower-cased, so one token found through several pools is one token. */
  readonly token: string;
  readonly pair: string;
  /** WETH held by the pool this candidate came from. Drives the ranking. */
  readonly wethReserve: bigint;
}

/** True when a string is a syntactically valid, non-zero address. */
export function isUsableAddress(value: string): boolean {
  if (!ADDRESS_PATTERN.test(value)) return false;
  return value.toLowerCase() !== ZERO_ADDRESS;
}

/**
 * Whether a pair could possibly qualify, judged on reserves alone.
 *
 * Used to avoid reading token0/token1 for pairs that cannot pass: the WETH side is one of
 * the two reserves, so if neither clears the minimum, neither can the WETH one. On this
 * chain roughly 94% of recently created pairs hold nothing at all, and skipping their
 * token reads is most of what makes a wider scan affordable.
 */
export function mayQualify(reserve0: bigint, reserve1: bigint, minWethReserve: bigint): boolean {
  if (reserve0 <= 0n || reserve1 <= 0n) return false;
  return reserve0 >= minWethReserve || reserve1 >= minWethReserve;
}

/**
 * Turns a fully-read pair into a token candidate, or null when it does not qualify.
 * WETH itself is never a candidate: it is the quote asset, not a tracked token.
 */
export function qualifyPair(state: PairState, weth: string, minWethReserve: bigint): TokenCandidate | null {
  if (state.reserve0 <= 0n || state.reserve1 <= 0n) return null;

  const wethAddress = weth.toLowerCase();
  const token0 = state.token0.toLowerCase();
  const token1 = state.token1.toLowerCase();

  const wethIsToken0 = token0 === wethAddress;
  if (!wethIsToken0 && token1 !== wethAddress) return null;

  const wethReserve = wethIsToken0 ? state.reserve0 : state.reserve1;
  if (wethReserve < minWethReserve) return null;

  const other = wethIsToken0 ? token1 : token0;
  // A WETH/WETH pair would otherwise select WETH as its own tracked token.
  if (!isUsableAddress(other) || other === wethAddress) return null;

  return { token: other, pair: state.pair.toLowerCase(), wethReserve };
}

/**
 * Collapses candidates to one entry per token, keeping the deepest pool.
 *
 * A token listed in several pools is one token, and attributing it to its deepest pool
 * is what makes the ranking stable when a shallow duplicate appears or disappears.
 */
export function dedupeCandidates(candidates: Iterable<TokenCandidate>): TokenCandidate[] {
  const best = new Map<string, TokenCandidate>();
  for (const candidate of candidates) {
    const token = candidate.token.toLowerCase();
    if (!isUsableAddress(token)) continue;

    const existing = best.get(token);
    if (existing === undefined || candidate.wethReserve > existing.wethReserve) {
      best.set(token, { ...candidate, token });
    }
  }
  return [...best.values()];
}

export interface StoredReading {
  readonly pair: string;
  readonly wethReserve: bigint;
}

/**
 * Whether a freshly read pair should replace the one already stored for a token.
 *
 * A reading of the SAME pair always wins, even when it is lower. Keeping the larger of the
 * two turns the stored reserve into a high-water mark that only ever climbs, so a drained
 * pool keeps ranking on liquidity it no longer holds — and since a full shortlist halts the
 * backward scan, nothing ever re-reads it. Only a genuinely different pair has to prove it
 * is the deeper one, which is what `dedupeCandidates` means by keeping the deepest pool.
 */
export function preferReading(
  existing: StoredReading | undefined,
  candidate: StoredReading,
): boolean {
  if (existing === undefined) return true;
  if (existing.pair.toLowerCase() === candidate.pair.toLowerCase()) return true;
  return existing.wethReserve < candidate.wethReserve;
}

/**
 * Whether a re-read pair still belongs in the candidate store.
 *
 * The same threshold that refused to admit a pair now refuses to keep it, so a pool that
 * drains leaves the ranking by the rule it entered under rather than lingering on an old
 * number. Callers must not apply this to a pair that failed to answer: silence is not
 * evidence of an empty pool.
 */
export function stillQualifies(
  reserve0: bigint,
  reserve1: bigint,
  wethReserve: bigint,
  minWethReserve: bigint,
): boolean {
  if (reserve0 <= 0n || reserve1 <= 0n) return false;
  return wethReserve >= minWethReserve;
}

/**
 * Deterministic ordering: deepest WETH reserve first, then address ascending.
 *
 * The reserve ordering is the pool scanner's own. The address tie-break exists so two
 * pools holding exactly the same amount cannot swap places between refreshes.
 */
export function orderCandidates(candidates: readonly TokenCandidate[]): TokenCandidate[] {
  return [...candidates].sort((a, b) => {
    if (a.wethReserve !== b.wethReserve) return b.wethReserve > a.wethReserve ? 1 : -1;
    return a.token < b.token ? -1 : a.token > b.token ? 1 : 0;
  });
}

/**
 * The deterministic shortlist: deduplicated, ordered, and capped.
 *
 * `limit` is a ceiling on how many tokens are considered, never a claim about how many
 * exist. Fewer candidates simply yield fewer tokens.
 */
export function selectTokens(candidates: Iterable<TokenCandidate>, limit: number): TokenCandidate[] {
  if (limit <= 0) return [];
  return orderCandidates(dedupeCandidates(candidates)).slice(0, limit);
}

export interface TokenVerification {
  /** null when the contract did not answer decimals(). */
  readonly decimals: number | null;
  /** Whether balanceOf() could be read at all. */
  readonly balanceReadable: boolean;
}

/**
 * Keeps only the tokens whose contract actually answered as an ERC-20.
 *
 * A token that cannot report its decimals or its balances is one Poolix cannot count
 * holders for or display amounts of, so it is dropped rather than tracked in name only.
 * Order is preserved, so the result is still the deterministic shortlist.
 */
export function acceptVerified(
  selected: readonly TokenCandidate[],
  verifications: ReadonlyMap<string, TokenVerification>,
): TokenCandidate[] {
  return selected.filter((candidate) => {
    const verification = verifications.get(candidate.token);
    if (verification === undefined) return false;
    if (verification.decimals === null) return false;
    return verification.balanceReadable;
  });
}
