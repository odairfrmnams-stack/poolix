import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  aggregateCoverage,
  comparisonReadiness,
  coverageRatio,
  exitCodeFor,
  isFullyConfirmed,
  publishableHolderCount,
  runVerdict,
  tallyAnswers,
  tokenCoverage,
  verdictFor,
} from "@/services/analytics/holders-coverage";

const token = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const address = (n: number) => `0x${(n + 0x1000).toString(16).padStart(40, "0")}`;

const TOKEN_A = token(1);
const TOKEN_B = token(2);
const TOKEN_C = token(3);

describe("a fully confirmed token", () => {
  const coverage = tokenCoverage(TOKEN_A, 1_260, 1_260);

  it("answers for every candidate", () => {
    assert.equal(coverage.candidates, 1_260);
    assert.equal(coverage.confirmed, 1_260);
    assert.equal(coverage.unanswered, 0);
  });

  it("is fully confirmed", () => {
    assert.equal(isFullyConfirmed(coverage), true);
  });

  it("reports complete coverage", () => {
    assert.equal(coverageRatio(coverage), 1);
  });

  it("makes the run publishable and PASS", () => {
    const universe = aggregateCoverage([coverage]);
    assert.equal(universe.complete, true);
    assert.deepEqual(universe.incompleteTokens, []);
    assert.equal(publishableHolderCount(universe, 624), 624);
    assert.equal(verdictFor(universe, 0), "PASS");
  });

  it("counts a token nobody ever held as answered, not as a gap", () => {
    const empty = tokenCoverage(TOKEN_A, 0, 0);
    assert.equal(isFullyConfirmed(empty), true);
    assert.equal(coverageRatio(empty), 1);
    assert.equal(aggregateCoverage([empty]).complete, true);
  });
});

describe("a partially confirmed token", () => {
  // The real case: 1,260 candidates, the public RPC answered 256 of them.
  const coverage = tokenCoverage(TOKEN_A, 1_260, 256);

  it("keeps unanswered candidates apart from confirmed ones", () => {
    assert.equal(coverage.confirmed, 256);
    assert.equal(coverage.unanswered, 1_004);
  });

  it("is not fully confirmed", () => {
    assert.equal(isFullyConfirmed(coverage), false);
  });

  it("reports the true ratio rather than rounding up to complete", () => {
    assert.ok(coverageRatio(coverage) > 0.2 && coverageRatio(coverage) < 0.21);
  });

  it("withholds the holder count entirely", () => {
    const universe = aggregateCoverage([coverage]);
    assert.equal(universe.complete, false);
    assert.equal(publishableHolderCount(universe, 220), null);
  });

  it("names the token that was not finished", () => {
    assert.deepEqual(aggregateCoverage([coverage]).incompleteTokens, [TOKEN_A]);
  });

  it("is INCOMPLETE, never PASS", () => {
    assert.equal(verdictFor(aggregateCoverage([coverage]), 0), "INCOMPLETE");
  });

  it("a single unanswered candidate out of many is still incomplete", () => {
    const nearly = tokenCoverage(TOKEN_A, 10_000, 9_999);
    assert.equal(isFullyConfirmed(nearly), false);
    assert.equal(verdictFor(aggregateCoverage([nearly]), 0), "INCOMPLETE");
  });
});

