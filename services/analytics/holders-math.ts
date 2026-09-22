/*
  Pure balance reconstruction from ERC-20 Transfer events. No I/O, no state, no network.

  Holders are addresses with a *current positive balance*, which is not the same as the
  set of addresses that ever received a transfer. An address that received tokens and
  later sent all of them away is not a holder, so balances are replayed rather than
  recipients counted.

  The replay produces two things. The addresses it touched are the *candidate set*, which
  services/analytics/holders-confirm.ts then checks against the token's own `balanceOf` —
  a token can emit Transfer events that move no state, and one on this chain does. The
  replayed balances themselves are kept as a cross-check: where they disagree with the
  contract, the contract wins and the disagreement is counted and reported.

  All arithmetic is bigint: a uint256 value does not fit in a JavaScript number, and
  rounding a token balance would silently change who counts as a holder.
*/

/** Transfer(address indexed from, address indexed to, uint256 value) */
export const TRANSFER_TOPIC0 = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const TOPIC_PATTERN = /^0x[0-9a-fA-F]{64}$/;

export interface TransferLogLike {
  /** Indexed `from`, left-padded to 32 bytes. */
  readonly topic1?: string;
  /** Indexed `to`, left-padded to 32 bytes. */
  readonly topic2?: string;
  /** Non-indexed `value`, a single uint256 word. */
  readonly data?: string;
}

export interface DecodedTransfer {
  readonly from: string;
  readonly to: string;
  readonly value: bigint;
}

/** Extracts the 20-byte address from a left-padded 32-byte topic. */
function addressFromTopic(topic: string): string | null {
  if (!TOPIC_PATTERN.test(topic)) return null;
  return `0x${topic.slice(26)}`.toLowerCase();
}

/**
 * Decodes one Transfer log. Returns null for anything malformed rather than throwing,
 * so a single bad log cannot abandon a replay over thousands of them.
 */
export function decodeTransfer(log: TransferLogLike): DecodedTransfer | null {
  if (typeof log.topic1 !== "string" || typeof log.topic2 !== "string") return null;

  const from = addressFromTopic(log.topic1);
  const to = addressFromTopic(log.topic2);
  if (from === null || to === null) return null;

  const data = log.data;
  if (typeof data !== "string" || !data.startsWith("0x")) return null;
  const body = data.slice(2);
  // A standard Transfer carries exactly one uint256. Anything else is not one.
  if (body.length !== 64 || !/^[0-9a-fA-F]+$/.test(body)) return null;

  return { from, to, value: BigInt(`0x${body}`) };
}

export interface BalanceSheet {
  /** Address to balance. The zero address is never tracked. */
  readonly balances: Map<string, bigint>;
  /** Addresses whose balance went below zero, which means the history is incomplete. */
  readonly negative: string[];
  /** Logs that could not be decoded. */
  readonly undecodable: number;
  readonly applied: number;
}

/**
 * Replays transfers onto a balance map.
 *
 * Mints arrive from the zero address and burns go to it; neither side of that address is
 * tracked, so it can never appear as a holder and never accrues a negative balance.
 *
 * Pass `existing` to continue from a checkpoint. The caller must only supply events that
 * have not been applied before, because applying a transfer twice would move the balance
 * twice.
 */
export function applyTransfers(
  logs: readonly TransferLogLike[],
  existing?: ReadonlyMap<string, bigint>,
): BalanceSheet {
  const balances = new Map<string, bigint>(existing ?? []);
  let undecodable = 0;
  let applied = 0;

  for (const log of logs) {
    const transfer = decodeTransfer(log);
    if (transfer === null) {
      undecodable++;
      continue;
    }

    if (transfer.from !== ZERO_ADDRESS) {
      balances.set(transfer.from, (balances.get(transfer.from) ?? 0n) - transfer.value);
    }
    if (transfer.to !== ZERO_ADDRESS) {
      balances.set(transfer.to, (balances.get(transfer.to) ?? 0n) + transfer.value);
    }
    applied++;
  }

  const negative: string[] = [];
  for (const [address, balance] of balances) {
    if (balance < 0n) negative.push(address);
  }

  return { balances, negative, undecodable, applied };
}

