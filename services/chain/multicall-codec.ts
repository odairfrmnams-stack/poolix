import type { Address, Hex } from "@/types/web3";

/*
  ABI encoding and decoding for Multicall3's aggregate3. Pure: no I/O, no `server-only`,
  so the decoder can be tested directly.

  The decoder is the one place a batched read could invent a balance that was never
  returned, which is why it lives apart from the transport and is exercised on every
  failure mode rather than just the happy path. Its rule is absolute: anything that is not
  an explicit success carrying exactly one 32-byte word decodes to `null`. Null is the
  caller's "unanswered", and an unanswered address stays queued rather than being recorded
  as holding nothing.
*/

export interface Call {
  readonly to: Address;
  readonly data: Hex;
}

export const AGGREGATE3_SELECTOR = "0x82ad56cb";

const pad = (value: string) => value.replace(/^0x/, "").toLowerCase().padStart(64, "0");

/**
 * ABI-encodes aggregate3((address target, bool allowFailure, bytes callData)[]).
 *
 * `allowFailure` is always true. A reverting call must come back as a failed entry rather
 * than reverting the whole batch, because one bad token would otherwise cost every other
 * address in the request.
 */
export function encodeAggregate3(calls: readonly Call[]): string {
  const payloads = calls.map((call) => call.data.replace(/^0x/, ""));
  const structBytes = payloads.map((payload) => 32 * 4 + Math.ceil(payload.length / 2 / 32) * 32);

  let running = 32 * calls.length;
  const offsets: string[] = [];
  for (const size of structBytes) {
    offsets.push(pad(running.toString(16)));
    running += size;
  }

  const structs = calls.map((call, index) => {
    const payload = payloads[index] ?? "";
    const byteLength = payload.length / 2;
    const padded = payload.padEnd(Math.ceil(byteLength / 32) * 64, "0");
    return [pad(call.to), pad("1"), pad("60"), pad(byteLength.toString(16)), padded].join("");
  });

  return `${AGGREGATE3_SELECTOR}${pad("20")}${pad(calls.length.toString(16))}${offsets.join("")}${structs.join("")}`;
}

/**
 * Decodes `(bool success, bytes returnData)[]`.
 *
 * Returns null for every entry that did not succeed, and for one whose return data is not
 * a single 32-byte word. A short or empty return is a call that did not answer the
 * question asked, and treating it as a value would be inventing one.
 *
 * A response whose array length disagrees with the number of calls made decodes entirely
 * to nulls: entries are matched to addresses by position, so a length mismatch means no
 * entry can be attributed to an address with confidence.
 */
export function decodeAggregate3(result: string, expected: number): (Hex | null)[] {
  const body = result.replace(/^0x/, "");
  const out: (Hex | null)[] = Array<Hex | null>(expected).fill(null);
  if (body.length < 128 || !/^[0-9a-fA-F]*$/.test(body)) return out;

  const at = (byteOffset: number) => body.slice(byteOffset * 2, byteOffset * 2 + 64);
  const num = (hex: string) => (hex.length === 64 ? Number(BigInt(`0x${hex}`)) : Number.NaN);

  const arrayOffset = num(at(0));
  if (!Number.isSafeInteger(arrayOffset)) return out;
  const length = num(at(arrayOffset));
  if (!Number.isSafeInteger(length) || length !== expected) return out;

  const dataStart = arrayOffset + 32;
  for (let index = 0; index < length; index++) {
    const elementOffset = num(at(dataStart + index * 32));
    if (!Number.isSafeInteger(elementOffset)) continue;
    const element = dataStart + elementOffset;

    if (num(at(element)) !== 1) continue; // success === false

    const bytesOffset = num(at(element + 32));
    if (!Number.isSafeInteger(bytesOffset)) continue;
    const bytesAt = element + bytesOffset;
    // A balance is exactly one word. Anything else is not an answer.
    if (num(at(bytesAt)) !== 32) continue;

    const value = at(bytesAt + 32);
    if (value.length !== 64) continue;
    out[index] = `0x${value}` as Hex;
  }

  return out;
}

/**
 * Like `decodeAggregate3`, but accepts return data of any byte length rather than
 * requiring exactly one 32-byte word.
 *
 * Used by callers that batch calls with different return signatures in one aggregate3
 * request — for example, `token0()` returns one address word while `getReserves()`
 * returns three words. The caller decodes each entry according to its position.
 *
 * The safety contract is the same: a failed entry, an empty return, or a response
 * whose array length disagrees with the request all decode to null.
 */
export function decodeAggregate3Bytes(result: string, expected: number): (Hex | null)[] {
  const body = result.replace(/^0x/, "");
  const out: (Hex | null)[] = Array<Hex | null>(expected).fill(null);
  if (body.length < 128 || !/^[0-9a-fA-F]*$/.test(body)) return out;

  const at = (byteOffset: number) => body.slice(byteOffset * 2, byteOffset * 2 + 64);
  const num = (hex: string) => (hex.length === 64 ? Number(BigInt(`0x${hex}`)) : Number.NaN);

  const arrayOffset = num(at(0));
  if (!Number.isSafeInteger(arrayOffset)) return out;
  const length = num(at(arrayOffset));
  if (!Number.isSafeInteger(length) || length !== expected) return out;

  const dataStart = arrayOffset + 32;
  for (let index = 0; index < length; index++) {
    const elementOffset = num(at(dataStart + index * 32));
    if (!Number.isSafeInteger(elementOffset)) continue;
    const element = dataStart + elementOffset;

    if (num(at(element)) !== 1) continue;

    const bytesOffset = num(at(element + 32));
    if (!Number.isSafeInteger(bytesOffset)) continue;
    const bytesAt = element + bytesOffset;
    const byteLength = num(at(bytesAt));
    if (!Number.isSafeInteger(byteLength) || byteLength === 0) continue;

    const dataHex = body.slice((bytesAt + 32) * 2, (bytesAt + 32) * 2 + byteLength * 2);
    if (dataHex.length !== byteLength * 2) continue;
    out[index] = `0x${dataHex}` as Hex;
  }

  return out;
}
