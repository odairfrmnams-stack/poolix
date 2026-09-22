import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  aprSortValue,
  filterPoolRows,
  filterTokenRows,
  metric,
  metricFrom,
  pointPrecedesCreation,
  sortPoolRows,
  sortTokenRows,
  unavailable,
  usdCentsOrNull,
  windowPublishable,
} from "@/services/analytics/dashboard-math";
import type { PoolRankingRow, TokenRankingRow } from "@/services/analytics/dashboard-view";

const ETH = 10n ** 18n;
const HOUR = 3_600;
const ORACLE = { answer: 300_000_000_000n, decimals: 8 }; // $3,000.00

const pool = (overrides: Partial<PoolRankingRow> & { pair: string }): PoolRankingRow => ({
  symbol0: "WETH",
  symbol1: "TKN",
  token0: "0x0000000000000000000000000000000000000001",
  token1: "0x0000000000000000000000000000000000000002",
  wethSide: "token0",
  liquidityWei: null,
  volume24hWei: null,
  fees24hWei: null,
  transactions24h: null,
  apr7dDisplay: null,
  apr30dDisplay: null,
  creationTimestamp: null,
  ...overrides,
});

const token = (overrides: Partial<TokenRankingRow> & { address: string }): TokenRankingRow => ({
  symbol: "TKN",
  decimals: 18,
  poolCount: 1,
  liquidityWei: null,
  priceEthWei: null,
  priceUsdCents: null,
  holders: null,
  tracked: true,
  ...overrides,
});

describe("metric availability", () => {
  it("carries a measured value", () => {
    const view = metric("42", "snapshot", "note");
    assert.equal(view.value, "42");
    assert.equal(view.unavailableReason, undefined);
  });

  it("renders an unavailable metric as null with a reason", () => {
    const view = unavailable("snapshot", "note", "Needs swap history");
    assert.equal(view.value, null);
    assert.equal(view.unavailableReason, "Needs swap history");
  });

  it("does not confuse a real zero with a missing reading", () => {
    const measured = metricFrom(true, () => "0", "snapshot", "n", "r");
    const missing = metricFrom(false, () => "0", "snapshot", "n", "r");
    assert.equal(measured.value, "0");
    assert.equal(missing.value, null);
  });

  it("does not evaluate the value when it is unavailable", () => {
    // The producer may throw or be meaningless when the metric was never measured.
    let called = false;
    metricFrom(false, () => {
      called = true;
      return "x";
    }, "snapshot", "n", "r");
    assert.equal(called, false);
  });

  it("keeps the kind, so a snapshot is never read as a historical total", () => {
    assert.equal(metric("1", "snapshot", "n").kind, "snapshot");
    assert.equal(metric("1", "historical-aggregate", "n").kind, "historical-aggregate");
    assert.equal(metric("1", "time-weighted", "n").kind, "time-weighted");
  });
});

describe("a total that is only a lower bound says so", () => {
  /*
    The rule the dashboard applies to 24h volume: unattributed swaps do not change the
    number, they change what the number claims to be. Encoded here as the note the metric
    carries, because "at least this much" and "this much" are different statements and the
    difference is the whole disclosure.
  */
  const noteFor = (unresolved: number) =>
    unresolved > 0
      ? `At least this much: ${unresolved.toLocaleString("en-US")} swaps are not yet attributed to a pair`
      : "Uniswap v2 Swap events over a rolling 24h block window, ETH side only";

  it("presents a fully attributed window as a measurement", () => {
    const view = metric("1000", "snapshot", noteFor(0));
    assert.match(view.note, /Uniswap v2 Swap events/);
    assert.doesNotMatch(view.note, /At least/);
  });

  it("presents a partly attributed window as a floor", () => {
    const view = metric("1000", "snapshot", noteFor(358));
    assert.match(view.note, /^At least this much/);
    assert.match(view.note, /358 swaps/);
  });

  it("does not alter the value itself", () => {
    // The figure stays exactly what the pipeline measured; only the claim changes.
    assert.equal(metric("1000", "snapshot", noteFor(358)).value, "1000");
    assert.equal(metric("1000", "snapshot", noteFor(0)).value, "1000");
  });

  it("keeps the metric available rather than withholding it", () => {
    // An undercount that is labelled is more useful than "--"; an unlabelled one is not.
    assert.notEqual(metric("1000", "snapshot", noteFor(358)).value, null);
  });
});

