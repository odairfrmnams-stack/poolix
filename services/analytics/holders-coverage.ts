/*
  Confirmation coverage for the Holders verifier. Pure arithmetic: no I/O, no network.

  WHAT THIS IS FOR. Poolix's holder definition makes balanceOf authoritative — the Transfer
  replay only narrows which addresses are worth asking about. So a holder count is only as
  trustworthy as the proportion of candidates the token contract actually answered for. A
  throttled RPC does not return a smaller true count; it returns an unknown one.

  The distinction this module exists to keep is between:

    confirmed   — the contract answered, and its answer decided the address
    unanswered  — the contract did not answer, so nothing about the address is known

  An unanswered call is NOT a zero balance. Folding the two together would drop real
  holders and under-report the total, and the result would look entirely plausible — which
  is exactly the failure a verifier is supposed to catch rather than commit.

  Consequently a token with even one unanswered candidate yields no publishable count at
  all, and a run containing such a token is INCOMPLETE rather than PASS. "I could not
  determine this" and "this is correct" are different claims.

  This is verifier-side bookkeeping. It deliberately holds none of the holder methodology —
  no replay, no balance arithmetic, no universe selection — so importing it does not let
  the Holders implementation validate itself. Production's own completeness tracking in
  holders-window.ts is untouched and unrelated.
*/

export interface TokenCoverage {
  readonly token: string;
  /** Addresses the Transfer replay produced as worth asking the contract about. */
  readonly candidates: number;
  /** Candidates whose balanceOf call actually answered. */
  readonly confirmed: number;
  /** Candidates whose balanceOf call never answered. Never treated as a zero balance. */
  readonly unanswered: number;
}

/**
 * One token's coverage, with the counts forced into a consistent shape.
 *
 * `confirmed` is clamped to the candidate count rather than trusted: a confirmation total
 * larger than the population it came from is a bookkeeping error, and silently reporting
 * over 100% coverage would hide it behind a reassuring number.
 */
export function tokenCoverage(token: string, candidates: number, confirmed: number): TokenCoverage {
  const total = Math.max(0, Math.trunc(candidates));
  const answered = Math.min(Math.max(0, Math.trunc(confirmed)), total);
  return { token, candidates: total, confirmed: answered, unanswered: total - answered };
}

/**
 * Whether every candidate for this token was decided by its contract.
 *
 * A token with no candidates at all counts as fully confirmed: there was nothing to ask,
 * and a token nobody has ever held is a real answer of zero rather than a gap.
 */
export function isFullyConfirmed(coverage: TokenCoverage): boolean {
  return coverage.unanswered === 0;
}

/** Share of candidates the contract answered, in [0, 1]. Vacuously 1 when there are none. */
export function coverageRatio(coverage: TokenCoverage): number {
  if (coverage.candidates === 0) return 1;
  return coverage.confirmed / coverage.candidates;
}

export interface UniverseCoverage {
  readonly tokens: readonly TokenCoverage[];
  readonly candidates: number;
  readonly confirmed: number;
  readonly unanswered: number;
  /** Tokens with at least one unanswered candidate, in the order given. */
  readonly incompleteTokens: readonly string[];
  /** True only when every token answered for every one of its candidates. */
  readonly complete: boolean;
}

/**
 * Rolls per-token coverage into one verdict for the run.
 *
 * Completeness is a conjunction, never an average: nine fully answered tokens beside one
 * that was throttled is not "90% confident", it is a total that is missing an unknown
 * number of holders. An empty universe is NOT complete — there is nothing to have
 * confirmed, so there is nothing to publish either.
 */
export function aggregateCoverage(tokens: readonly TokenCoverage[]): UniverseCoverage {
  let candidates = 0;
  let confirmed = 0;
  let unanswered = 0;
  const incompleteTokens: string[] = [];

  for (const coverage of tokens) {
    candidates += coverage.candidates;
    confirmed += coverage.confirmed;
    unanswered += coverage.unanswered;
    if (!isFullyConfirmed(coverage)) incompleteTokens.push(coverage.token);
  }

  return {
    tokens,
    candidates,
    confirmed,
    unanswered,
    incompleteTokens,
    complete: tokens.length > 0 && incompleteTokens.length === 0,
  };
}

