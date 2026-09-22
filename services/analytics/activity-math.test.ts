import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ACTIVITY_TOPICS,
  BURN_TOPIC,
  bucketOf,
  collectActivity,
  MINT_TOPIC,
  mergeBucket,
  packSenders,
  SWAP_TOPIC,
  summariseActivity,
  unpackSenders,
  type StoredActivityBucket,
} from "@/services/analytics/activity-math";

const BUCKET = 7_200;

const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;

const log = (txIndex: number, block: number) => ({ transaction_hash: hash(txIndex), block_number: block });
const tx = (from: number, block: number, txIndex = from) => ({
  hash: hash(txIndex),
  from: addr(from),
  block_number: block,
});

describe("topics", () => {
  it("pins the three Uniswap v2 activity events", () => {
    // Derived with keccak256 and confirmed against live logs on chain 4663.
    assert.equal(SWAP_TOPIC, "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822");
    assert.equal(MINT_TOPIC, "0x4c209b5fc8ad50758f13e2e1088ba56a560dff690a1c6fef26394f4c03821c4f");
    assert.equal(BURN_TOPIC, "0xdccd412f0b1252819cb1fd330b93224ca42612892bb3f4f789976e6d81936496");
    assert.equal(ACTIVITY_TOPICS.length, 3);
  });
});

describe("transaction hash de-duplication", () => {
  it("counts a transaction once no matter how many logs it emitted", () => {
    // One transaction that emitted Swap, Mint and Burn.
    const buckets = collectActivity([log(1, 100), log(1, 100), log(1, 100)], [], BUCKET);
    const bucket = buckets.get(0);
    assert.ok(bucket);
    assert.equal(bucket.txHashes.size, 1);
  });

  it("separates genuinely different transactions in the same block", () => {
    const buckets = collectActivity([log(1, 100), log(2, 100), log(3, 100)], [], BUCKET);
    assert.equal(buckets.get(0)?.txHashes.size, 3);
  });

  it("is case-insensitive about hashes", () => {
    const upper = hash(1).toUpperCase().replace("0X", "0x");
    const buckets = collectActivity(
      [{ transaction_hash: hash(1), block_number: 5 }, { transaction_hash: upper, block_number: 5 }],
      [],
      BUCKET,
    );
    assert.equal(buckets.get(0)?.txHashes.size, 1);
  });

  it("skips malformed or blockless logs rather than counting them", () => {
    const buckets = collectActivity(
      [
        { transaction_hash: "0xshort", block_number: 1 },
        { transaction_hash: hash(1) }, // no block
        { block_number: 1 }, // no hash
        log(2, 1),
      ],
      [],
      BUCKET,
    );
    assert.equal(buckets.get(0)?.txHashes.size, 1);
  });
});

describe("unique active users", () => {
  it("counts an address once however many transactions it sent", () => {
    const buckets = collectActivity([], [tx(7, 10, 1), tx(7, 20, 2), tx(7, 30, 3)], BUCKET);
    assert.equal(buckets.get(0)?.senders.size, 1);
  });

  it("counts distinct senders separately", () => {
    const buckets = collectActivity([], [tx(1, 10), tx(2, 10), tx(3, 10)], BUCKET);
    assert.equal(buckets.get(0)?.senders.size, 3);
  });

  it("normalises case so one address is never counted twice", () => {
    const buckets = collectActivity(
      [],
      [
        { hash: hash(1), from: addr(9), block_number: 1 },
        { hash: hash(2), from: addr(9).toUpperCase().replace("0X", "0x"), block_number: 1 },
      ],
      BUCKET,
    );
    assert.equal(buckets.get(0)?.senders.size, 1);
  });

  it("de-duplicates the same address across buckets at read time", () => {
    // The measured repeat factor across buckets is 2.51, so this is the property that
    // keeps active users from being overstated.
    const stored: Record<string, StoredActivityBucket> = {
      "0": { txCount: 2, senders: packSenders([addr(1), addr(2)]) },
      "7200": { txCount: 3, senders: packSenders([addr(2), addr(3)]) },
      "14400": { txCount: 1, senders: packSenders([addr(1), addr(3)]) },
    };
    const summary = summariseActivity(stored, 0);
    assert.equal(summary.transactions, 6);
    assert.equal(summary.activeUsers, 3); // not 6
  });
});

