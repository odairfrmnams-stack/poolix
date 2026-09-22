import { PONS_LAUNCH_TOPIC_A, PONS_LAUNCH_TOPIC_B, V3_SWAP_TOPIC } from "@/services/pons/pons-config";
import type { Address } from "@/types/web3";

/*
  Decoders for the Pons launch events and the Uniswap V3 Swap event.

  Pure: no I/O, no config beyond the verified constants, no `server-only`. That is what
  makes every branch below testable without a network, which matters because these
  functions decide what a launch IS.

  THE RULE, inherited from the multicall codec: anything that is not an exact, well-formed
  match decodes to `null`. A log with the right topic0 but the wrong number of topics, a
  short data field, or a zero address where an address is required is not a launch that is
  "mostly fine" — it is something this code does not understand, and the only safe answer
  is to say so.

  Event names are NOT known. The factory is unverified on the block explorer, so the two
  launch events are identified by topic0 hash and their fields were established
  empirically during the Phase 9A audit. Field meanings recorded here are the ones the
  chain proved; `data[5]` is deliberately left undecoded because nothing established what
  it is, and naming it would be inventing protocol behaviour.
*/

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const WORD = 64;

/** A log as the indexer sees it, shaped to what HyperSync returns. */
export interface RawLog {
  readonly address?: string;
  readonly topic0?: string;
  readonly topic1?: string;
  readonly topic2?: string;
  readonly topic3?: string;
  readonly data?: string;
  readonly block_number?: number;
  readonly transaction_hash?: string;
  readonly log_index?: number;
}

/** Event A: token, creator, and the constants that identify the launch as Pons. */
export interface LaunchEventA {
  readonly token: Address;
  readonly creator: Address;
  readonly v3Factory: Address;
  readonly quoteToken: Address;
  readonly blockNumber: number;
  readonly transactionHash: string;
}

/** Event B: the same identity plus the pool and the locked position. */
export interface LaunchEventB {
  readonly token: Address;
  readonly creator: Address;
  readonly v3Factory: Address;
  readonly quoteToken: Address;
  readonly pool: Address;
  readonly positionTokenId: bigint;
  /**
   * A variable wei amount, observed as 0.01 / 0.0271 / 0 / 0.0015 ETH.
   *
   * It is NOT the launch fee: the documented fee is a constant 0.0005 ETH and this field
   * varies and can be zero. What it actually represents was not established, so it is
   * carried through unnamed and must not be presented to a user as anything.
   */
  readonly unverifiedWeiAmount: bigint;
  readonly blockNumber: number;
  readonly transactionHash: string;
}

export interface V3SwapEvent {
  readonly pool: Address;
  /** Signed: negative means the pool paid it out. */
  readonly amount0: bigint;
  readonly amount1: bigint;
  readonly sqrtPriceX96: bigint;
  readonly liquidity: bigint;
  readonly tick: number;
  readonly blockNumber: number;
}

// --------------------------------------------------------------------- helpers

const isHexWord = (value: string): boolean => /^0x[0-9a-fA-F]{64}$/.test(value);

/**
 * A 32-byte word as a lower-cased address, or null if the padding is not clean.
 *
 * Accepts the word with or without its `0x`, because topics arrive prefixed and data words
 * do not. Normalising here rather than at each call site is deliberate: the version that
 * only handled prefixed words silently rejected every address carried in data, which
 * looked exactly like "no launches found".
 */
function wordToAddress(word: string | undefined, allowZero = false): Address | null {
  if (typeof word !== "string") return null;
  const padded = word.startsWith("0x") ? word : `0x${word}`;
  if (!isHexWord(padded)) return null;
  // The top 12 bytes of an address word must be zero. If they are not, this word is not
  // an address and treating it as one would silently truncate a real value.
  if (padded.slice(2, 26) !== "0".repeat(24)) return null;
  const address = `0x${padded.slice(26).toLowerCase()}`;
  if (!allowZero && address === ZERO_ADDRESS) return null;
  return address as Address;
}

function dataWords(data: string | undefined, expected: number): string[] | null {
  if (typeof data !== "string" || !data.startsWith("0x")) return null;
  const body = data.slice(2);
  if (body.length !== expected * WORD) return null;
  if (!/^[0-9a-fA-F]*$/.test(body)) return null;
  return body.match(/.{64}/g) ?? null;
}

function wordToBigint(word: string | undefined): bigint | null {
  if (typeof word !== "string") return null;
  const padded = word.startsWith("0x") ? word : `0x${word}`;
  if (!isHexWord(padded)) return null;
  try {
    return BigInt(padded);
  } catch {
    return null;
  }
}

function blockAndTx(log: RawLog): { blockNumber: number; transactionHash: string } | null {
  const blockNumber = log.block_number;
  const transactionHash = log.transaction_hash;
  if (typeof blockNumber !== "number" || !Number.isSafeInteger(blockNumber) || blockNumber < 0) {
    return null;
  }
  if (typeof transactionHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(transactionHash)) {
    return null;
  }
  return { blockNumber, transactionHash: transactionHash.toLowerCase() };
}

// ---------------------------------------------------------------------- event A

/**
 * Decodes launch event A: 4 topics, 3 data words.
 *
 * Layout established in the audit:
 *   topic1  token      (varies; resolves to an ERC-20 with 1e27 supply)
 *   topic2  creator    (varies; no contract code, i.e. an EOA)
 *   topic3  v3Factory  (constant)
 *   data[0] quoteToken (constant, WETH)
 *   data[1..2] zero in every observed sample
 */