describe("RPC throttling", () => {
  const addresses = [address(1), address(2), address(3), address(4)];

  it("classifies a dropped call as unanswered, not as a zero balance", () => {
    const tally = tallyAnswers(addresses, [5n, null, 0n, null]);
    assert.equal(tally.confirmed, 2);
    assert.deepEqual(tally.unanswered, [address(2), address(4)]);
  });

  it("treats an answered zero as a real answer", () => {
    // The contract positively said "holds nothing" — that is knowledge, not a gap.
    const tally = tallyAnswers([address(1)], [0n]);
    assert.equal(tally.confirmed, 1);
    assert.deepEqual(tally.unanswered, []);
  });

  it("treats a missing result as unanswered", () => {
    const tally = tallyAnswers(addresses, [1n]);
    assert.equal(tally.confirmed, 1);
    assert.equal(tally.unanswered.length, 3);
  });

  it("turns a throttled batch into incomplete coverage", () => {
    const tally = tallyAnswers(addresses, [1n, null, null, null]);
    const coverage = tokenCoverage(TOKEN_A, addresses.length, tally.confirmed);
    assert.equal(coverage.unanswered, 3);
    assert.equal(verdictFor(aggregateCoverage([coverage]), 0), "INCOMPLETE");
  });

  it("recovers to complete when a retry answers the rest", () => {
    const first = tallyAnswers(addresses, [1n, null, null, null]);
    const second = tallyAnswers(first.unanswered, [2n, 0n, 7n]);
    const coverage = tokenCoverage(TOKEN_A, addresses.length, first.confirmed + second.confirmed);
    assert.equal(coverage.unanswered, 0);
    assert.equal(verdictFor(aggregateCoverage([coverage]), 0), "PASS");
  });

  it("never reports more confirmations than there were candidates", () => {
    const coverage = tokenCoverage(TOKEN_A, 3, 99);
    assert.equal(coverage.confirmed, 3);
    assert.equal(coverage.unanswered, 0);
    assert.equal(coverageRatio(coverage), 1);
  });
});

describe("zero confirmed candidates", () => {
  const coverage = tokenCoverage(TOKEN_A, 1_485, 0);

  it("records every candidate as unanswered", () => {
    assert.equal(coverage.confirmed, 0);
    assert.equal(coverage.unanswered, 1_485);
    assert.equal(coverageRatio(coverage), 0);
  });

  it("withholds the count rather than publishing zero holders", () => {
    const universe = aggregateCoverage([coverage]);
    assert.equal(publishableHolderCount(universe, 0), null);
  });

  it("is INCOMPLETE", () => {
    assert.equal(verdictFor(aggregateCoverage([coverage]), 0), "INCOMPLETE");
  });

  it("an empty universe is not complete either", () => {
    // Nothing was confirmed because nothing was asked; there is still nothing to publish.
    const universe = aggregateCoverage([]);
    assert.equal(universe.complete, false);
    assert.equal(publishableHolderCount(universe, 0), null);
    assert.equal(verdictFor(universe, 0), "INCOMPLETE");
  });
});

describe("multiple tokens with mixed coverage", () => {
  const full = tokenCoverage(TOKEN_A, 672, 672);
  const partial = tokenCoverage(TOKEN_B, 1_260, 256);
  const none = tokenCoverage(TOKEN_C, 40, 0);
  const universe = aggregateCoverage([full, partial, none]);

  it("sums candidates and confirmations across the universe", () => {
    assert.equal(universe.candidates, 672 + 1_260 + 40);
    assert.equal(universe.confirmed, 672 + 256);
    assert.equal(universe.unanswered, 1_004 + 40);
  });

  it("names every token that was not finished, in order", () => {
    assert.deepEqual(universe.incompleteTokens, [TOKEN_B, TOKEN_C]);
  });

  it("is incomplete even though most candidates were answered", () => {
    // 928 of 1,972 answered is not "mostly right", it is an unknown total.
    assert.equal(universe.complete, false);
    assert.equal(verdictFor(universe, 0), "INCOMPLETE");
  });

  it("one throttled token spoils an otherwise complete run", () => {
    const mostly = aggregateCoverage([full, tokenCoverage(TOKEN_B, 500, 499)]);
    assert.equal(mostly.complete, false);
    assert.deepEqual(mostly.incompleteTokens, [TOKEN_B]);
  });

  it("passes only when every token is fully confirmed", () => {
    const all = aggregateCoverage([full, tokenCoverage(TOKEN_B, 1_260, 1_260)]);
    assert.equal(all.complete, true);
    assert.equal(verdictFor(all, 0), "PASS");
    assert.equal(publishableHolderCount(all, 731), 731);
  });
});

