import { redact } from "@/services/storage/keys";

/*
  Structured logging for analytics workers.

  The questions a log has to answer after an incident are fixed: which dataset ran, why,
  over what range, from what source, how many events arrived, how many were kept, what
  checkpoint went in and what came out, how long it took, and whether it published — and if
  not, why not. Encoding those as fields rather than prose means they can be read back
  without parsing English.

  Every value passes through `redact` on the way out. Not at the call sites that look
  risky — at the boundary, unconditionally, because a redaction someone must remember is
  one that eventually is not applied. An error carrying an Authorization header is the
  realistic leak, and it never reaches the console.
*/

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface WorkerLog {
  readonly dataset: string;
  /** Why this ran: a scheduled tick, a cold start, a retry. */
  readonly reason?: string;
  readonly fromBlock?: number;
  readonly toBlock?: number;
  readonly source?: string;
  readonly received?: number;
  readonly accepted?: number;
  readonly discarded?: number;
  readonly checkpointIn?: number | string | null;
  readonly checkpointOut?: number | string | null;
  readonly durationMs?: number;
  readonly published?: boolean;
  /** Required whenever `published` is false, so an absence is always explained. */
  readonly withheldBecause?: string;
  readonly error?: string;
  readonly [key: string]: unknown;
}

/** Off by default: analytics ticks are frequent and this is diagnostic, not operational. */
const enabled = () => process.env.POOLIX_LOG === "1" || process.env.NODE_ENV === "development";

/**
 * Renders a record as `key=value` pairs, redacted.
 *
 * Exported so the redaction can be tested directly rather than through console capture —
 * the property that matters is that no secret survives this function.
 */
export function formatLog(level: LogLevel, event: WorkerLog): string {
  const parts: string[] = [`level=${level}`];
  for (const [key, value] of Object.entries(event)) {
    if (value === undefined) continue;
    const rendered = typeof value === "string" ? value : JSON.stringify(value);
    // Quote anything containing whitespace so the pairs stay parseable.
    const safe = redact(String(rendered));
    parts.push(/\s/.test(safe) ? `${key}="${safe.replace(/"/g, "'")}"` : `${key}=${safe}`);
  }
  return parts.join(" ");
}

function emit(level: LogLevel, event: WorkerLog): void {
  if (level !== "error" && level !== "warn" && !enabled()) return;
  const line = formatLog(level, event);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const workerLog = {
  debug: (event: WorkerLog) => emit("debug", event),
  info: (event: WorkerLog) => emit("info", event),
  warn: (event: WorkerLog) => emit("warn", event),
  error: (event: WorkerLog) => emit("error", event),
};
