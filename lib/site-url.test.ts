import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveSiteUrl } from "@/lib/site-url";

// A minimal ProcessEnv shim. Only the two keys we care about are ever read.
const env = (overrides: Record<string, string | undefined>): NodeJS.ProcessEnv =>
  overrides as NodeJS.ProcessEnv;

describe("resolveSiteUrl", () => {
  it("prefers a well-formed NEXT_PUBLIC_SITE_URL", () => {
    assert.equal(
      resolveSiteUrl(env({ NEXT_PUBLIC_SITE_URL: "https://poolix.app" })),
      "https://poolix.app",
    );
  });

  it("canonicalises the origin, dropping any path, query, or trailing slash", () => {
    assert.equal(
      resolveSiteUrl(env({ NEXT_PUBLIC_SITE_URL: "https://poolix.app/foo/?q=1" })),
      "https://poolix.app",
    );
  });

  it("treats an empty string as absent — the exact Vercel misconfiguration that crashed the build", () => {
    // The bug we are fixing: `?? "..."` did not fall back on "" and `new URL("")` threw.
    assert.equal(
      resolveSiteUrl(env({ NEXT_PUBLIC_SITE_URL: "", VERCEL_URL: undefined })),
      "http://localhost:3000",
    );
  });

  it("treats a whitespace-only value as absent", () => {
    assert.equal(
      resolveSiteUrl(env({ NEXT_PUBLIC_SITE_URL: "   \n" })),
      "http://localhost:3000",
    );
  });

  it("falls back to VERCEL_URL, prepending https:// when Vercel omits the scheme", () => {
    assert.equal(
      resolveSiteUrl(env({ VERCEL_URL: "poolix-abc.vercel.app" })),
      "https://poolix-abc.vercel.app",
    );
  });

  it("keeps an existing scheme on VERCEL_URL instead of double-prefixing", () => {
    // Some Vercel configurations expose a full URL. Prepending https:// again would
    // produce "https://https://…" which does not parse.
    assert.equal(
      resolveSiteUrl(env({ VERCEL_URL: "https://poolix-abc.vercel.app" })),
      "https://poolix-abc.vercel.app",
    );
  });

  it("prefers a valid NEXT_PUBLIC_SITE_URL over VERCEL_URL", () => {
    assert.equal(
      resolveSiteUrl(
        env({
          NEXT_PUBLIC_SITE_URL: "https://poolix.app",
          VERCEL_URL: "poolix-abc.vercel.app",
        }),
      ),
      "https://poolix.app",
    );
  });

  it("falls through to VERCEL_URL when NEXT_PUBLIC_SITE_URL is a bogus non-URL", () => {
    assert.equal(
      resolveSiteUrl(
        env({
          NEXT_PUBLIC_SITE_URL: "not a url",
          VERCEL_URL: "poolix-abc.vercel.app",
        }),
      ),
      "https://poolix-abc.vercel.app",
    );
  });

  it("refuses non-http(s) schemes on either variable", () => {
    // Defence in depth: an attacker who could inject an env value into a preview build
    // would still not get metadataBase pointing at a javascript: or data: URL.
    assert.equal(
      resolveSiteUrl(env({ NEXT_PUBLIC_SITE_URL: "javascript:alert(1)" })),
      "http://localhost:3000",
    );
    assert.equal(
      resolveSiteUrl(env({ NEXT_PUBLIC_SITE_URL: "data:text/html,<script>1</script>" })),
      "http://localhost:3000",
    );
    assert.equal(
      resolveSiteUrl(env({ VERCEL_URL: "javascript:alert(1)" })),
      "http://localhost:3000",
    );
  });

  it("returns http://localhost:3000 when nothing is set", () => {
    assert.equal(resolveSiteUrl(env({})), "http://localhost:3000");
  });

  it("always returns a value that new URL() accepts", () => {
    // The whole point of the helper: whatever it returns, the call site can trust.
    for (const value of [
      resolveSiteUrl(env({})),
      resolveSiteUrl(env({ NEXT_PUBLIC_SITE_URL: "" })),
      resolveSiteUrl(env({ NEXT_PUBLIC_SITE_URL: "https://poolix.app" })),
      resolveSiteUrl(env({ VERCEL_URL: "poolix-abc.vercel.app" })),
    ]) {
      assert.doesNotThrow(() => new URL(value));
    }
  });
});
