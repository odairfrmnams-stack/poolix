import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applyTransfers,
  candidateAddresses,
  confirmationOrder,
  countMismatches,
  decodeTransfer,
  isPublishable,
  mergeConfirmation,
  needsConfirmation,
  positiveHolders,
  tokenTimeSlice,
  TRANSFER_TOPIC0,
  uniqueTokens,
  unionHolders,
  ZERO_ADDRESS,
} from "@/services/analytics/holders-math";

const A = "0x000000000000000000000000000000000000000a";
const B = "0x000000000000000000000000000000000000000b";
const C = "0x000000000000000000000000000000000000000c";

const topic = (address: string) => `0x${address.slice(2).padStart(64, "0")}`;
const word = (value: bigint) => `0x${value.toString(16).padStart(64, "0")}`;

/** A Transfer log as HyperSync returns it. */
const transfer = (from: string, to: string, value: bigint) => ({
  topic1: topic(from),
  topic2: topic(to),
  data: word(value),
});

const mint = (to: string, value: bigint) => transfer(ZERO_ADDRESS, to, value);
const burn = (from: string, value: bigint) => transfer(from, ZERO_ADDRESS, value);

describe("decodeTransfer", () => {
  it("pins the Transfer topic", () => {
    assert.equal(TRANSFER_TOPIC0, "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef");
  });

  it("decodes from, to and value out of padded topics", () => {
    assert.deepEqual(decodeTransfer(transfer(A, B, 100n)), { from: A, to: B, value: 100n });
  });

  it("returns null for malformed logs instead of throwing", () => {
    assert.equal(decodeTransfer({}), null);
    assert.equal(decodeTransfer({ topic1: topic(A), topic2: topic(B) }), null); // no value
    assert.equal(decodeTransfer({ topic1: "0x12", topic2: topic(B), data: word(1n) }), null);
    assert.equal(decodeTransfer({ topic1: topic(A), topic2: topic(B), data: "0x01" }), null);
    // An ERC-721 Transfer indexes tokenId as a third topic and carries no data.
    assert.equal(decodeTransfer({ topic1: topic(A), topic2: topic(B), data: "0x" }), null);
  });
});

describe("balance reconstruction", () => {
  it("handles a normal transfer as a paired debit and credit", () => {
    const { balances } = applyTransfers([mint(A, 100n), transfer(A, B, 30n)]);
    assert.equal(balances.get(A), 70n);
    assert.equal(balances.get(B), 30n);
  });

  it("credits a mint without debiting the zero address", () => {
    const { balances } = applyTransfers([mint(A, 500n)]);
    assert.equal(balances.get(A), 500n);
    assert.equal(balances.has(ZERO_ADDRESS), false);
  });

  it("debits a burn without crediting the zero address", () => {
    const { balances } = applyTransfers([mint(A, 500n), burn(A, 200n)]);
    assert.equal(balances.get(A), 300n);
    assert.equal(balances.has(ZERO_ADDRESS), false);
  });

  it("nets incoming against outgoing for an address that does both", () => {
    const { balances } = applyTransfers([mint(A, 100n), transfer(A, B, 100n), transfer(B, A, 40n)]);
    assert.equal(balances.get(A), 40n);
    assert.equal(balances.get(B), 60n);
  });

  it("applies many transfers in sequence", () => {
    const logs = [mint(A, 1_000n), ...Array.from({ length: 10 }, () => transfer(A, B, 50n))];
    const { balances, applied } = applyTransfers(logs);
    assert.equal(applied, 11);
    assert.equal(balances.get(A), 500n);
    assert.equal(balances.get(B), 500n);
  });

  it("counts duplicate Transfer events twice, because each is a real movement", () => {
    // Two identical logs are two transfers; de-duplication would lose a real movement.
    const { balances } = applyTransfers([mint(A, 100n), transfer(A, B, 10n), transfer(A, B, 10n)]);
    assert.equal(balances.get(A), 80n);
    assert.equal(balances.get(B), 20n);
  });

  it("skips undecodable logs and reports them", () => {
    const { balances, undecodable, applied } = applyTransfers([
      mint(A, 100n),
      { topic1: "bad", topic2: topic(B), data: word(5n) },
    ]);
    assert.equal(undecodable, 1);
    assert.equal(applied, 1);
    assert.equal(balances.get(A), 100n);
  });

  it("returns an empty sheet for no history", () => {
    const sheet = applyTransfers([]);
    assert.equal(sheet.balances.size, 0);
    assert.equal(sheet.applied, 0);
    assert.deepEqual(sheet.negative, []);
  });

  it("continues from an existing checkpoint", () => {
    const first = applyTransfers([mint(A, 100n)]);
    const second = applyTransfers([transfer(A, B, 60n)], first.balances);
    assert.equal(second.balances.get(A), 40n);
    assert.equal(second.balances.get(B), 60n);
  });

  it("flags a negative balance as invalid history", () => {
    // Sending without ever receiving can only mean transfers are missing.
    const { balances, negative } = applyTransfers([transfer(A, B, 10n)]);
    assert.equal(balances.get(A), -10n);
    assert.deepEqual(negative, [A]);
    // And it must never be counted as a holder.
    assert.equal(positiveHolders(balances).has(A), false);
  });
});

