/*
  Resolves the absolute origin Poolix's Metadata should treat as canonical.

  The failure mode we are guarding against is `new URL("")`, which throws
  `TypeError: Invalid URL` and crashes the Vercel production build. That happens
  whenever `NEXT_PUBLIC_SITE_URL` is *defined but blank* — the `??` fallback the
  layout used to rely on only fires on `null`/`undefined`, not on `""`.

  Priority, in order:
    1. `NEXT_PUBLIC_SITE_URL`, if it parses as an http(s) absolute URL.
    2. `VERCEL_URL`, prefixed with `https://` if it has no scheme, if it parses.
       Vercel exposes the deploy's hostname without a scheme, so we add one.
    3. `http://localhost:3000` for local dev.

  We intentionally accept only `http:` and `https:`. Anything else (a stray
  `javascript:` or `data:` from a misconfigured env, an unparseable value like a
  bare word, or an empty string) is treated as absent and we move to the next
  tier. Nothing here ever calls `new URL()` on an empty string, and the returned
  value always parses.
*/

const LOCALHOST = "http://localhost:3000";

function trimOrNull(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function acceptHttp(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  // Canonicalise to the origin, without a trailing slash on the pathname. Extra
  // path/search/hash on `metadataBase` would compose oddly with per-route
  // `openGraph.images` paths, so we drop them.
  return parsed.origin;
}

/**
 * Returns an absolute origin suitable for `new URL(...)`. Never throws, never
 * returns an empty string. Callers can safely wrap the result in `new URL()`.
 *
 * The `env` argument is a seam for tests — production callers pass nothing and
 * get `process.env`.
 */
export function resolveSiteUrl(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = trimOrNull(env.NEXT_PUBLIC_SITE_URL);
  if (explicit !== null) {
    const validated = acceptHttp(explicit);
    if (validated !== null) return validated;
  }

  const vercel = trimOrNull(env.VERCEL_URL);
  if (vercel !== null) {
    const withScheme = /^https?:\/\//i.test(vercel) ? vercel : `https://${vercel}`;
    const validated = acceptHttp(withScheme);
    if (validated !== null) return validated;
  }

  return LOCALHOST;
}
