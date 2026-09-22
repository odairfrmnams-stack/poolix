import { getAddress, isAddress } from "viem";

import type { Address } from "@/types/web3";

/*
  Address validation at the trust boundary.

  Poolix already had address handling, but it was spread across roughly twenty call sites
  using viem's `isAddress`/`getAddress` directly, with different answers to the same
  questions: does an unchecksummed string count, is the zero address allowed, what happens
  to a 10,000-character input, and does a malformed value throw or return null. Some call
  sites called `getAddress` with no prior check, which throws.

  This is that decision made once. It is deliberately strict and deliberately explicit:
  every rejection has a named reason, so a caller can say WHY something was refused rather
  than rendering a blank.

  WHAT IT DOES NOT REPLACE. `normalizeAddress` in portfolio-math and pool-analytics-math
  lowercases addresses for use as map keys in the analytics pipelines. Those are not
  validation and are not user-facing; they are left exactly as they are, because changing
  how an analytics key is derived would change analytics results.
*/

/** An Ethereum address is 42 characters. Anything beyond this is not a typo. */
const MAX_ADDRESS_LENGTH = 64;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** The dead address. Not zero, but equally never a real counterparty. */
const BURN_ADDRESS = "0x000000000000000000000000000000000000dEaD";

export type AddressRejection =
  /** Not a string at all — a number, an object, null, undefined. */
  | "not-a-string"
  | "empty"
  /** Long enough that it is a paste of something else, not a mistyped address. */
  | "too-long"
  /** Wrong length, wrong prefix, or non-hex characters. */
  | "malformed"
  | "zero-address"
  | "burn-address";

export type AddressResult =
  | { readonly ok: true; readonly address: Address }
  | { readonly ok: false; readonly reason: AddressRejection };

export interface AddressOptions {
  /**
   * Allow the zero address. Off by default: it is a valid 20-byte value but is never a
   * valid token, pool, spender or recipient, and accepting it silently is how "burn"
   * becomes indistinguishable from "unset".
   */
  readonly allowZero?: boolean;
  /** Allow 0x…dEaD. Off by default, for the same reason. */
  readonly allowBurn?: boolean;
}

/**
 * Validates and checksums an address.
 *
 * Checksums are **normalised, never trusted**: a lowercase address and a mixed-case one
 * that differ only in case describe the same account, so rejecting an unchecksummed
 * string would reject most hand-typed input for no security gain. What matters is that
 * the output is always in one canonical form, so two references to the same address can
 * never compare unequal.
 */
export function parseAddress(value: unknown, options: AddressOptions = {}): AddressResult {
  if (typeof value !== "string") return { ok: false, reason: "not-a-string" };

  const trimmed = value.trim();
  if (trimmed === "") return { ok: false, reason: "empty" };
  // Checked before the pattern so a megabyte of text is rejected on its length, not
  // matched against a regex first.
  if (trimmed.length > MAX_ADDRESS_LENGTH) return { ok: false, reason: "too-long" };
  if (!isAddress(trimmed, { strict: false })) return { ok: false, reason: "malformed" };

  const address = getAddress(trimmed);
  if (!options.allowZero && address === ZERO_ADDRESS) return { ok: false, reason: "zero-address" };
  if (!options.allowBurn && address === BURN_ADDRESS) return { ok: false, reason: "burn-address" };

  return { ok: true, address };
}

/** The checksummed address, or null. For callers with nothing useful to say about why. */
export function toAddress(value: unknown, options: AddressOptions = {}): Address | null {
  const result = parseAddress(value, options);
  return result.ok ? result.address : null;
}

export function isSafeAddress(value: unknown, options: AddressOptions = {}): boolean {
  return parseAddress(value, options).ok;
}

/** Why an address was refused, in words a user can act on. */
export function describeRejection(reason: AddressRejection): string {
  switch (reason) {
    case "not-a-string":
      return "That is not an address.";
    case "empty":
      return "Enter an address.";
    case "too-long":
      return "That is too long to be an address.";
    case "malformed":
      return "That is not a valid contract address.";
    case "zero-address":
      return "The zero address cannot be used here.";
    case "burn-address":
      return "The burn address cannot be used here.";
  }
}

/**
 * True when two addresses are the same account, whatever their casing.
 *
 * Both sides are validated, so comparing a malformed string with another malformed string
 * is false rather than accidentally true.
 */
export function sameAddress(a: unknown, b: unknown): boolean {
  const left = toAddress(a, { allowZero: true, allowBurn: true });
  const right = toAddress(b, { allowZero: true, allowBurn: true });
  return left !== null && right !== null && left === right;
}

/**
 * Whether a chain id is the one Poolix is configured for.
 *
 * Accepts `unknown` because the value usually arrives from a wallet, where it may be a
 * number, a hex string, or absent entirely.
 */
export function isExpectedChain(chainId: unknown, expected: number): boolean {
  if (typeof chainId === "number") return Number.isSafeInteger(chainId) && chainId === expected;
  if (typeof chainId === "string" && chainId.trim() !== "") {
    try {
      return Number(BigInt(chainId)) === expected;
    } catch {
      return false;
    }
  }
  return false;
}