/**
 * Addresses with a strictly positive balance.
 *
 * A negative balance is treated as invalid rather than positive: it can only arise from
 * an incomplete history, and counting such an address would assert something the data
 * does not support.
 */
export function positiveHolders(balances: ReadonlyMap<string, bigint>): Set<string> {
  const holders = new Set<string>();
  for (const [address, balance] of balances) {
    if (address === ZERO_ADDRESS) continue;
    if (balance > 0n) holders.add(address);
  }
  return holders;
}

/**
 * Unique addresses across every token. One address holding three tokens is one holder,
 * which is why the union is taken globally rather than summing per-token counts.
 */
export function unionHolders(perToken: Iterable<ReadonlySet<string>>): Set<string> {
  const all = new Set<string>();
  for (const holders of perToken) {
    for (const address of holders) all.add(address);
  }
  return all;
}

/**
 * Every address the replay touched, which is the set worth asking the contract about.
 *
 * Deliberately not filtered to positive balances: an address the replay puts at zero can
 * still hold the token when the events understate reality, and dropping it here would
 * make it impossible for the confirmation step to find it.
 */
export function candidateAddresses(balances: ReadonlyMap<string, bigint>): string[] {
  const candidates: string[] = [];
  for (const address of balances.keys()) {
    if (address === ZERO_ADDRESS) continue;
    candidates.push(address);
  }
  return candidates;
}

/**
 * What is known about one token's standing `balanceOf` confirmation.
 *
 * `candidates` is the replay's current candidate count and `confirmedCandidates` is the
 * count the holder list was actually built from. They drift apart whenever the replay
 * advances, and that gap is the thing worth reasoning about carefully.
 */
export interface ConfirmationState {
  readonly candidates: number;
  readonly confirmedCandidates: number;
  readonly confirmedBlock: number | null;
  /** How long ago the confirmation was read, in milliseconds. */
  readonly ageMs: number;
}

/** True when the confirmation should be read again. */
export function needsConfirmation(state: ConfirmationState, ttlMs: number): boolean {
  if (state.confirmedBlock === null) return true;
  // New candidates are addresses the standing confirmation never asked about, so it is
  // not merely old, it is answering a smaller question than the one now being asked.
  if (state.confirmedCandidates !== state.candidates) return true;
  return state.ageMs >= ttlMs;
}

/**
 * True when the confirmation may be published.
 *
 * Stricter than `needsConfirmation`: a confirmation that no longer covers every candidate
 * is not a slightly stale answer, it is a wrong one, and withholding the figure is the
 * only honest response. A token confirmed while its sweep had found nothing would
 * otherwise contribute zero holders to a total that looks complete.
 */
export function isPublishable(state: ConfirmationState, maxAgeMs: number): boolean {
  if (state.confirmedBlock === null) return false;
  if (state.confirmedCandidates !== state.candidates) return false;
  return state.ageMs <= maxAgeMs;
}

export interface ConfirmPriority {
  readonly token: string;
  /** 0 when the token has never had a complete confirmation. */
  readonly confirmedAt: number;
  /** Candidates still queued for a balance read. */
  readonly outstanding: number;
}

/**
 * The order tokens are offered a turn at confirming: cheapest outstanding queue first.
 *
 * Two things make this the right order, and they pull the same way.
 *
 * It confirms the most tokens per tick. One token here had 68,000 candidates against nine
 * others holding 37 to 1,500; the nine together needed a fraction of one tick, and doing
 * them first publishes nine tokens in the time it takes to not-quite-finish one.
 *
 * It also gives the expensive token MORE time, not less, which is the part that is easy to
 * get backwards. Each token is offered an equal share of what remains, so a token placed
 * first is capped at one share however much work it has — and the cheap tokens behind it,
 * which return almost immediately, never spend theirs. Putting the expensive one last lets
 * it inherit everything the others did not use: measured, that is the difference between
 * ~150 and ~850 candidates confirmed per tick.
 *
 * Starvation is prevented by the time slice rather than by the ordering, so a token that
 * has never been confirmed does not need to go first — it only breaks ties, since it is
 * the one blocking the universe from being publishable at all.
 */
