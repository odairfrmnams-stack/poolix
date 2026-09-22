import "server-only";

/*
  Shared HyperSync transport: one request helper, one paged log reader, one backoff.

  The three existing windows each grew their own copy of this loop as they were built.
  Rather than add a fourth for per-pool analytics, the transport lives here. Only the
  transport is shared — every module keeps its own aggregation, because the methodology
  differences between them are deliberate.

  A 429 is waited out rather than treated as failure: the free tier rate-limits bursts,
  so a refused request is an ordinary event. Anything else returns null, which callers
  read as "this range is not complete" and therefore never persist.

  The API token is read from the environment and never logged.
*/

export const HYPERSYNC_URL = "https://4663.hypersync.xyz/query";
export const HYPERSYNC_HEIGHT_URL = "https://4663.hypersync.xyz/height";

const BACKOFF_MS = [1_000, 2_500, 6_000, 12_000];

/*
  Every request is bounded.

  Node's fetch never times out on its own, so a stalled connection would hold a tick open
  past its deadline — the deadline is only checked between pages, so it cannot interrupt a
  request already in flight. A query page is generous because a wide range legitimately
  takes time; the height probe is not, because it is one small number.
*/
const QUERY_TIMEOUT_MS = 45_000;
const HEIGHT_TIMEOUT_MS = 10_000;

const token = () => process.env.ENVIO_API_TOKEN?.trim() ?? "";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function hasHyperSyncToken(): boolean {
  return token() !== "";
}

/** One request, backing off on rate limiting. Null means the caller must not persist. */
export async function hyperSyncPost(body: unknown): Promise<Record<string, unknown> | null> {
  for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {
    try {
      const res = await fetch(HYPERSYNC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token()}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
      });

      if (res.status === 429 || res.status === 503) {
        const wait = BACKOFF_MS[attempt];
        if (wait === undefined) return null;
        await sleep(wait);
        continue;
      }
      if (!res.ok) return null;
      return (await res.json()) as Record<string, unknown>;
    } catch {
      const wait = BACKOFF_MS[attempt];
      if (wait === undefined) return null;
      await sleep(wait);
    }
  }
  return null;
}

export async function fetchHyperSyncHeight(): Promise<number | null> {
  try {
    const res = await fetch(HYPERSYNC_HEIGHT_URL, {
      next: { revalidate: 30 },
      signal: AbortSignal.timeout(HEIGHT_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { height?: number };
    return typeof json.height === "number" ? json.height : null;
  } catch {
    return null;
  }
}

export interface PagedLogQuery {
  readonly fromBlock: number;
  readonly toBlock: number;
  /** Restricting by address is what makes a whole-history read affordable. */
  readonly addresses?: readonly string[];
  readonly topic0?: readonly string[];
  /**
   * Full positional topic filter, when matching on an indexed argument rather than just
   * the event signature. Position 0 is the signature, 1..3 the indexed arguments; an
   * empty array at a position matches anything there.
   *
   * Filtering server-side on an indexed argument is the difference between one narrow
   * lookup and sweeping every event a contract has ever emitted.
   */
  readonly topics?: readonly (readonly string[])[];
  readonly fields: readonly string[];
  readonly deadline: number;
}

export interface PagedLogResult<T> {
  readonly logs: T[];
  /** False when the range was not fully read; the caller must discard rather than store. */
  readonly complete: boolean;
  readonly reached: number;
}

/**
 * Reads every matching log in a block range, following HyperSync's `next_block` cursor.
 *
 * Stops at the deadline and reports it, because a partial read that looks complete is the
 * one failure mode that silently under-reports and never repairs itself.
 */
export async function fetchLogsPaged<T>(query: PagedLogQuery): Promise<PagedLogResult<T>> {
  const logs: T[] = [];
  let cursor = query.fromBlock;

  while (cursor < query.toBlock) {
    if (Date.now() >= query.deadline) return { logs, complete: false, reached: cursor };

    const filter: Record<string, unknown> = {};
    if (query.addresses !== undefined) filter.address = [...query.addresses];
    if (query.topics !== undefined) filter.topics = query.topics.map((position) => [...position]);
    else if (query.topic0 !== undefined) filter.topics = [[...query.topic0]];

    const json = await hyperSyncPost({
      from_block: cursor,
      to_block: query.toBlock,
      logs: [filter],
      field_selection: { log: [...query.fields] },
    });
    if (json === null) return { logs, complete: false, reached: cursor };

    const batches = (json.data ?? []) as { logs?: T[] }[];
    for (const batch of batches) logs.push(...(batch.logs ?? []));

    const next = (json.next_block as number | undefined) ?? query.toBlock;
    if (next <= cursor) return { logs, complete: false, reached: cursor };
    cursor = Math.min(next, query.toBlock);
  }

  return { logs, complete: true, reached: cursor };
}
