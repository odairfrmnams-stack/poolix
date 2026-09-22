/*
  Dataset health. Pure: no I/O, no state.

  One vocabulary for "is this dataset any good right now", so the answer is the same
  wherever it is asked — a status page, a verifier, or a log line.

  The distinction the statuses exist to preserve is between a dataset that has no answer
  yet and one whose answer is wrong. "Bootstrapping" and "incomplete" are both honest
  states with nothing to publish; "stale" has something to publish but it is ageing;
  "failed" means the last attempt did not work. Collapsing these into a boolean is how a
  cold start gets reported as an outage, or an outage as a cold start.
*/

export type DatasetStatus =
  /** Published, current, and every invariant satisfied. */
  | "healthy"
  /** Building for the first time. Nothing published yet, and that is expected. */
  | "bootstrapping"
  /** Published, but the last successful run is older than the dataset tolerates. */
  | "stale"
  /** Running, but coverage is short of what publication requires. */
  | "incomplete"
  /** The last attempt failed. A previously published snapshot may still stand. */
  | "failed";

export interface DatasetHealth {
  readonly dataset: string;
  readonly status: DatasetStatus;
  /** Epoch ms of the last run that published, or null if none ever has. */
  readonly lastSuccessAt: number | null;
  /** Block the current data describes, where the dataset tracks one. */
  readonly sourceBlock: number | null;
  /** Units covered against units required, e.g. hourly buckets or confirmed tokens. */
  readonly coverage: { readonly present: number; readonly expected: number } | null;
  /** Safe to log: never carries a credential. */
  readonly lastError: string | null;
  readonly retries: number;
  /** True when the dataset currently has something publishable. */
  readonly publishable: boolean;
}

export interface HealthInput {
  readonly dataset: string;
  readonly hasPublished: boolean;
  readonly complete: boolean;
  readonly lastSuccessAt: number | null;
  readonly sourceBlock?: number | null;
  readonly coverage?: { present: number; expected: number } | null;
  readonly lastError?: string | null;
  readonly retries?: number;
  /** How old a published snapshot may be before it counts as stale. */
  readonly maxAgeMs: number;
  readonly now: number;
}

/**
 * Classifies a dataset.
 *
 * Order matters and is deliberate. A failure is reported even when a usable snapshot
 * remains, because "the last run failed" is the actionable fact — the stale snapshot is
 * the consolation, not the headline. Never having published outranks staleness, since a
 * dataset with nothing to show is not stale, it is still starting.
 */
export function classify(input: HealthInput): DatasetHealth {
  const coverage = input.coverage ?? null;
  const base = {
    dataset: input.dataset,
    lastSuccessAt: input.lastSuccessAt,
    sourceBlock: input.sourceBlock ?? null,
    coverage,
    lastError: input.lastError ?? null,
    retries: input.retries ?? 0,
  };

  if (input.lastError !== null && input.lastError !== undefined && input.lastError !== "") {
    return { ...base, status: "failed", publishable: input.hasPublished && input.complete };
  }
  if (!input.hasPublished) {
    return { ...base, status: "bootstrapping", publishable: false };
  }
  if (!input.complete) {
    return { ...base, status: "incomplete", publishable: false };
  }
  if (input.lastSuccessAt === null || input.now - input.lastSuccessAt > input.maxAgeMs) {
    // Still publishable: a stale figure that says it is stale beats no figure at all.
    return { ...base, status: "stale", publishable: true };
  }
  return { ...base, status: "healthy", publishable: true };
}

/**
 * The worst status across datasets, for a single overall answer.
 *
 * Worst rather than average, because a dashboard is only as trustworthy as its least
 * trustworthy input and averaging would let one broken dataset hide behind seven good ones.
 */
export function overall(datasets: readonly DatasetHealth[]): DatasetStatus {
  if (datasets.length === 0) return "bootstrapping";
  const order: readonly DatasetStatus[] = [
    "failed",
    "incomplete",
    "bootstrapping",
    "stale",
    "healthy",
  ];
  for (const status of order) {
    if (datasets.some((entry) => entry.status === status)) return status;
  }
  return "healthy";
}