describe("very large uint256 values", () => {
  it("keeps exactness at the top of the uint256 range", () => {
    const max = 2n ** 256n - 1n;
    const { balances } = applyTransfers([mint(A, max)]);
    assert.equal(balances.get(A), max);
    // Why bigint is required: as doubles these two distinct values collapse into one.
    assert.equal(Number(max), Number(max - 1n));
  });

  it("nets huge values without precision loss", () => {
    const big = 10n ** 30n;
    const { balances } = applyTransfers([mint(A, big), transfer(A, B, big - 1n)]);
    assert.equal(balances.get(A), 1n);
    assert.equal(balances.get(B), big - 1n);
  });
});

describe("holder selection", () => {
  it("excludes an address whose balance reached zero", () => {
    // The scenario from the specification: A ends at zero and must not count.
    const { balances } = applyTransfers([mint(A, 100n), transfer(A, B, 100n)]);
    assert.equal(balances.get(A), 0n);
    assert.equal(balances.get(B), 100n);

    const holders = positiveHolders(balances);
    assert.equal(holders.has(A), false);
    assert.deepEqual([...holders], [B]);
    assert.equal(holders.size, 1);
  });

  it("reproduces the worked example exactly", () => {
    // 180 minted to A, then A->B 100, B->C 40, C->A 10.
    const { balances } = applyTransfers([
      mint(A, 180n),
      transfer(A, B, 100n),
      transfer(B, C, 40n),
      transfer(C, A, 10n),
    ]);
    assert.equal(balances.get(A), 90n);
    assert.equal(balances.get(B), 60n);
    assert.equal(balances.get(C), 30n);
    assert.equal(positiveHolders(balances).size, 3);
  });

  it("never counts the zero address", () => {
    const { balances } = applyTransfers([mint(A, 100n), burn(A, 100n)]);
    const holders = positiveHolders(balances);
    assert.equal(holders.has(ZERO_ADDRESS), false);
    assert.equal(holders.size, 0); // A is back to zero
  });

});

describe("candidate selection for on-chain confirmation", () => {
  it("keeps every address the replay touched, including the ones it puts at zero", () => {
    // A ends at zero. It must still be asked about: the events may understate reality.
    const { balances } = applyTransfers([mint(A, 100n), transfer(A, B, 100n)]);
    const candidates = candidateAddresses(balances);
    assert.equal(candidates.includes(A), true);
    assert.equal(candidates.includes(B), true);
    assert.equal(candidates.length, 2);
  });

  it("keeps an address the replay puts below zero", () => {
    // The PAIDCAT case: sends with no matching receipts. The contract decides, not us.
    const { balances } = applyTransfers([transfer(A, B, 10n)]);
    assert.equal(candidateAddresses(balances).includes(A), true);
  });

  it("never asks about the zero address", () => {
    const { balances } = applyTransfers([mint(A, 1n), burn(A, 1n)]);
    assert.equal(candidateAddresses(balances).includes(ZERO_ADDRESS), false);
  });
});