export function confirmationOrder(entries: readonly ConfirmPriority[]): string[] {
  return [...entries]
    .sort((a, b) => {
      if (a.outstanding !== b.outstanding) return a.outstanding - b.outstanding;
      // Never confirmed before merely stale, then by address so the order is stable.
      const aNever = a.confirmedAt === 0 ? 0 : 1;
      const bNever = b.confirmedAt === 0 ? 0 : 1;
      if (aNever !== bNever) return aNever - bNever;
      if (a.confirmedAt !== b.confirmedAt) return a.confirmedAt - b.confirmedAt;
      return a.token < b.token ? -1 : a.token > b.token ? 1 : 0;
    })
    .map((entry) => entry.token);
}

/**
 * The slice of a tick one token may use, so no single token can consume the whole of it.
 *
 * An equal share of what remains, recomputed per token: a token that finishes early hands
 * the rest back to the ones behind it, and a token that would run forever is cut off at
 * its share instead of starving everything after it. With a partial pass keeping its
 * answers, being cut off costs nothing but the tick.
 */
export function tokenTimeSlice(
  now: number,
  deadline: number,
  tokensRemaining: number,
): number {
  const remaining = deadline - now;
  if (remaining <= 0 || tokensRemaining <= 0) return 0;
  return Math.max(1, Math.floor(remaining / tokensRemaining));
}

export interface ConfirmationMerge {
  /** The holder list after applying whatever the contract answered. */
  readonly holders: string[];
  /** Candidates still awaiting an answer. Never recorded as zero balances. */
  readonly pending: string[];
  /** True only when nothing is left to ask about. */
  readonly complete: boolean;
}

/**
 * Folds one batch of contract answers into a token's holder list and its queue.
 *
 * A confirmation pass over a large token cannot finish inside one tick — measured, the
 * endpoint answers balanceOf at roughly 12-25ms per call, so a 25-second budget buys about
 * a thousand of them. The queue therefore has to survive across ticks, and so does the
 * work already done: discarding a partial pass because it was interrupted means a token
 * with more candidates than one tick can cover never advances at all, however many ticks
 * it is given.
 *
 * What is NOT relaxed is publishability. An address the contract did not answer for stays
 * in `pending` rather than being treated as holding nothing, and `complete` is false while
 * any remain — so a half-drained queue can never be mistaken for a finished one. Callers
 * mark the token confirmed only on `complete`.
 *
 * An address joins the holder list when the contract reports a positive balance and leaves
 * it the moment the contract reports none, which is what makes this idempotent: re-running
 * a batch cannot double-count or strand an address.
 */
export function mergeConfirmation(input: {
  readonly holders: Iterable<string>;
  readonly queue: readonly string[];
  readonly answered: ReadonlyMap<string, bigint>;
}): ConfirmationMerge {
  const holders = new Set(input.holders);
  for (const [address, balance] of input.answered) {
    if (balance > 0n) holders.add(address);
    else holders.delete(address);
  }

  const pending = input.queue.filter((address) => !input.answered.has(address));
  return { holders: [...holders], pending, complete: pending.length === 0 };
}

/**
 * How many replayed balances the contract disagrees with. A non-zero count means the
 * token's Transfer events do not describe its balances, which is worth surfacing even
 * though the confirmed figure is the one published.
 */
export function countMismatches(
  replayed: ReadonlyMap<string, bigint>,
  confirmed: ReadonlyMap<string, bigint>,
): number {
  let mismatches = 0;
  for (const [address, balance] of confirmed) {
    if ((replayed.get(address) ?? 0n) !== balance) mismatches++;
  }
  return mismatches;
}

/** De-duplicates a token universe, so a token in several pools is processed once. */
export function uniqueTokens(addresses: Iterable<string>, exclude: ReadonlySet<string> = new Set()): string[] {
  const seen = new Set<string>();
  for (const address of addresses) {
    if (typeof address !== "string") continue;
    const normalised = address.toLowerCase();
    if (normalised === ZERO_ADDRESS || exclude.has(normalised)) continue;
    seen.add(normalised);
  }
  return [...seen];
}