describe("USD conversion", () => {
  it("prices wei with a verified oracle round", () => {
    // 1 ETH at $3,000 is 300,000 cents.
    assert.equal(usdCentsOrNull(ETH, ORACLE), 300_000n);
  });

  it("returns null without an oracle rather than inventing a rate", () => {
    assert.equal(usdCentsOrNull(ETH, null), null);
  });

  it("returns null for a non-positive oracle answer", () => {
    assert.equal(usdCentsOrNull(ETH, { answer: 0n, decimals: 8 }), null);
    assert.equal(usdCentsOrNull(ETH, { answer: -1n, decimals: 8 }), null);
  });

  it("prices zero liquidity as zero, not as unavailable", () => {
    assert.equal(usdCentsOrNull(0n, ORACLE), 0n);
  });

  it("stays integral, truncating rather than rounding up", () => {
    // A third of an ETH at $3,000 is $999.9999...; reporting $1,000.00 would round a
    // figure up past a boundary a reader may care about, so it truncates.
    const cents = usdCentsOrNull(ETH / 3n, ORACLE);
    assert.equal(typeof cents, "bigint");
    assert.equal(cents, 99_999n);
  });
});

describe("window publishability", () => {
  it("publishes a window with every hour present", () => {
    assert.equal(windowPublishable(168, 168), true);
  });

  it("withholds a window with a hole rather than showing a smaller total", () => {
    assert.equal(windowPublishable(167, 168), false);
  });

  it("withholds an empty window", () => {
    assert.equal(windowPublishable(0, 0), false);
  });
});

describe("pool rankings", () => {
  const deep = pool({ pair: "0xaaa", liquidityWei: (100n * ETH).toString(), symbol1: "AAA" });
  const shallow = pool({ pair: "0xbbb", liquidityWei: (5n * ETH).toString(), symbol1: "BBB" });
  const tokenToken = pool({
    pair: "0xccc",
    symbol0: "AAA",
    symbol1: "BBB",
    wethSide: "none",
    transactions24h: 9,
  });

  it("ranks the deepest pool first", () => {
    const sorted = sortPoolRows([shallow, deep], "liquidity", "desc");
    assert.equal(sorted[0]?.pair, "0xaaa");
  });

  it("keeps a token/token pool in the ranking rather than dropping it", () => {
    const sorted = sortPoolRows([deep, shallow, tokenToken], "liquidity", "desc");
    assert.equal(sorted.length, 3);
    assert.equal(sorted.some((row) => row.pair === "0xccc"), true);
  });

  it("sinks rows with no figure, ascending as well as descending", () => {
    const desc = sortPoolRows([tokenToken, deep], "liquidity", "desc");
    const asc = sortPoolRows([tokenToken, deep], "liquidity", "asc");
    assert.equal(desc[desc.length - 1]?.pair, "0xccc");
    // Ascending must not promote "--" to the top.
    assert.equal(asc[asc.length - 1]?.pair, "0xccc");
  });

  it("still ranks a token/token pool by a figure it does have", () => {
    const sorted = sortPoolRows(
      [pool({ pair: "0xddd", transactions24h: 2 }), tokenToken],
      "transactions24h",
      "desc",
    );
    assert.equal(sorted[0]?.pair, "0xccc");
  });

  it("sorts by APR using the formatted value, without recomputing a rate", () => {
    const high = pool({ pair: "0x111", apr7dDisplay: "1,234.56%" });
    const low = pool({ pair: "0x222", apr7dDisplay: "12.00%" });
    const none = pool({ pair: "0x333", apr7dDisplay: null });
    const sorted = sortPoolRows([low, none, high], "apr7d", "desc");
    assert.deepEqual(sorted.map((r) => r.pair), ["0x111", "0x222", "0x333"]);
  });

  it("reads a formatted APR back for ordering only", () => {
    assert.equal(aprSortValue("1,234.56%"), 1234.56);
    assert.equal(aprSortValue("0.000000%"), 0);
    assert.equal(aprSortValue(null), null);
    assert.equal(aprSortValue("--"), null);
  });

  it("sorts by pair name", () => {
    const sorted = sortPoolRows([deep, shallow], "pair", "asc");
    assert.equal(sorted[0]?.symbol1, "AAA");
  });

  it("is stable when values tie, so rows do not reshuffle between renders", () => {
    const a = pool({ pair: "0x111", liquidityWei: ETH.toString() });
    const b = pool({ pair: "0x222", liquidityWei: ETH.toString() });
    assert.deepEqual(sortPoolRows([b, a], "liquidity", "desc").map((r) => r.pair), ["0x111", "0x222"]);
    assert.deepEqual(sortPoolRows([a, b], "liquidity", "desc").map((r) => r.pair), ["0x111", "0x222"]);
  });

  it("does not mutate the rows it was given", () => {
    const rows = [shallow, deep];
    sortPoolRows(rows, "liquidity", "desc");
    assert.equal(rows[0]?.pair, "0xbbb");
  });

  it("never fabricates a USD column for a pool", () => {
    // PoolRankingRow has no USD field at all: there is nothing to fabricate.
    assert.equal("priceUsdCents" in deep, false);
  });
});