describe("contract address filtering", () => {
  it("drops excluded addresses from the user set", () => {
    const router = addr(0x89e5);
    const buckets = collectActivity([], [tx(1, 10), { hash: hash(2), from: router, block_number: 10 }], BUCKET, new Set([router]));
    assert.equal(buckets.get(0)?.senders.size, 1);
    assert.ok(!buckets.get(0)?.senders.has(router));
  });

  it("still counts the excluded sender's transaction", () => {
    // Excluding an address from "users" must not erase the activity it caused.
    const router = addr(0x89e5);
    const buckets = collectActivity(
      [log(2, 10)],
      [{ hash: hash(2), from: router, block_number: 10 }],
      BUCKET,
      new Set([router]),
    );
    assert.equal(buckets.get(0)?.txHashes.size, 1);
    assert.equal(buckets.get(0)?.senders.size, 0);
  });

  it("rejects malformed addresses", () => {
    const buckets = collectActivity([], [{ hash: hash(1), from: "0xnope", block_number: 1 }], BUCKET);
    assert.equal(buckets.get(0)?.senders.size ?? 0, 0);
  });
});

describe("rolling 24-hour window", () => {
  const stored: Record<string, StoredActivityBucket> = {
    "0": { txCount: 10, senders: packSenders([addr(1)]) },
    "7200": { txCount: 20, senders: packSenders([addr(2)]) },
    "14400": { txCount: 30, senders: packSenders([addr(3)]) },
  };

  it("includes every bucket when the window covers them all", () => {
    const summary = summariseActivity(stored, 0);
    assert.equal(summary.transactions, 60);
    assert.equal(summary.activeUsers, 3);
    assert.equal(summary.buckets, 3);
  });

  it("drops buckets that have aged out of the window", () => {
    const summary = summariseActivity(stored, 7_200);
    assert.equal(summary.transactions, 50);
    assert.equal(summary.activeUsers, 2);
    assert.equal(summary.buckets, 2);
  });

  it("returns zeroes rather than stale totals once everything has aged out", () => {
    const summary = summariseActivity(stored, 1_000_000);
    assert.equal(summary.transactions, 0);
    assert.equal(summary.activeUsers, 0);
  });

  it("assigns blocks to buckets by floor of the bucket size", () => {
    assert.equal(bucketOf(0, BUCKET), 0);
    assert.equal(bucketOf(7_199, BUCKET), 0);
    assert.equal(bucketOf(7_200, BUCKET), 7_200);
    assert.equal(bucketOf(65_441_757, BUCKET), 65_440_800);
  });
});

describe("multi-event transactions", () => {
  it("counts one transaction and one user for a Swap that also emitted Mint", () => {
    const buckets = collectActivity(
      [log(42, 500), log(42, 500)], // two events, one transaction
      [tx(11, 500, 42)],
      BUCKET,
    );
    const bucket = buckets.get(0);
    assert.ok(bucket);
    assert.equal(bucket.txHashes.size, 1);
    assert.equal(bucket.senders.size, 1);
  });

  it("holds when a transaction spans several pairs", () => {
    // A multi-hop route emits a Swap per pair, all under one hash.
    const logs = [log(77, 900), log(77, 900), log(77, 900), log(78, 901)];
    const buckets = collectActivity(logs, [tx(5, 900, 77), tx(6, 901, 78)], BUCKET);
    assert.equal(buckets.get(0)?.txHashes.size, 2);
    assert.equal(buckets.get(0)?.senders.size, 2);
  });
});

describe("bootstrap and incremental merging", () => {
  it("accumulates transactions as non-overlapping ranges are merged", () => {
    // Incremental: a later range adds to the same bucket.
    let bucket = mergeBucket(undefined, {
      txHashes: new Set([hash(1), hash(2)]),
      senders: new Set([addr(1)]),
    });
    assert.equal(bucket.txCount, 2);

    bucket = mergeBucket(bucket, { txHashes: new Set([hash(3)]), senders: new Set([addr(2)]) });
    assert.equal(bucket.txCount, 3);
    assert.equal(unpackSenders(bucket.senders).length, 2);
  });

  it("unions senders across merges instead of double counting them", () => {
    // Bootstrap reads an earlier range in the same bucket; the same address reappears.
    let bucket = mergeBucket(undefined, { txHashes: new Set([hash(1)]), senders: new Set([addr(9)]) });
    bucket = mergeBucket(bucket, { txHashes: new Set([hash(2)]), senders: new Set([addr(9)]) });

    assert.equal(bucket.txCount, 2); // two distinct transactions
    assert.deepEqual(unpackSenders(bucket.senders), [addr(9)]); // one user
  });

  it("starts from nothing on a cold bootstrap", () => {
    const bucket = mergeBucket(undefined, { txHashes: new Set(), senders: new Set() });
    assert.equal(bucket.txCount, 0);
    assert.equal(bucket.senders, "");
    assert.deepEqual(unpackSenders(bucket.senders), []);
  });

  it("survives a round trip through the packed storage form", () => {
    const addresses = [addr(1), addr(2), addr(3)];
    assert.deepEqual(unpackSenders(packSenders(addresses)), addresses);
    // A truncated tail is ignored rather than yielding a malformed address.
    assert.deepEqual(unpackSenders(`${packSenders([addr(1)])}abc`), [addr(1)]);
  });
});