/**
 * The holder count, or null when the coverage behind it is partial.
 *
 * Null is the point. A count summed over partly-confirmed tokens is a lower bound of
 * unknown tightness, and publishing it as "holders" states more than was measured.
 */
export function publishableHolderCount(
  coverage: UniverseCoverage,
  holders: number,
): number | null {
  return coverage.complete ? holders : null;
}

export type ComparisonReason =
  | "ok"
  /** The verifier could not decide every candidate in the page's universe. */
  | "verifier-coverage-incomplete"
  /** The page has not finished confirming, so its count is not yet a claim. */
  | "page-snapshot-incomplete"
  | "no-snapshot";

export interface ComparisonReadiness {
  readonly comparable: boolean;
  readonly reason: ComparisonReason;
}

/**
 * Whether the page's published count and the verifier's recount can be compared at all.
 *
 * Both sides have to be finished. The verifier side is obvious. The page side is the one
 * that looks comparable and is not: `holders-window.ts` persists a running subtotal while
 * it works through the universe, and the page withholds it — displaying `--` — until every
 * token is confirmed. That subtotal is not a claim about how many holders exist, so a
 * recount disagreeing with it says nothing about the implementation. Measured on a real
 * run: a snapshot at 3 of 10 tokens confirmed carried 34 against a true 2,690, and
 * comparing them failed a page that was behaving exactly as designed.
 */
export function comparisonReadiness(
  pageCoverage: UniverseCoverage,
  snapshot: { readonly complete: boolean } | null,
): ComparisonReadiness {
  if (snapshot === null) return { comparable: false, reason: "no-snapshot" };
  if (!snapshot.complete) return { comparable: false, reason: "page-snapshot-incomplete" };
  if (!pageCoverage.complete) {
    return { comparable: false, reason: "verifier-coverage-incomplete" };
  }
  return { comparable: true, reason: "ok" };
}

export type Verdict = "PASS" | "INCOMPLETE" | "FAIL";

/**
 * The run's verdict.
 *
 * A failed check outranks partial coverage: a defect that was actually observed is firmer
 * news than one that could not be looked for, and hiding it behind INCOMPLETE would lose
 * it. Absent any failure, incomplete coverage can never read as PASS — the comparison it
 * would have passed was never run.
 */
export function verdictFor(coverage: UniverseCoverage, failedChecks: number): Verdict {
  if (failedChecks > 0) return "FAIL";
  return coverage.complete ? "PASS" : "INCOMPLETE";
}

/**
 * The whole run's verdict, including whether the comparison actually executed.
 *
 * A run whose comparison never ran has not verified anything, however complete its own
 * coverage was — so it is INCOMPLETE rather than PASS. This is the distinction that keeps
 * "the check could not run" from quietly reading as "the check succeeded".
 */
export function runVerdict(input: {
  readonly coverage: UniverseCoverage;
  readonly failedChecks: number;
  readonly comparisonRan: boolean;
}): Verdict {
  const base = verdictFor(input.coverage, input.failedChecks);
  if (base !== "PASS") return base;
  return input.comparisonRan ? "PASS" : "INCOMPLETE";
}

/** Process exit code per verdict. Distinct so a caller can tell the two failures apart. */
export function exitCodeFor(verdict: Verdict): number {
  switch (verdict) {
    case "PASS":
      return 0;
    case "FAIL":
      return 1;
    case "INCOMPLETE":
      return 2;
  }
}

export interface AnswerTally {
  readonly confirmed: number;
  /** Addresses whose call did not answer, for a retry pass. */
  readonly unanswered: readonly string[];
}

/**
 * Sorts one batch of balanceOf results into answered and unanswered.
 *
 * `null` means the call did not come back — throttled, reverted, dropped. It is kept apart
 * from an answer of `0n`, which is the contract positively stating the address holds
 * nothing. Collapsing the two is the single mistake that would make a throttled run look
 * like a complete one with fewer holders.
 *
 * An address with no corresponding result at all is unanswered for the same reason.
 */
export function tallyAnswers(
  addresses: readonly string[],
  answers: readonly (bigint | null | undefined)[],
): AnswerTally {
  let confirmed = 0;
  const unanswered: string[] = [];

  for (const [index, address] of addresses.entries()) {
    const answer = answers[index];
    if (answer === null || answer === undefined) unanswered.push(address);
    else confirmed++;
  }

  return { confirmed, unanswered };
}