describe("token rankings", () => {
  const big = token({ address: "0xaaa", symbol: "AAA", liquidityWei: (90n * ETH).toString(), poolCount: 3 });
  const small = token({ address: "0xbbb", symbol: "BBB", liquidityWei: ETH.toString(), poolCount: 1 });
  const unpriced = token({ address: "0xccc", symbol: "CCC", liquidityWei: null, priceEthWei: null });

  it("ranks by liquidity", () => {
    assert.equal(sortTokenRows([small, big], "liquidity", "desc")[0]?.address, "0xaaa");
  });

  it("sinks tokens with no liquidity figure", () => {
    const sorted = sortTokenRows([unpriced, small], "liquidity", "desc");
    assert.equal(sorted[sorted.length - 1]?.address, "0xccc");
  });

  it("ranks by pool count and by symbol", () => {
    assert.equal(sortTokenRows([small, big], "pools", "desc")[0]?.address, "0xaaa");
    assert.equal(sortTokenRows([big, small], "symbol", "asc")[0]?.symbol, "AAA");
  });

  it("sinks tokens with no holder figure rather than treating them as zero", () => {
    const counted = token({ address: "0xddd", holders: 12 });
    const sorted = sortTokenRows([unpriced, counted], "holders", "desc");
    assert.equal(sorted[0]?.address, "0xddd");
    assert.equal(sorted[1]?.holders, null);
  });

  it("carries no USD price unless one was supplied", () => {
    assert.equal(unpriced.priceUsdCents, null);
  });

  it("is stable when values tie", () => {
    const a = token({ address: "0x111", poolCount: 2 });
    const b = token({ address: "0x222", poolCount: 2 });
    assert.deepEqual(sortTokenRows([b, a], "pools", "desc").map((r) => r.address), ["0x111", "0x222"]);
  });
});

describe("filtering the rankings", () => {
  const rows = [
    pool({ pair: "0xabc123", symbol0: "WETH", symbol1: "STONK" }),
    pool({ pair: "0xdef456", symbol0: "WETH", symbol1: "DEED", token1: "0xfeed" }),
  ];

  it("returns everything for an empty query", () => {
    assert.equal(filterPoolRows(rows, "").length, 2);
    assert.equal(filterPoolRows(rows, "   ").length, 2);
  });

  it("matches a token symbol", () => {
    assert.equal(filterPoolRows(rows, "stonk").length, 1);
  });

  it("matches a pair address", () => {
    assert.equal(filterPoolRows(rows, "0xdef")[0]?.pair, "0xdef456");
  });

  it("matches a token address", () => {
    assert.equal(filterPoolRows(rows, "0xfeed")[0]?.pair, "0xdef456");
  });

  it("matches the pair as written", () => {
    assert.equal(filterPoolRows(rows, "weth/deed").length, 1);
  });

  it("ignores case", () => {
    assert.equal(filterPoolRows(rows, "STONK").length, 1);
  });

  it("returns nothing when nothing matches", () => {
    assert.equal(filterPoolRows(rows, "zzzz").length, 0);
  });

  it("filters tokens by symbol and address", () => {
    const tokens = [token({ address: "0xaaa", symbol: "AAA" }), token({ address: "0xbbb", symbol: "BBB" })];
    // "bbb" matches that token by both its address and its symbol, but it is one row.
    assert.deepEqual(filterTokenRows(tokens, "bbb").map((r) => r.address), ["0xbbb"]);
    assert.equal(filterTokenRows(tokens, "AAA")[0]?.address, "0xaaa");
    assert.equal(filterTokenRows(tokens, "").length, 2);
  });
});

describe("historical boundaries", () => {
  const created = 1_700_000_000;
  const bucket = Math.floor(created / HOUR) * HOUR;

  it("rejects a point from before the pool existed", () => {
    assert.equal(pointPrecedesCreation(bucket - HOUR, created, HOUR), true);
  });

  it("keeps the creation hour itself, which the pool lived through", () => {
    assert.equal(pointPrecedesCreation(bucket, created, HOUR), false);
  });

  it("keeps every later point", () => {
    assert.equal(pointPrecedesCreation(bucket + HOUR, created, HOUR), false);
  });

  it("draws everything when the creation date is unknown", () => {
    // Withholding the whole series because creation is unresolved would hide real data.
    assert.equal(pointPrecedesCreation(bucket - 1_000 * HOUR, null, HOUR), false);
  });
});
