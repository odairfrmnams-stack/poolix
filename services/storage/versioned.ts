/*
  Schema versioning for persisted analytics state. Pure: no I/O, no state.

  Every dataset on disk carries `version` and `chainId` inside its own payload — a shape
  that predates this module and is deliberately preserved, because changing it would make
  every existing cache unreadable and force a rebuild measured in hours.

  What this module adds is one implementation of the decision those fields exist for, so
  eight modules stop each having their own. The rule it enforces:

    an unreadable or incompatible cache is DISCARDED, never reinterpreted.

  That direction matters. These datasets are derived — every one can be rebuilt from
  HyperSync and the chain — so throwing a doubtful cache away costs time, while reading an
  old schema as if it were the current one costs correctness, silently, in a number someone
  will act on. Fail closed, rebuild, and say so.
*/

/** Why a load did not return usable state. Surfaced for logging, never swallowed. */
export type LoadOutcome =
  | "ok"
  /** Nothing stored yet. The ordinary first-run case, not a fault. */
  | "missing"
  /** Present but not parseable as JSON, or not an object. */
  | "corrupt"
  /** Readable, but written by a different schema version. */
  | "version-mismatch"
  /** Readable, but belongs to another chain. */
  | "chain-mismatch"
  /** Readable and current, but missing fields the caller requires. */
  | "invalid";

export interface LoadResult<T> {
  readonly outcome: LoadOutcome;
  /** The state when `outcome` is "ok", and null in every other case. */
  readonly value: T | null;
  /** Human-readable reason, safe to log. */
  readonly detail: string;
}

export interface VersionedSpec<T> {
  readonly dataset: string;
  readonly version: number;
  readonly chainId: number;
  /**
   * Checks the fields this dataset cannot function without.
   *
   * Returning false discards the state. Keep it to structural invariants — a field that is
   * merely empty is usually a legitimate cold start, not corruption.
   */
  readonly validate: (value: unknown) => value is T;
  /**
   * Optional upgrade from an older version.
   *
   * Must be deterministic and must return null when it cannot faithfully upgrade, which
   * discards rather than guesses. A migration that fills in a plausible value is how an
   * invented number enters a system that is otherwise careful about them.
   */
  readonly migrate?: (value: unknown, fromVersion: number) => T | null;
}

interface Header {
  readonly version?: unknown;
  readonly chainId?: unknown;
}

/**
 * Interprets raw stored JSON against a dataset's schema.
 *
 * Takes the already-parsed value (or null when absent) so the decision is pure and
 * testable; the caller owns reading and parsing.
 */
export function interpret<T>(raw: unknown, spec: VersionedSpec<T>): LoadResult<T> {
  if (raw === null || raw === undefined) {
    return { outcome: "missing", value: null, detail: `${spec.dataset}: nothing stored` };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { outcome: "corrupt", value: null, detail: `${spec.dataset}: not a JSON object` };
  }

  const header = raw as Header;

  if (typeof header.chainId === "number" && header.chainId !== spec.chainId) {
    return {
      outcome: "chain-mismatch",
      value: null,
      detail: `${spec.dataset}: stored for chain ${header.chainId}, running ${spec.chainId}`,
    };
  }

  const storedVersion = header.version;
  if (typeof storedVersion !== "number" || !Number.isSafeInteger(storedVersion)) {
    return { outcome: "corrupt", value: null, detail: `${spec.dataset}: no usable version field` };
  }

  if (storedVersion !== spec.version) {
    /*
      A newer version is never migrated down. It was written by code that knew more than
      this build does, and guessing at its meaning is exactly the reinterpretation this
      module exists to prevent.
    */
    if (storedVersion > spec.version) {
      return {
        outcome: "version-mismatch",
        value: null,
        detail: `${spec.dataset}: stored v${storedVersion} is newer than v${spec.version}; discarding`,
      };
    }

    const migrated = spec.migrate?.(raw, storedVersion) ?? null;
    if (migrated === null) {
      return {
        outcome: "version-mismatch",
        value: null,
        detail: `${spec.dataset}: stored v${storedVersion}, expected v${spec.version}; rebuilding`,
      };
    }
    if (!spec.validate(migrated)) {
      return {
        outcome: "invalid",
        value: null,
        detail: `${spec.dataset}: migration from v${storedVersion} produced invalid state`,
      };
    }
    return {
      outcome: "ok",
      value: migrated,
      detail: `${spec.dataset}: migrated v${storedVersion} -> v${spec.version}`,
    };
  }

  if (!spec.validate(raw)) {
    return { outcome: "invalid", value: null, detail: `${spec.dataset}: failed validation` };
  }

  return { outcome: "ok", value: raw, detail: `${spec.dataset}: v${spec.version}` };
}

/** True when the outcome means "there is nothing usable, rebuild from source". */
export function needsRebuild(outcome: LoadOutcome): boolean {
  return outcome !== "ok";
}

/**
 * Stamps state with its schema identity before writing.
 *
 * Always applied by the storage layer rather than by callers, so a dataset cannot be
 * written without the fields that let the next reader judge it.
 */
export function stamp<T extends object>(value: T, spec: { version: number; chainId: number }): T {
  return { ...value, version: spec.version, chainId: spec.chainId };
}
