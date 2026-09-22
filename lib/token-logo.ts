/*
  Resolves a token's logo source.

  Priority, in order:
    1. Poolix's own bundled logos. WETH is the only address Poolix knows firsthand — the
       one it verifies onchain — so its logo is a static asset served from `/public`
       rather than a remote URL. This is the only path that can never fail.
    2. A caller-supplied logo URL, from Pons metadata or a future token list. This is
       treated as untrusted input: the protocol must be `https:` or `ipfs:`, the parsed
       URL must round-trip cleanly, and inline `data:`/`javascript:`/`blob:` schemes are
       refused. An `ipfs://` URI is rewritten to a public gateway.
    3. A deterministic identicon derived from the address. Same address, same picture,
       forever — see lib/identicon.ts.
    4. The badge label from lib/token-text.ts (up to three code points). Only reached
       when neither an address nor a symbol was supplied, so in practice never.

  There is no "trusted token-list metadata" tier because Poolix ships no such list on
  Robinhood Chain by design (see lib/token-storage.ts). If one is added later the tier
  slots in between (2) and (3) without touching callers, because the resolver returns a
  discriminated union rather than a string.

  This module is pure and free of React, so it can be imported by tests and by both
  server and client components.
*/

/*
  Well-known token logos shipped with Poolix, keyed by lowercase address.

  Both Robinhood Chain networks are listed so the same asset renders the same way in dev
  (testnet) and in production (mainnet). See config/chains.ts for where each address
  comes from — it is verified onchain by npm run verify:chain, so treating the address
  as a stable key is safe.
*/
const KNOWN_LOGO_BY_ADDRESS: Record<string, string> = {
  // WETH mainnet
  "0x7943e237c7f95da44e0301572d358911207852fa": "/tokens/weth.svg",
  // WETH testnet
  "0x0bd7d308f8e1639fab988df18a8011f41eacad73": "/tokens/weth.svg",
};

/**
 * Public IPFS gateways Poolix will rewrite `ipfs://` URIs to. The list is intentionally
 * short and picks operators with strong uptime records. The first is tried; if the image
 * 404s the component falls all the way through to the identicon rather than trying the
 * next gateway, because we do not want to leak the same request to multiple third parties.
 */
const IPFS_GATEWAY = "https://ipfs.io/ipfs/";

export type TokenLogoSource =
  | { readonly kind: "url"; readonly src: string }
  | { readonly kind: "identicon"; readonly seed: string }
  | { readonly kind: "initial"; readonly char: string };

export interface TokenLogoInput {
  /** Lowercased or checksummed; both work. Null for the native currency. */
  readonly address?: string | null;
  /** Display symbol used only for the letter-initial final fallback. */
  readonly symbol?: string | null;
  /** Caller-supplied logo URL (from Pons metadata or similar). Untrusted. */
  readonly logoUrl?: string | null;
}

/**
 * Case-insensitive normalisation of an address for KNOWN_LOGO_BY_ADDRESS lookups and
 * for identicon seeds. Two references to the same account must map to the same picture
 * regardless of casing.
 */
export function normalizeAddressKey(address: string | null | undefined): string | null {
  if (typeof address !== "string") return null;
  const trimmed = address.trim();
  if (trimmed === "") return null;
  return trimmed.toLowerCase();
}

/**
 * Whether a URL is one Poolix is willing to render into an `<img>`.
 *
 * The rules are deliberately narrow: only `https:` and `ipfs:` (or `ipns:`) survive.
 * A `data:` URL is rejected outright — even for an SVG — because SVG can contain
 * `<script>` and `<foreignObject>` and rendering it via `<img>` still exposes the
 * page to layout tricks in some browsers, and because the browser cache boundary
 * for data URLs is the page itself, which we would rather keep clean. `http:` is
 * rejected because Poolix runs under an HTTPS CSP and a mixed-content image on a
 * DEX interface would break the visual guarantee that the whole page is secured.
 * `javascript:`, `file:`, `blob:` and everything else fall out for the same reason.
 */
function isAllowedProtocol(url: URL): boolean {
  return url.protocol === "https:" || url.protocol === "ipfs:" || url.protocol === "ipns:";
}

/**
 * Parses and canonicalises a caller-supplied logo URL, or returns null. Never throws.
 *
 * `ipfs://<cid>[/path]` is rewritten to `${IPFS_GATEWAY}<cid>[/path]`. The URL
 * constructor accepts `ipfs://` as a scheme but treats the CID as the host, which
 * `URL.href` then serves back lowercased — CIDv0 (Qm…) is case-sensitive, so the
 * rewrite has to work off the original string, not the parsed URL.
 */
export function canonicaliseLogoUrl(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;

  // A trailing slash after the scheme is required (RFC 3986); a bare `ipfs:Qm…` is malformed.
  // The URL constructor will throw on anything it cannot parse.
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  if (!isAllowedProtocol(parsed)) return null;

  // Defence in depth against markup smuggled through the pathname (e.g. someone putting
  // `"><script>...` in a token's logo field): if any structural character survived the
  // parse, refuse the whole URL.
  if (/[<>"'`\\]/.test(trimmed)) return null;

  if (parsed.protocol === "ipfs:" || parsed.protocol === "ipns:") {
    // Strip the scheme in a case-preserving way. `URL.pathname` lowercases the CID host
    // on some engines, which corrupts CIDv0.
    const rest = trimmed.replace(/^ipfs:\/\//i, "").replace(/^ipns:\/\//i, "");
    if (rest === "" || rest.startsWith("/")) return null;
    return `${IPFS_GATEWAY}${rest}`;
  }

  return parsed.toString();
}

/** First code point of the symbol, uppercased; empty string if the symbol is unusable. */
function initialChar(symbol: string | null | undefined): string {
  if (typeof symbol !== "string") return "";
  const trimmed = symbol.trim();
  if (trimmed === "") return "";
  const first = Array.from(trimmed)[0] ?? "";
  return first.toUpperCase();
}

/**
 * Resolves the source Poolix should try to render for this token.
 *
 * The return value describes intent, not markup: the component decides how to draw an
 * identicon versus an image versus a letter. That keeps the resolver testable without
 * a DOM and keeps the security surface (URL parsing, allowlisting) in one place.
 */
export function resolveTokenLogo(input: TokenLogoInput): TokenLogoSource {
  const addressKey = normalizeAddressKey(input.address ?? null);

  if (addressKey !== null) {
    const known = KNOWN_LOGO_BY_ADDRESS[addressKey];
    if (known !== undefined) return { kind: "url", src: known };
  }

  const supplied = canonicaliseLogoUrl(input.logoUrl ?? null);
  if (supplied !== null) return { kind: "url", src: supplied };

  if (addressKey !== null) return { kind: "identicon", seed: addressKey };

  const char = initialChar(input.symbol ?? null);
  if (char !== "") return { kind: "initial", char };

  // A currency with neither an address nor a symbol should not exist in Poolix, but if
  // one ever slips through, an empty-string identicon still renders as a deterministic
  // (if boring) badge rather than a broken image or a runtime throw.
  return { kind: "identicon", seed: "" };
}
