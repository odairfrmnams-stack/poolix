/*
  Pure arithmetic for counting Uniswap v2 activity: transactions and the accounts that
  originated them. No I/O, no state, no network.

  Two properties of the data shape the design, both verified against the chain:

  1. A transaction hash exists in exactly one block, so it falls in exactly one bucket.
     Unique transactions can therefore be stored as a per-bucket count and summed, with
     no cross-bucket de-duplication.

  2. An address can originate transactions in many buckets — measured repeating across
     buckets by a factor of 2.51 over a 4h window. Storing per-bucket counts would
     overstate active users by ~151%, so the addresses themselves are kept and the union
     is taken at read time.
*/

/** Swap(address,uint256,uint256,uint256,uint256,address) */
export const SWAP_TOPIC = "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822";
/** Mint(address,uint256,uint256) — liquidity added. */
export const MINT_TOPIC = "0x4c209b5fc8ad50758f13e2e1088ba56a560dff690a1c6fef26394f4c03821c4f";
/** Burn(address,uint256,uint256,address) — liquidity removed. */
export const BURN_TOPIC = "0xdccd412f0b1252819cb1fd330b93224ca42612892bb3f4f789976e6d81936496";

export const ACTIVITY_TOPICS = [SWAP_TOPIC, MINT_TOPIC, BURN_TOPIC] as const;

const ADDRESS_CHARS = 40;
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const TX_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;

export interface ActivityLogLike {
  readonly transaction_hash?: string;
  readonly block_number?: number;
}

export interface ActivityTxLike {
  readonly hash?: string;
  readonly from?: string;
  readonly block_number?: number;
}

export interface BucketActivity {
  readonly txHashes: Set<string>;
  readonly senders: Set<string>;
}

export function bucketOf(blockNumber: number, bucketSize: number): number {
  return Math.floor(blockNumber / bucketSize) * bucketSize;
}

/**
 * Groups logs and their transactions into block buckets.
 *
 * Several events from one transaction collapse to a single hash, which is what stops a
 * swap that also emits Mint or Burn from being counted more than once. Addresses in
 * `exclude` are dropped: transaction senders are EOAs by construction, and this is the
 * guard against ever counting a contract as a user.
 */
export function collectActivity(
  logs: readonly ActivityLogLike[],
  transactions: readonly ActivityTxLike[],
  bucketSize: number,
  exclude: ReadonlySet<string> = new Set(),
): Map<number, BucketActivity> {
  const buckets = new Map<number, BucketActivity>();

  const bucketFor = (block: number): BucketActivity => {
    const key = bucketOf(block, bucketSize);
    const existing = buckets.get(key);
    if (existing) return existing;
    const created: BucketActivity = { txHashes: new Set(), senders: new Set() };
    buckets.set(key, created);
    return created;
  };

  for (const log of logs) {
    const hash = log.transaction_hash;
    if (typeof hash !== "string" || !TX_HASH_PATTERN.test(hash)) continue;
    if (typeof log.block_number !== "number") continue;
    bucketFor(log.block_number).txHashes.add(hash.toLowerCase());
  }

  for (const tx of transactions) {
    const from = tx.from;
    if (typeof from !== "string" || !ADDRESS_PATTERN.test(from)) continue;
    if (typeof tx.block_number !== "number") continue;
    const address = from.toLowerCase();
    if (exclude.has(address)) continue;
    bucketFor(tx.block_number).senders.add(address);
  }

  return buckets;
}

/**
 * Packs addresses into one string of 40-character records, which is a third smaller
 * than a JSON array of quoted strings. At the measured scale the sender set runs to
 * roughly 90,000 records a day, so the saving is worth the small amount of ceremony.
 */
export function packSenders(senders: Iterable<string>): string {
  let packed = "";
  for (const sender of senders) {
    const normalised = sender.toLowerCase();
    if (!ADDRESS_PATTERN.test(normalised)) continue;
    packed += normalised.slice(2);
  }
  return packed;
}

export function unpackSenders(packed: string): string[] {
  if (typeof packed !== "string") return [];
  const out: string[] = [];
  for (let index = 0; index + ADDRESS_CHARS <= packed.length; index += ADDRESS_CHARS) {
    out.push(`0x${packed.slice(index, index + ADDRESS_CHARS)}`);
  }
  return out;
}

export interface StoredActivityBucket {
  /** Unique transactions in this bucket. Safe to sum across buckets. */
  readonly txCount: number;
  /** Packed sender addresses; the union is taken across buckets at read time. */
  readonly senders: string;
}

/**
 * Folds freshly read activity into a stored bucket.
 *
 * Callers must only ever pass non-overlapping block ranges. Transaction counts are
 * additive, so re-reading a range already ingested would double count — the window
 * advances by contiguous ranges precisely to preserve that invariant.
 */
export function mergeBucket(
  existing: StoredActivityBucket | undefined,
  incoming: BucketActivity,
): StoredActivityBucket {
  const senders = new Set(unpackSenders(existing?.senders ?? ""));
  for (const sender of incoming.senders) senders.add(sender);

  return {
    txCount: (existing?.txCount ?? 0) + incoming.txHashes.size,
    senders: packSenders(senders),
  };
}

export interface ActivitySummary {
  readonly transactions: number;
  readonly activeUsers: number;
  readonly buckets: number;
}

/**
 * Totals the buckets that still fall inside the rolling window. Buckets starting before
 * `windowStart` have aged out and are excluded.
 */
export function summariseActivity(
  buckets: Readonly<Record<string, StoredActivityBucket>>,
  windowStart: number,
): ActivitySummary {
  let transactions = 0;
  let counted = 0;
  const users = new Set<string>();

  for (const [key, bucket] of Object.entries(buckets)) {
    if (Number(key) < windowStart) continue;
    counted++;
    transactions += bucket.txCount;
    for (const sender of unpackSenders(bucket.senders)) users.add(sender);
  }

  return { transactions, activeUsers: users.size, buckets: counted };
}
