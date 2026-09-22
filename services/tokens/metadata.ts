import { erc20Abi, getAddress, hexToString, isAddress, type PublicClient } from "viem";

import { isUsableDecimals, MAX_TOKEN_DECIMALS, sanitizeName, sanitizeSymbol } from "@/lib/token-text";
import type { Currency } from "@/services/liquidity/types";
import type { Address } from "@/types/web3";

/** Older tokens return a bytes32 symbol/name instead of a string. */
const bytes32MetadataAbi = [
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
] as const;

export class TokenNotFoundError extends Error {
  override readonly name = "TokenNotFoundError";
}

function trimBytes32(value: `0x${string}`): string {
  return hexToString(value, { size: 32 }).replace(/\0+$/, "").trim();
}

async function readTextField(
  client: PublicClient,
  address: Address,
  field: "symbol" | "name",
): Promise<string | null> {
  try {
    const value = await client.readContract({ address, abi: erc20Abi, functionName: field });
    return value.trim() || null;
  } catch {
    try {
      const value = await client.readContract({ address, abi: bytes32MetadataAbi, functionName: field });
      return trimBytes32(value) || null;
    } catch {
      return null;
    }
  }
}

/**
 * Reads a token's metadata from the chain. `decimals` is required: without it every
 * amount Poolix displays or sends would be wrong, so a token that does not expose it
 * is rejected rather than guessed at.
 */
export async function fetchTokenMetadata(client: PublicClient, value: string): Promise<Currency> {
  if (!isAddress(value)) {
    throw new TokenNotFoundError("That is not a valid contract address.");
  }
  const address = getAddress(value);

  const code = await client.getCode({ address });
  if (code === undefined || code === "0x") {
    throw new TokenNotFoundError("No contract is deployed at that address.");
  }

  let decimals: number;
  try {
    decimals = await client.readContract({ address, abi: erc20Abi, functionName: "decimals" });
  } catch {
    throw new TokenNotFoundError("That contract does not look like an ERC-20 token.");
  }

  /*
    `decimals` is a uint8, so 255 is a valid answer and a plausible one from a contract
    built to be awkward. Every amount Poolix would then show or send for this token is off
    by an astronomical factor, so it is refused rather than displayed — the same reasoning
    that already rejects a token with no `decimals()` at all.
  */
  if (!isUsableDecimals(decimals)) {
    throw new TokenNotFoundError(
      `That token reports ${String(decimals)} decimals, beyond the ${String(MAX_TOKEN_DECIMALS)} Poolix can handle safely.`,
    );
  }

  const [rawSymbol, rawName] = await Promise.all([
    readTextField(client, address, "symbol"),
    readTextField(client, address, "name"),
  ]);

  /*
    A symbol made entirely of invisible characters sanitises to nothing, and the fallback
    below then shows the address. That is the right outcome: an invisible symbol tells the
    user nothing, and a truncated address at least identifies the contract they are about
    to trade against.
  */
  const symbol = sanitizeSymbol(rawSymbol);
  const name = sanitizeName(rawName);

  return {
    kind: "erc20",
    address,
    decimals,
    symbol: symbol ?? `${address.slice(0, 6)}…`,
    name: name ?? symbol ?? "Unknown Token",
  };
}