export function decodeLaunchA(log: RawLog): LaunchEventA | null {
  if (log.topic0 !== PONS_LAUNCH_TOPIC_A) return null;

  const token = wordToAddress(log.topic1);
  const creator = wordToAddress(log.topic2);
  const v3Factory = wordToAddress(log.topic3);
  if (token === null || creator === null || v3Factory === null) return null;
  // A token that is its own creator is not a shape this protocol produces.
  if (token === creator) return null;

  const words = dataWords(log.data, 3);
  if (words === null) return null;

  const quoteToken = wordToAddress(words[0]);
  if (quoteToken === null) return null;
  if (token === quoteToken) return null;

  const position = blockAndTx(log);
  if (position === null) return null;

  return { token, creator, v3Factory, quoteToken, ...position };
}

// ---------------------------------------------------------------------- event B

/**
 * Decodes launch event B: 4 topics, 7 data words.
 *
 *   data[0] quoteToken       (constant, WETH)
 *   data[1] pool             (matches v3Factory.getPool(token, WETH, 10000) in every sample)
 *   data[2..3] zero in every observed sample
 *   data[4] positionTokenId  (ownerOf resolves to the Pons locker)
 *   data[5] UNDETERMINED     — monotonic, not a tokenId, not a timestamp. Left undecoded.
 *   data[6] a variable wei amount (see the field's own note)
 */
export function decodeLaunchB(log: RawLog): LaunchEventB | null {
  if (log.topic0 !== PONS_LAUNCH_TOPIC_B) return null;

  const token = wordToAddress(log.topic1);
  const creator = wordToAddress(log.topic2);
  const v3Factory = wordToAddress(log.topic3);
  if (token === null || creator === null || v3Factory === null) return null;
  if (token === creator) return null;

  const words = dataWords(log.data, 7);
  if (words === null) return null;

  const quoteToken = wordToAddress(words[0]);
  const pool = wordToAddress(words[1]);
  if (quoteToken === null || pool === null) return null;
  if (token === quoteToken || pool === token || pool === quoteToken) return null;

  const positionTokenId = wordToBigint(words[4]);
  const unverifiedWeiAmount = wordToBigint(words[6]);
  if (positionTokenId === null || unverifiedWeiAmount === null) return null;
  // A launch always mints a position; id zero would mean no position was recorded.
  if (positionTokenId === 0n) return null;

  const position = blockAndTx(log);
  if (position === null) return null;

  return {
    token,
    creator,
    v3Factory,
    quoteToken,
    pool,
    positionTokenId,
    unverifiedWeiAmount,
    ...position,
  };
}

// ------------------------------------------------------------------- V3 swap

/**
 * Decodes the canonical Uniswap V3 Swap event: 3 topics, 5 data words.
 *
 * `amount0` and `amount1` are int256 and one of them is always negative — the side the
 * pool paid out. Reading them as unsigned would turn every sell into an astronomically
 * large buy, so the sign handling here is the whole point of the function.
 */
export function decodeV3Swap(log: RawLog): V3SwapEvent | null {
  if (log.topic0 !== V3_SWAP_TOPIC) return null;

  const pool = wordToAddress(
    typeof log.address === "string" && log.address.startsWith("0x") && log.address.length === 42
      ? `0x${log.address.slice(2).toLowerCase().padStart(64, "0")}`
      : undefined,
  );
  if (pool === null) return null;

  const words = dataWords(log.data, 5);
  if (words === null) return null;

  const raw0 = wordToBigint(words[0]);
  const raw1 = wordToBigint(words[1]);
  const sqrtPriceX96 = wordToBigint(words[2]);
  const liquidity = wordToBigint(words[3]);
  const rawTick = wordToBigint(words[4]);
  if (raw0 === null || raw1 === null || sqrtPriceX96 === null || liquidity === null || rawTick === null) {
    return null;
  }

  const blockNumber = log.block_number;
  if (typeof blockNumber !== "number" || !Number.isSafeInteger(blockNumber) || blockNumber < 0) {
    return null;
  }

  const amount0 = BigInt.asIntN(256, raw0);
  const amount1 = BigInt.asIntN(256, raw1);
  // A swap moves value in both directions; if either side is zero this is not one.
  if (amount0 === 0n || amount1 === 0n) return null;
  // Both sides positive or both negative cannot happen in a real swap.
  if (amount0 > 0n === amount1 > 0n) return null;

  return {
    pool,
    amount0,
    amount1,
    sqrtPriceX96,
    liquidity,
    tick: Number(BigInt.asIntN(24, rawTick)),
    blockNumber,
  };
}

/**
 * Pairs the two launch events by transaction.
 *
 * Both fire in the same transaction, so the transaction hash is the join key. A launch is
 * only complete when BOTH are present and they agree on token, creator and quote token —
 * event A alone carries no pool, and disagreement means the pairing is wrong rather than
 * merely partial.
 */
export function pairLaunches(logs: readonly RawLog[]): LaunchEventB[] {
  const aByTx = new Map<string, LaunchEventA>();
  for (const log of logs) {
    const a = decodeLaunchA(log);
    if (a !== null) aByTx.set(a.transactionHash, a);
  }

  const paired: LaunchEventB[] = [];
  const seenTx = new Set<string>();
  for (const log of logs) {
    const b = decodeLaunchB(log);
    if (b === null) continue;
    // One launch per transaction; a repeat is a duplicate, not a second launch.
    if (seenTx.has(b.transactionHash)) continue;

    const a = aByTx.get(b.transactionHash);
    if (a === undefined) continue;
    if (a.token !== b.token || a.creator !== b.creator || a.quoteToken !== b.quoteToken) continue;

    seenTx.add(b.transactionHash);
    paired.push(b);
  }
  return paired;
}