describe("agreement between replay and contract", () => {
  it("reports no mismatch when the events describe the balances", () => {
    const { balances } = applyTransfers([mint(A, 100n), transfer(A, B, 40n)]);
    const confirmed = new Map([
      [A, 60n],
      [B, 40n],
    ]);
    assert.equal(countMismatches(balances, confirmed), 0);
  });

  it("counts every address the contract disagrees about", () => {
    // Replay says both hold; the contract says neither does.
    const { balances } = applyTransfers([mint(A, 100n), transfer(A, B, 40n)]);
    const confirmed = new Map([
      [A, 0n],
      [B, 0n],
    ]);
    assert.equal(countMismatches(balances, confirmed), 2);
  });

  it("treats an address the replay never saw as a disagreement", () => {
    const { balances } = applyTransfers([mint(A, 100n)]);
    assert.equal(countMismatches(balances, new Map([[C, 5n]])), 1);
  });
});

describe("confirmation freshness", () => {
  const state = (over: Partial<Parameters<typeof isPublishable>[0]> = {}) => ({
    candidates: 13,
    confirmedCandidates: 13,
    confirmedBlock: 1_000,
    ageMs: 0,
    ...over,
  });

  const TTL = 120_000;
  const MAX_AGE = 600_000;

  it("re-reads a token that has never been confirmed", () => {
    assert.equal(needsConfirmation(state({ confirmedBlock: null, confirmedCandidates: -1 }), TTL), true);
    assert.equal(isPublishable(state({ confirmedBlock: null, confirmedCandidates: -1 }), MAX_AGE), false);
  });

  it("leaves a fresh confirmation alone", () => {
    assert.equal(needsConfirmation(state({ ageMs: 30_000 }), TTL), false);
    assert.equal(isPublishable(state({ ageMs: 30_000 }), MAX_AGE), true);
  });

  it("re-reads once the timer expires", () => {
    assert.equal(needsConfirmation(state({ ageMs: TTL }), TTL), true);
    // Still publishable in the meantime: old, but it answers the right question.
    assert.equal(isPublishable(state({ ageMs: TTL }), MAX_AGE), true);
  });

  it("withholds a confirmation older than the publish limit", () => {
    assert.equal(isPublishable(state({ ageMs: MAX_AGE + 1 }), MAX_AGE), false);
  });

  it("re-reads and withholds when the replay found new candidates", () => {
    // The regression: a token confirmed while its sweep had found nothing, then filled in.
    const grown = state({ candidates: 13, confirmedCandidates: 0, ageMs: 1_000 });
    assert.equal(needsConfirmation(grown, TTL), true, "must re-read even though the timer has not expired");
    assert.equal(isPublishable(grown, MAX_AGE), false, "must not publish an empty list for 13 candidates");
  });

  it("withholds when the candidate count shrank too", () => {
    const shrunk = state({ candidates: 5, confirmedCandidates: 13, ageMs: 1_000 });
    assert.equal(needsConfirmation(shrunk, TTL), true);
    assert.equal(isPublishable(shrunk, MAX_AGE), false);
  });

  it("publishes a token that genuinely has no candidates", () => {
    // Zero is a real answer when the replay really did find nothing.
    const empty = state({ candidates: 0, confirmedCandidates: 0 });
    assert.equal(needsConfirmation(empty, TTL), false);
    assert.equal(isPublishable(empty, MAX_AGE), true);
  });
});

describe("global de-duplication across tokens", () => {
  it("counts an address holding three tokens as one holder", () => {
    const tokenX = positiveHolders(applyTransfers([mint(A, 1n), mint(B, 1n)]).balances);
    const tokenY = positiveHolders(applyTransfers([mint(A, 1n)]).balances);
    const tokenZ = positiveHolders(applyTransfers([mint(A, 1n), mint(C, 1n)]).balances);

    const all = unionHolders([tokenX, tokenY, tokenZ]);
    assert.equal(all.size, 3); // A, B, C — not 5
    assert.deepEqual([...all].sort(), [A, B, C].sort());
  });

  it("returns nothing for an empty universe", () => {
    assert.equal(unionHolders([]).size, 0);
  });
});

describe("token universe de-duplication", () => {
  it("processes a token appearing in several pools only once", () => {
    const tokens = uniqueTokens([A, B, A, A.toUpperCase(), C]);
    assert.equal(tokens.length, 3);
    assert.deepEqual(tokens.sort(), [A, B, C].sort());
  });

  it("drops the zero address and anything explicitly excluded", () => {
    const weth = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
    const tokens = uniqueTokens([A, ZERO_ADDRESS, weth, B], new Set([weth]));
    assert.deepEqual(tokens.sort(), [A, B].sort());
  });

  it("normalises case so one token is never scanned twice", () => {
    assert.deepEqual(uniqueTokens(["0xAbC0000000000000000000000000000000000001"]), [
      "0xabc0000000000000000000000000000000000001",
    ]);
  });
});

