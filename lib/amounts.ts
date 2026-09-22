import { formatUnits, parseUnits } from "viem";

/**
 * Normalises what a user can type into an amount field: digits, at most one decimal
 * separator, and no more decimal places than the token has. Returning a string rather
 * than a number keeps the caret stable and avoids float rounding.
 */
/**
 * Longest amount string accepted.
 *
 * 78 digits is uint256 at its widest, and a decimal point and separator leave room to
 * spare. Anything past this is a paste of something that is not an amount, and truncating
 * it here stops a megabyte of text being regex-scanned and parsed on every keystroke.
 */
export const MAX_AMOUNT_INPUT_LENGTH = 80;

export function sanitizeAmountInput(value: string, decimals: number): string {
  const bounded = value.length > MAX_AMOUNT_INPUT_LENGTH ? value.slice(0, MAX_AMOUNT_INPUT_LENGTH) : value;
  const normalised = bounded.replace(/,/g, ".").replace(/[^\d.]/g, "");

  const [whole = "", ...rest] = normalised.split(".");
  const trimmedWhole = whole.replace(/^0+(?=\d)/, "");
  if (rest.length === 0) return trimmedWhole;

  const fraction = rest.join("").slice(0, Math.max(decimals, 0));
  return decimals === 0 ? trimmedWhole : `${trimmedWhole || "0"}.${fraction}`;
}

/** Null for an empty or incomplete entry such as "" or "0."; never throws. */
export function parseAmount(value: string, decimals: number): bigint | null {
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === ".") return null;
  try {
    const parsed = parseUnits(sanitizeAmountInput(trimmed, decimals), decimals);
    return parsed > 0n ? parsed : null;
  } catch {
    return null;
  }
}

/** Fills an amount field from a balance, at full precision so nothing is left behind. */
export function toAmountInput(value: bigint, decimals: number): string {
  return formatUnits(value, decimals);
}

/**
 * Native balances must keep enough ETH for gas, otherwise "Max" produces a
 * transaction the user can never afford to send.
 */
export function maxSpendableNative(balance: bigint, gasReserve: bigint): bigint {
  return balance > gasReserve ? balance - gasReserve : 0n;
}
