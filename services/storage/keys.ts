/*
  Dataset keys and secret redaction. Pure: no I/O, no state.

  A storage key eventually becomes a filename, so it is the one place where a value could
  escape the cache directory. Rather than sanitising — which invites an encoding nobody
  anticipated — keys are drawn from a closed allowlist of characters and rejected outright
  otherwise. Nothing user-supplied is ever a key: every caller passes a literal dataset
  name plus the configured chain id.
*/

/** Lowercase letters, digits and single separators. Deliberately narrow. */
const KEY_PATTERN = /^[a-z0-9]+(?:[-.][a-z0-9]+)*$/;
const MAX_KEY_LENGTH = 128;

export class InvalidKeyError extends Error {
  override readonly name = "InvalidKeyError";
}

/**
 * Whether a string is a usable storage key.
 *
 * Rejects anything containing a path separator, a parent reference, a drive letter, a null
 * byte or leading/trailing separators — the shapes that turn a key into a path.
 */
export function isValidKey(key: string): boolean {
  if (typeof key !== "string") return false;
  if (key.length === 0 || key.length > MAX_KEY_LENGTH) return false;
  if (key.includes("..") || key.includes("/") || key.includes("\\") || key.includes("\0")) {
    return false;
  }
  return KEY_PATTERN.test(key);
}

/** The same check, as a guard that throws. Callers use this before touching a filesystem. */
export function assertKey(key: string): string {
  if (!isValidKey(key)) {
    // The key itself is echoed because every key is a literal from this codebase, never
    // user input — so this cannot reflect an attacker's string back into a log.
    throw new InvalidKeyError(`"${String(key).slice(0, 64)}" is not a valid storage key`);
  }
  return key;
}

/**
 * The key for a per-chain dataset, e.g. `holders-4663`.
 *
 * The hyphen is load-bearing: the filesystem backend stores `<key>.json`, so this spells
 * the exact filenames the analytics modules have always written. Changing the separator
 * would leave every existing cache unreadable and force a rebuild measured in hours, for
 * no benefit.
 */
export function datasetKey(dataset: string, chainId: number): string {
  if (!Number.isSafeInteger(chainId) || chainId < 0) {
    throw new InvalidKeyError(`chain id ${String(chainId)} is not usable in a key`);
  }
  return assertKey(`${dataset}-${chainId}`);
}

// ------------------------------------------------------------------ redaction

/*
  Patterns that must never reach a log.

  Matching on shape rather than on variable name, because the value is what leaks — a token
  pasted into an error message does not carry the name of the variable it came from.
*/
const SECRET_PATTERNS: readonly { readonly pattern: RegExp; readonly label: string }[] = [
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi, label: "[redacted bearer]" },
  // A 64-hex string is a private key; 0x-prefixed or not.
  { pattern: /\b(0x)?[0-9a-fA-F]{64}\b/g, label: "[redacted 32-byte hex]" },
  // Envio tokens and similar opaque credentials.
  { pattern: /\b[A-Za-z0-9]{8,}-[A-Za-z0-9]{4,}-[A-Za-z0-9]{4,}-[A-Za-z0-9]{4,}-[A-Za-z0-9]{8,}\b/g, label: "[redacted uuid]" },
];

/**
 * Removes anything that looks like a credential from a string.
 *
 * Applied to every log line rather than at the call sites that seem risky. A redaction
 * someone has to remember to apply is one that eventually is not applied, and the cost of
 * over-redacting a log is a hex string nobody could read anyway.
 *
 * Also scrubs the value of any environment variable whose name suggests a secret, so a
 * token printed by accident is caught even when its shape is unremarkable.
 */
export function redact(input: string, env: Readonly<Record<string, string | undefined>> = process.env): string {
  let output = String(input);

  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== "string" || value.length < 8) continue;
    if (!/TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|PRIVATE/i.test(name)) continue;
    /*
      split/join, not a replace loop.

      The obvious `while (output.includes(value)) output = output.replace(value, label)`
      does not terminate when the value is a substring of its own label — an env var named
      SECRET_KEY_VALUE_THING holding "KEY_VALUE" produces "[redacted SECRET_KEY_VALUE_THING]",
      which still contains "KEY_VALUE", so the condition is true forever. That is an
      infinite loop on the logging path, reached by every worker warning.

      split/join replaces every occurrence in one pass and never re-examines what it wrote.
      It is also a literal match, which matters because a secret may contain regex
      metacharacters.
    */
    output = output.split(value).join(`[redacted ${name}]`);
  }

  for (const { pattern, label } of SECRET_PATTERNS) {
    output = output.replace(pattern, label);
  }
  return output;
}