describe("draining a confirmation queue across ticks", () => {
  const D = "0x000000000000000000000000000000000000000d";
  const answers = (entries: [string, bigint][]) => new Map<string, bigint>(entries);

  it("adds an address the contract reports a balance for", () => {
    const merged = mergeConfirmation({
      holders: [],
      queue: [A, B],
      answered: answers([[A, 5n], [B, 0n]]),
    });
    assert.deepEqual(merged.holders, [A]);
    assert.equal(merged.complete, true);
  });

  it("removes an address the contract reports nothing for", () => {
    const merged = mergeConfirmation({
      holders: [A, B],
      queue: [A],
      answered: answers([[A, 0n]]),
    });
    assert.deepEqual(merged.holders, [B]);
  });

  it("keeps the answers from a pass that was cut short", () => {
    // The bug this replaces: an interrupted pass threw all of this away.
    const merged = mergeConfirmation({
      holders: [],
      queue: [A, B, C, D],
      answered: answers([[A, 1n], [B, 2n]]),
    });
    assert.deepEqual(merged.holders, [A, B]);
  });

  it("leaves unanswered candidates in the queue rather than calling them zero", () => {
    const merged = mergeConfirmation({
      holders: [],
      queue: [A, B, C, D],
      answered: answers([[A, 1n], [B, 2n]]),
    });
    assert.deepEqual(merged.pending, [C, D]);
    assert.equal(merged.complete, false);
  });

  it("an unanswered address is not dropped from the holder list either", () => {
    // C was a holder and went unanswered this pass: it stays, and stays queued.
    const merged = mergeConfirmation({
      holders: [C],
      queue: [C, D],
      answered: answers([[D, 0n]]),
    });
    assert.deepEqual(merged.holders, [C]);
    assert.deepEqual(merged.pending, [C]);
    assert.equal(merged.complete, false);
  });

  it("converges over successive ticks, each keeping the last one's work", () => {
    const queue = [A, B, C, D];
    const first = mergeConfirmation({ holders: [], queue, answered: answers([[A, 1n], [B, 0n]]) });
    assert.equal(first.complete, false);
    assert.deepEqual(first.pending, [C, D]);

    const second = mergeConfirmation({
      holders: first.holders,
      queue: first.pending,
      answered: answers([[C, 7n], [D, 0n]]),
    });
    assert.equal(second.complete, true);
    assert.deepEqual(second.pending, []);
    assert.deepEqual(second.holders, [A, C]);
  });

  it("makes progress even when a tick answers only one candidate", () => {
    // A token far larger than one tick must still advance, or it never finishes.
    let holders: string[] = [];
    let queue = [A, B, C, D];
    for (const address of [A, B, C, D]) {
      const step = mergeConfirmation({ holders, queue, answered: answers([[address, 1n]]) });
      holders = step.holders;
      queue = step.pending;
    }
    assert.deepEqual(queue, []);
    assert.deepEqual(holders, [A, B, C, D]);
  });

  it("is incomplete when a throttled tick answers nothing at all", () => {
    const merged = mergeConfirmation({ holders: [A], queue: [B, C], answered: answers([]) });
    assert.deepEqual(merged.pending, [B, C]);
    assert.equal(merged.complete, false);
    assert.deepEqual(merged.holders, [A]);
  });

  it("re-running the same batch changes nothing", () => {
    const once = mergeConfirmation({ holders: [], queue: [A, B], answered: answers([[A, 3n], [B, 0n]]) });
    const twice = mergeConfirmation({
      holders: once.holders,
      queue: [A, B],
      answered: answers([[A, 3n], [B, 0n]]),
    });
    assert.deepEqual(twice.holders, once.holders);
    assert.deepEqual(twice.pending, []);
  });

  it("an empty queue is complete without asking anything", () => {
    const merged = mergeConfirmation({ holders: [A], queue: [], answered: answers([]) });
    assert.equal(merged.complete, true);
    assert.deepEqual(merged.holders, [A]);
  });

  it("does not resurrect an address that left the queue", () => {
    // Answers for addresses no longer queued still apply to the holder list, which is
    // what keeps a re-read of a removed holder from stranding it.
    const merged = mergeConfirmation({ holders: [A], queue: [B], answered: answers([[A, 0n], [B, 1n]]) });
    assert.deepEqual(merged.holders, [B]);
    assert.equal(merged.complete, true);
  });
});
describe("who gets a turn at confirming", () => {
  const entry = (token: string, confirmedAt: number, outstanding: number) => ({
    token,
    confirmedAt,
    outstanding,
  });

  it("does the cheapest token first", () => {
    // The starvation case: one 68,000-candidate token against small ones.
    const order = confirmationOrder([
      entry(A, 0, 68_324),
      entry(B, 0, 37),
      entry(C, 0, 1_527),
    ]);
    assert.deepEqual(order, [B, C, A]);
  });

  it("puts the most expensive token LAST, where it inherits unused time", () => {
    const order = confirmationOrder([
      entry(A, 0, 68_324),
      entry(B, 5_000, 12),
      entry(C, 9_000, 400),
    ]);
    assert.equal(order[order.length - 1], A);
  });

  it("prefers a never-confirmed token when the cost is the same", () => {
    // It is the one blocking the universe from being publishable at all.
    const order = confirmationOrder([entry(A, 1_000, 5), entry(B, 0, 5)]);
    assert.deepEqual(order, [B, A]);
  });

  it("does a cheap refresh before an expensive first confirmation", () => {
    // The refresh costs almost nothing and hands its unused share straight on.
    const order = confirmationOrder([entry(A, 0, 900), entry(B, 1_000, 5)]);
    assert.deepEqual(order, [B, A]);
  });

  it("still reaches the expensive token, rather than dropping it", () => {
    const order = confirmationOrder([entry(A, 0, 68_324), entry(B, 0, 37)]);
    assert.equal(order.includes(A), true);
    assert.equal(order.length, 2);
  });

  it("breaks equal-cost refreshes stalest first", () => {
    const order = confirmationOrder([
      entry(A, 5_000, 1),
      entry(C, 3_000, 1),
      entry(B, 1_000, 1),
    ]);
    assert.deepEqual(order, [B, C, A]);
  });

  it("is deterministic when tokens tie completely", () => {
    const first = confirmationOrder([entry(C, 0, 10), entry(A, 0, 10), entry(B, 0, 10)]);
    const second = confirmationOrder([entry(B, 0, 10), entry(C, 0, 10), entry(A, 0, 10)]);
    assert.deepEqual(first, second);
    assert.deepEqual(first, [A, B, C]);
  });

  it("returns every token exactly once", () => {
    const order = confirmationOrder([entry(A, 0, 3), entry(B, 7, 2), entry(C, 0, 1)]);
    assert.deepEqual([...order].sort(), [A, B, C].sort());
  });

  it("handles an empty universe", () => {
    assert.deepEqual(confirmationOrder([]), []);
  });
});

describe("sharing a tick between tokens", () => {
  it("splits the remaining budget evenly", () => {
    assert.equal(tokenTimeSlice(0, 25_000, 10), 2_500);
  });

  it("gives the last token everything that is left", () => {
    assert.equal(tokenTimeSlice(0, 25_000, 1), 25_000);
  });

  it("hands unused time to the tokens behind", () => {
    // Nine tokens finished in 1s of a 25s tick; the tenth inherits the rest.
    assert.equal(tokenTimeSlice(1_000, 25_000, 1), 24_000);
  });

  it("never returns a negative or zero slice while time remains", () => {
    assert.ok(tokenTimeSlice(24_999, 25_000, 10) >= 1);
  });

  it("returns nothing once the deadline has passed", () => {
    assert.equal(tokenTimeSlice(25_000, 25_000, 5), 0);
    assert.equal(tokenTimeSlice(30_000, 25_000, 5), 0);
  });

  it("returns nothing when there are no tokens left to serve", () => {
    assert.equal(tokenTimeSlice(0, 25_000, 0), 0);
  });

  it("no single token can take the whole tick when others are waiting", () => {
    const slice = tokenTimeSlice(0, 25_000, 10);
    assert.ok(slice < 25_000);
  });
});