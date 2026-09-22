/*
  Leases: bounded, self-expiring exclusion for expensive analytics work. Pure decision
  logic here; the storage round-trip lives in lease-store.ts.

  WHAT PROBLEM. Two requests arriving together both find a cache cold and both start the
  same bootstrap. In one process `inFlight` already collapses that, but across processes —
  two serverless instances, or a page render beside a worker — nothing does. The cost is
  duplicated expensive work against a rate-limited endpoint, which makes both copies slower
  and can push each past its own budget.

  WHAT THIS IS NOT. It is not a correctness mechanism. Writes are already atomic, and every
  dataset's publication rule already refuses to publish incomplete state, so a lost race
  wastes effort rather than corrupting anything. Treating a lease as a guarantee would be a
  mistake on a filesystem, where acquisition cannot be made atomic against a concurrent
  acquirer.

  WHY A LEASE AND NOT A LOCK. A held lock whose holder crashed is worse than no lock: the
  dataset stops updating and nothing recovers it. A lease expires. The holder renews while
  it works, and if it dies the lease lapses and the next caller proceeds. There is no state
  in which a crash blocks the work permanently.
*/

export interface Lease {
  /** Identifies the holder. A process/attempt id, never a credential. */
  readonly owner: string;
  /** Epoch milliseconds after which the lease is void, held or not. */
  readonly expiresAt: number;
  readonly dataset: string;
  readonly acquiredAt: number;
}

/** How long a lease is granted for. Long enough for a tick, short enough to recover fast. */
export const LEASE_TTL_MS = 60_000;

export type LeaseDecision =
  /** No lease recorded: take it. */
  | "free"
  /** Held by someone else and still valid: stand down. */
  | "held"
  /** Recorded but past its expiry: the previous holder is gone, take it. */
  | "expired"
  /** Already ours: renew rather than contend with ourselves. */
  | "own";

/**
 * Whether `owner` may take the lease, given what is recorded.
 *
 * Expiry is judged against the caller's clock. Two machines with skewed clocks can both
 * believe a lease is free, which is precisely why this is an optimisation and not a
 * correctness guarantee — and why the TTL is generous relative to plausible skew.
 */
export function evaluate(existing: Lease | null, owner: string, now: number): LeaseDecision {
  if (existing === null) return "free";
  if (existing.owner === owner) return "own";
  if (now >= existing.expiresAt) return "expired";
  return "held";
}

export function canAcquire(decision: LeaseDecision): boolean {
  return decision !== "held";
}

/** A fresh lease for `owner`, expiring `ttlMs` from now. */
export function grant(dataset: string, owner: string, now: number, ttlMs = LEASE_TTL_MS): Lease {
  return { dataset, owner, acquiredAt: now, expiresAt: now + Math.max(1, ttlMs) };
}

/**
 * Extends a lease the caller still holds.
 *
 * Returns null when the lease is no longer ours — it expired and someone else took it — so
 * a long-running job discovers it has lost exclusivity instead of renewing a lease that
 * now belongs to another worker.
 */
export function renew(existing: Lease | null, owner: string, now: number, ttlMs = LEASE_TTL_MS): Lease | null {
  if (existing === null) return grant("", owner, now, ttlMs);
  if (existing.owner !== owner) return null;
  return { ...existing, expiresAt: now + Math.max(1, ttlMs) };
}

/** True when a recorded lease has lapsed and may be reclaimed. */
export function isExpired(lease: Lease | null, now: number): boolean {
  return lease !== null && now >= lease.expiresAt;
}

/** Structural check for a value read back from storage. */
export function isLease(value: unknown): value is Lease {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<Lease>;
  return (
    typeof candidate.owner === "string" &&
    typeof candidate.dataset === "string" &&
    typeof candidate.expiresAt === "number" &&
    typeof candidate.acquiredAt === "number" &&
    Number.isFinite(candidate.expiresAt)
  );
}
