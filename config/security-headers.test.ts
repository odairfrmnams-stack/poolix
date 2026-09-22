import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { contentSecurityPolicy, originOf, securityHeaders } from "@/config/security-headers";

const RPC = "https://robinhood-rpc.publicnode.com";

const production = { connectOrigins: [RPC], production: true };
const development = { connectOrigins: [RPC], production: false };

function directive(policy: string, name: string): string | null {
  const found = policy
    .split(";")
    .map((part) => part.trim())
    .find((part) => part === name || part.startsWith(`${name} `));
  return found ?? null;
}

function headerValue(options: typeof production, key: string): string | undefined {
  return securityHeaders(options).find((header) => header.key === key)?.value;
}

describe("originOf", () => {
  it("reduces a URL to its origin", () => {
    assert.equal(originOf("https://example.com/rpc?key=abc"), "https://example.com");
    assert.equal(originOf("https://example.com:8545/"), "https://example.com:8545");
  });

  it("returns null rather than throwing on unusable input", () => {
    assert.equal(originOf(undefined), null);
    assert.equal(originOf(""), null);
    assert.equal(originOf("   "), null);
    assert.equal(originOf("not a url"), null);
  });
});

describe("contentSecurityPolicy", () => {
  it("defaults to self", () => {
    assert.equal(directive(contentSecurityPolicy(production), "default-src"), "default-src 'self'");
  });

  it("never allows unsafe-eval in production, which is what turns an injected string into code", () => {
    assert.ok(!contentSecurityPolicy(production).includes("unsafe-eval"));
  });

  it("allows unsafe-eval in development only, because React's dev build requires it", () => {
    /*
      Verified in a browser, not assumed: with unsafe-eval withheld, the dev server logs
      "eval() is not supported in this environment" and React refuses to render. React's
      own message states it never uses eval in production, so this grant does not ship.
    */
    assert.ok(contentSecurityPolicy(development).includes("'unsafe-eval'"));
  });

  it("forbids framing, plugins and embedded documents outright", () => {
    const policy = contentSecurityPolicy(production);
    assert.equal(directive(policy, "frame-ancestors"), "frame-ancestors 'none'");
    assert.equal(directive(policy, "object-src"), "object-src 'none'");
    assert.equal(directive(policy, "frame-src"), "frame-src 'none'");
  });

  it("pins base-uri and form-action, so one injected tag cannot redirect the page", () => {
    const policy = contentSecurityPolicy(production);
    assert.equal(directive(policy, "base-uri"), "base-uri 'self'");
    assert.equal(directive(policy, "form-action"), "form-action 'self'");
  });

  it("allows the RPC endpoint the browser genuinely contacts", () => {
    const connect = directive(contentSecurityPolicy(production), "connect-src");
    assert.ok(connect?.includes("'self'"));
    assert.ok(connect?.includes(RPC));
  });

  it("does not allow HyperSync from the browser", () => {
    // HyperSync is contacted only from the server, with a server-only token. Listing it
    // here would grant the browser a permission it has no use for.
    assert.ok(!contentSecurityPolicy(production).includes("hypersync"));
  });

  it("keeps fonts and images same-origin", () => {
    const policy = contentSecurityPolicy(production);
    // next/font self-hosts, so no external font origin is needed.
    assert.equal(directive(policy, "font-src"), "font-src 'self'");
    assert.equal(directive(policy, "img-src"), "img-src 'self' data:");
  });

  it("de-duplicates repeated connect origins", () => {
    const policy = contentSecurityPolicy({ connectOrigins: [RPC, RPC, RPC], production: true });
    const connect = directive(policy, "connect-src") ?? "";
    assert.equal(connect.split(RPC).length - 1, 1);
  });

  it("upgrades insecure requests in production only", () => {
    assert.ok(contentSecurityPolicy(production).includes("upgrade-insecure-requests"));
    // In development the site is http on localhost; upgrading would break it.
    assert.ok(!contentSecurityPolicy(development).includes("upgrade-insecure-requests"));
  });
});

describe("securityHeaders", () => {
  it("sets nosniff", () => {
    assert.equal(headerValue(production, "X-Content-Type-Options"), "nosniff");
  });

  it("does not leak the full URL to external origins", () => {
    // Poolix URLs carry wallet and contract addresses, and the footer links to an explorer.
    assert.equal(headerValue(production, "Referrer-Policy"), "strict-origin-when-cross-origin");
  });

  it("denies framing through the legacy header too", () => {
    assert.equal(headerValue(production, "X-Frame-Options"), "DENY");
  });

  it("refuses the powerful features Poolix never uses", () => {
    const policy = headerValue(production, "Permissions-Policy") ?? "";
    for (const feature of ["camera", "microphone", "geolocation", "payment", "usb"]) {
      assert.ok(policy.includes(`${feature}=()`), `${feature} should be disabled`);
    }
  });

  it("sends HSTS in production and never in development", () => {
    const hsts = headerValue(production, "Strict-Transport-Security");
    assert.ok(hsts?.includes("max-age=63072000"));
    assert.ok(hsts?.includes("includeSubDomains"));
    // Sending HSTS from a localhost dev server pins http://localhost to https in the
    // developer's browser, which then refuses to load the dev server at all.
    assert.equal(headerValue(development, "Strict-Transport-Security"), undefined);
  });

  it("always includes a CSP", () => {
    assert.ok((headerValue(production, "Content-Security-Policy") ?? "").length > 0);
    assert.ok((headerValue(development, "Content-Security-Policy") ?? "").length > 0);
  });

  it("emits no duplicate header keys", () => {
    const keys = securityHeaders(production).map((header) => header.key);
    assert.equal(new Set(keys).size, keys.length);
  });
});
