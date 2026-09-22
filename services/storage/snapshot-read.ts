import "server-only";

/*
  Shared memo for read-only snapshot loads.

  These reads look cheap and are not. `readPublishedHolders` parses a 16 MB JSON file and
  `getPonsView` a 3.6 MB one, and neither had a single-flight guard — so five concurrent
  requests did the work five times. Measured: 4.3x and 5.1x the single-call cost, which is
  the shape of duplicated work rather than shared work.

  WHY THIS IS SAFE FOR FRESHNESS. A snapshot on disk does not change between the tick that
  wrote it and the tick that writes the next one, so re-reading it inside a few seconds can
  only return the same bytes. This memo therefore changes no figure and no publication
  rule: it removes repeated parsing of an unchanged file. It is deliberately NOT used for
  anything that ticks — a function that does network work and advances a checkpoint keeps
  its own refresh policy, because memoising one of those would change what "fresh" means.

  The TTL is short on purpose. It exists to collapse the reads of a single render and the
  requests arriving together, not to hold data across a tick.
*/

interface Entry<T> {
  readonly at: number;
  readonly value: T;
}

interface Slot<T> {
  cached: Entry<T> | null;
  inFlight: Promise<T> | null;
}

/**
 * Wraps a read-only loader so concurrent callers share one read and repeat callers within
 * `ttlMs` share its result.
 *
 * Returns a function with the same signature, so a call site does not change.
 */
export function memoizeSnapshotRead<T>(load: () => Promise<T>, ttlMs: number): () => Promise<T> {
  const slot: Slot<T> = { cached: null, inFlight: null };

  return async function read(): Promise<T> {
    const now = Date.now();
    if (slot.cached !== null && now - slot.cached.at < ttlMs) return slot.cached.value;
    // Someone is already reading the same file; join them instead of opening it again.
    if (slot.inFlight !== null) return slot.inFlight;

    slot.inFlight = load()
      .then((value) => {
        slot.cached = { at: Date.now(), value };
        return value;
      })
      .finally(() => {
        slot.inFlight = null;
      });

    return slot.inFlight;
  };
}

/*
  CALL THIS FROM INSIDE A FUNCTION, NOT AT MODULE TOP LEVEL.

  These analytics modules import each other — liquidity-history needs history-window's
  bucket ranges, apr-window needs liquidity-history, pool-history needs both — and in an ES
  module cycle a top-level `const x = importedFn(...)` can execute before `importedFn` is
  initialised. It did: /analytics returned a 500 with "memoizeSnapshotRead is not defined".

  So every caller holds a `let memo = null` and builds the reader on first use:

      let memo: (() => Promise<T>) | null = null;
      export async function readThing(): Promise<T> {
        memo ??= memoizeSnapshotRead(loadThing, SNAPSHOT_TTL_MS);
        return memo();
      }

  A bare `null` initialiser and a hoisted function declaration are both safe inside a
  cycle, and the memo is built once, on the first call, when every module has loaded.
*/

/**
 * How long a snapshot read may be reused.
 *
 * Long enough to cover one render and a burst of simultaneous requests; far shorter than
 * any tick interval, so a freshly written snapshot is picked up on the next request rather
 * than being held back.
 */
export const SNAPSHOT_TTL_MS = 5_000;