describe("incomplete coverage is never a PASS", () => {
  const partial = aggregateCoverage([tokenCoverage(TOKEN_A, 100, 99)]);
  const full = aggregateCoverage([tokenCoverage(TOKEN_A, 100, 100)]);

  it("does not pass with no failed checks", () => {
    assert.notEqual(verdictFor(partial, 0), "PASS");
    assert.equal(verdictFor(partial, 0), "INCOMPLETE");
  });

  it("does not pass with failed checks either", () => {
    assert.notEqual(verdictFor(partial, 1), "PASS");
  });

  it("reports an observed failure as FAIL, which outranks unknown coverage", () => {
    assert.equal(verdictFor(partial, 2), "FAIL");
    assert.equal(verdictFor(full, 2), "FAIL");
  });

  it("exits non-zero for INCOMPLETE, and distinguishably from FAIL", () => {
    assert.equal(exitCodeFor("PASS"), 0);
    assert.notEqual(exitCodeFor("INCOMPLETE"), 0);
    assert.notEqual(exitCodeFor("INCOMPLETE"), exitCodeFor("FAIL"));
  });

  it("only a complete run with no failures passes", () => {
    assert.equal(verdictFor(full, 0), "PASS");
    assert.equal(exitCodeFor(verdictFor(full, 0)), 0);
  });

  it("holds across every combination of coverage and failures", () => {
    for (const coverage of [partial, full]) {
      for (const failed of [0, 1, 5]) {
        const verdict = verdictFor(coverage, failed);
        if (verdict === "PASS") {
          assert.equal(coverage.complete, true);
          assert.equal(failed, 0);
        }
      }
    }
  });
});

describe("comparing against the page's published count", () => {
  const full = aggregateCoverage([tokenCoverage(TOKEN_A, 100, 100)]);
  const partial = aggregateCoverage([tokenCoverage(TOKEN_A, 100, 40)]);

  it("compares when both sides are finished", () => {
    assert.deepEqual(comparisonReadiness(full, { complete: true }), {
      comparable: true,
      reason: "ok",
    });
  });

  it("refuses when the page is still confirming", () => {
    // The real case: a snapshot at 3 of 10 tokens carried 34 against a true 2,690.
    const readiness = comparisonReadiness(full, { complete: false });
    assert.equal(readiness.comparable, false);
    assert.equal(readiness.reason, "page-snapshot-incomplete");
  });

  it("refuses when the verifier could not decide every candidate", () => {
    const readiness = comparisonReadiness(partial, { complete: true });
    assert.equal(readiness.comparable, false);
    assert.equal(readiness.reason, "verifier-coverage-incomplete");
  });

  it("refuses when nothing has been published yet", () => {
    assert.equal(comparisonReadiness(full, null).reason, "no-snapshot");
  });

  it("reports the page's own incompleteness ahead of its coverage", () => {
    // Both are unfinished; naming the page's state is the actionable one.
    assert.equal(comparisonReadiness(partial, { complete: false }).reason, "page-snapshot-incomplete");
  });
});

describe("the run verdict", () => {
  const full = aggregateCoverage([tokenCoverage(TOKEN_A, 100, 100)]);
  const partial = aggregateCoverage([tokenCoverage(TOKEN_A, 100, 40)]);

  it("passes only when coverage is complete, nothing failed, and the comparison ran", () => {
    assert.equal(runVerdict({ coverage: full, failedChecks: 0, comparisonRan: true }), "PASS");
  });

  it("is INCOMPLETE when the comparison never ran, however good the coverage", () => {
    assert.equal(runVerdict({ coverage: full, failedChecks: 0, comparisonRan: false }), "INCOMPLETE");
  });

  it("is INCOMPLETE when coverage is partial, even if a comparison ran", () => {
    assert.equal(runVerdict({ coverage: partial, failedChecks: 0, comparisonRan: true }), "INCOMPLETE");
  });

  it("reports an observed failure as FAIL regardless of the rest", () => {
    assert.equal(runVerdict({ coverage: full, failedChecks: 1, comparisonRan: true }), "FAIL");
    assert.equal(runVerdict({ coverage: partial, failedChecks: 1, comparisonRan: false }), "FAIL");
  });

  it("never returns PASS unless all three conditions hold", () => {
    for (const coverage of [full, partial]) {
      for (const failedChecks of [0, 1]) {
        for (const comparisonRan of [true, false]) {
          if (runVerdict({ coverage, failedChecks, comparisonRan }) === "PASS") {
            assert.equal(coverage.complete, true);
            assert.equal(failedChecks, 0);
            assert.equal(comparisonRan, true);
          }
        }
      }
    }
  });
});