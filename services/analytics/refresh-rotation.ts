/*
  A round-robin cursor for background refreshes.

  Deliberately NOT marked `server-only`: it holds no secret, touches no filesystem and
  makes no request — it is a counter and an array index. Keeping it importable is what
  lets the rotation be tested directly rather than inferred from a page's behaviour.

  Several ingestion services need advancing, and running all of them in one `after()`
  callback takes well over a minute. Because `after` counts towards a prerender's budget,
  doing so made /analytics fail its build with "took more than 60 seconds" — the work had
  been moved off the render and straight into the next bottleneck.

  So each render advances exactly one service. With a short revalidate the whole set is
  refreshed within a couple of minutes, every callback is bounded, and no single response
  pays for all of them.

  It lives here rather than in the page module because a mutable module-level binding in a
  component file is exactly what the react-hooks lint rule exists to catch, and because a
  cursor is not page concern.

  The cursor holds no data and nothing is derived from it, so losing it on a restart simply
  begins the rotation again.
*/

const cursors = new Map<string, number>();

/**
 * Runs the next task in `tasks` for the given rotation, and advances the cursor.
 *
 * Failures are the caller's to handle: this reports which task ran so a caller can log it,
 * and does not swallow anything.
 */
export async function runNextRefresh(
  rotation: string,
  tasks: readonly (readonly [name: string, run: () => Promise<unknown>])[],
): Promise<string | null> {
  if (tasks.length === 0) return null;

  const index = (cursors.get(rotation) ?? 0) % tasks.length;
  cursors.set(rotation, index + 1);

  const task = tasks[index];
  if (task === undefined) return null;

  const [name, run] = task;
  await run();
  return name;
}

/** Test seam: forgets every cursor. */
export function resetRefreshRotation(): void {
  cursors.clear();
}
