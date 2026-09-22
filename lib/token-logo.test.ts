import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  canonicaliseLogoUrl,
  normalizeAddressKey,
  resolveTokenLogo,
} from "@/lib/token-logo";

// The mainnet WETH address the resolver knows about. See config/chains.ts.
const WETH = "0x7943e237c7F95DA44E0301572D358911207852Fa";
const RANDO = "0x1111111111111111111111111111111111111111";
const RANDO_UPPER = "0x1111111111111111111111111111111111111111".toUpperCase();

describe("normalizeAddressKey", () => {
  it("lowercases the address so casing does not fork the identity", () => {
    assert.equal(normalizeAddressKey(RANDO_UPPER), RANDO);
    assert.equal(normalizeAddressKey(`  ${RANDO_UPPER}\n`), RANDO);
  });

  it("returns null for empty or missing input, never a sentinel", () => {
    assert.equal(normalizeAddressKey(null), null);
    assert.equal(normalizeAddressKey(undefined), null);
    assert.equal(normalizeAddressKey(""), null);
    assert.equal(normalizeAddressKey("   "), null);
  });
});

describe("canonicaliseLogoUrl", () => {
  it("keeps a well-formed https URL", () => {
    assert.equal(
      canonicaliseLogoUrl("https://example.com/token.png"),
      "https://example.com/token.png",
    );
  });

  it("rewrites ipfs://<cid>[/path] to a public gateway, preserving CID casing", () => {
    // CIDv0 is base58 with mixed casing, so lowercasing would corrupt it.
    const cidv0 = "QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco";
    assert.equal(
      canonicaliseLogoUrl(`ipfs://${cidv0}/logo.png`),
      `https://ipfs.io/ipfs/${cidv0}/logo.png`,
    );
  });

  it("refuses javascript:, data:, http:, blob: and file:", () => {
    assert.equal(canonicaliseLogoUrl("javascript:alert(1)"), null);
    assert.equal(canonicaliseLogoUrl("data:image/svg+xml,<svg/>"), null);
    assert.equal(canonicaliseLogoUrl("http://example.com/x.png"), null);
    assert.equal(canonicaliseLogoUrl("blob:https://example.com/abcd"), null);
    assert.equal(canonicaliseLogoUrl("file:///etc/passwd"), null);
  });

  it("refuses a URL containing markup-adjacent characters", () => {
    // Defence in depth: even if a URL parses, we reject anything that could smuggle
    // through as attribute-breaking text in a downstream renderer.
    assert.equal(
      canonicaliseLogoUrl(`https://example.com/"><script>alert(1)</script>`),
      null,
    );
  });

  it("returns null for non-strings, empty, or unparseable input", () => {
    assert.equal(canonicaliseLogoUrl(null), null);
    assert.equal(canonicaliseLogoUrl(undefined), null);
    assert.equal(canonicaliseLogoUrl(""), null);
    assert.equal(canonicaliseLogoUrl("   "), null);
    assert.equal(canonicaliseLogoUrl("not a url"), null);
  });
});

describe("resolveTokenLogo priority", () => {
  it("prefers Poolix's bundled logo for a known address, ignoring an incoming URL", () => {
    const result = resolveTokenLogo({
      address: WETH,
      symbol: "WETH",
      logoUrl: "https://elsewhere.example/weth.png",
    });
    assert.equal(result.kind, "url");
    // The bundled asset, not the caller's URL.
    assert.equal(result.kind === "url" ? result.src : null, "/tokens/weth.svg");
  });

  it("finds the bundled logo regardless of address casing", () => {
    const lower = resolveTokenLogo({ address: WETH.toLowerCase() });
    const upper = resolveTokenLogo({ address: WETH.toUpperCase() });
    assert.deepEqual(lower, upper);
  });

  it("uses a caller-supplied https URL when the token is not bundled", () => {
    const result = resolveTokenLogo({
      address: RANDO,
      symbol: "FOO",
      logoUrl: "https://example.com/foo.png",
    });
    assert.equal(result.kind, "url");
    assert.equal(result.kind === "url" ? result.src : null, "https://example.com/foo.png");
  });

  it("uses an ipfs:// URI, rewritten to a gateway", () => {
    const result = resolveTokenLogo({
      address: RANDO,
      logoUrl: "ipfs://QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco/logo.png",
    });
    assert.equal(result.kind, "url");
    assert.ok(
      (result.kind === "url" ? result.src : "").startsWith("https://ipfs.io/ipfs/Qm"),
    );
  });

  it("falls back to an identicon when no logo is available", () => {
    const result = resolveTokenLogo({ address: RANDO, symbol: "FOO", logoUrl: null });
    assert.equal(result.kind, "identicon");
    // Seed is always the lowercased address.
    assert.equal(result.kind === "identicon" ? result.seed : null, RANDO);
  });

  it("falls back to the identicon when the URL is rejected", () => {
    const bad = resolveTokenLogo({
      address: RANDO,
      logoUrl: "javascript:alert(1)",
    });
    assert.equal(bad.kind, "identicon");

    const alsoBad = resolveTokenLogo({
      address: RANDO,
      logoUrl: `<svg onload=alert(1)>`,
    });
    assert.equal(alsoBad.kind, "identicon");
  });

  it("uses a symbol initial only when there is no address at all", () => {
    const result = resolveTokenLogo({ symbol: "🚀moon" });
    assert.equal(result.kind, "initial");
    // First code point, uppercased. Rocket does not have an upper case, so it survives as-is.
    assert.equal(result.kind === "initial" ? result.char : null, "🚀");
  });

  it("produces a stable identicon for the same address across repeated calls", () => {
    const a = resolveTokenLogo({ address: RANDO });
    const b = resolveTokenLogo({ address: RANDO });
    assert.deepEqual(a, b);
  });

  it("treats duplicate addresses with different casing as the same token", () => {
    const lower = resolveTokenLogo({ address: RANDO });
    const upper = resolveTokenLogo({ address: RANDO_UPPER });
    assert.deepEqual(lower, upper);
  });
});
