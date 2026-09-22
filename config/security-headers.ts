/*
  HTTP security headers, derived from what Poolix actually loads.

  The CSP below was not copied from a template. It was built by inspecting the rendered
  HTML of a production build and the set of hosts the application contacts:

    - 7 inline <script> blocks per page      Next's flight payload and bootstrap
    - 18 external <script src>               all same-origin /_next/static
    - 0 inline <style> elements              but 195 style="" attributes (Motion)
    - external hosts in markup               the block explorer, as <a href> only
    - fonts                                  self-hosted by next/font, no external origin
    - images                                 none remote; icons are generated SVG
    - iframes, WebSockets, third-party scripts, analytics tags: none

  What that buys: `object-src 'none'`, `frame-ancestors 'none'`, `base-uri 'self'`,
  `form-action 'self'`, `font-src 'self'`, and a `connect-src` narrowed to the origin plus
  the one RPC endpoint the browser talks to. HyperSync is absent from `connect-src` on
  purpose — it is only ever contacted from the server, and listing it would grant the
  browser a permission it does not need.
*/

/**
 * `script-src` keeps `'unsafe-inline'`, and this is a deliberate, bounded decision.
 *
 * Next's App Router streams its payload through inline `<script>` blocks. Removing
 * `'unsafe-inline'` means a per-request nonce, and a per-request nonce means every route
 * becomes dynamic — which would end static generation and ISR for `/analytics`,
 * `/pools`, `/tokens` and `/portfolio`, the pages whose whole design is a prerendered
 * snapshot on a revalidation cadence. Hash-based allowlisting is not an alternative: the
 * payload differs per page and per build.
 *
 * What makes the trade acceptable is that the injection surface is empty rather than
 * merely small. Poolix contains no `dangerouslySetInnerHTML`, no `innerHTML`, no `eval`,
 * no `new Function`, no markdown or HTML rendering, and no third-party script. The only
 * externally-supplied strings that reach the DOM are token symbols and names, which React
 * escapes and which are additionally sanitised in lib/token-text.ts.
 *
 * `'unsafe-eval'` is NOT included in production. It is the directive that actually turns an
 * injected string into code, and the production bundle has no use for it.
 *
 * It IS included in development, and only there. React's development build calls `eval()`
 * for its debugging features — reconstructing call stacks across environments — and refuses
 * to render without it, which the browser reports as "eval() is not supported in this
 * environment". React's own message is explicit that "React will never use eval() in
 * production mode", so granting it in development costs nothing that ships. Blocking it in
 * development instead would have meant a dev server that cannot render, which is how a CSP
 * gets deleted altogether a week later.
 */
const scriptSrc = (production: boolean): readonly string[] =>
  production ? ["'self'", "'unsafe-inline'"] : ["'self'", "'unsafe-inline'", "'unsafe-eval'"];

/**
 * `style-src` keeps `'unsafe-inline'` because Motion writes `style=""` attributes on every
 * animated element — 195 of them on the analytics page alone — and computes them at
 * runtime, so neither a nonce nor a hash can cover them. Inline *style* is a far smaller
 * concession than inline *script*: it can affect layout, not execution.
 */
const STYLE_SRC = ["'self'", "'unsafe-inline'"];

export interface CspOptions {
  /** Origins the browser may contact. The RPC endpoint, plus anything an operator adds. */
  readonly connectOrigins: readonly string[];
  /** HSTS is omitted in development, where the site is served over http on localhost. */
  readonly production: boolean;
}

/** The origin of a URL, or null when it is not a usable absolute URL. */
export function originOf(url: string | undefined): string | null {
  if (typeof url !== "string" || url.trim() === "") return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/*
  Next's dev server pushes hot-module updates over a WebSocket at ws://localhost:<port>.

  `connect-src 'self'` does not cover it: CSP treats a ws:// URL as a different scheme
  from the page's http:// origin, so the socket is refused and the browser reports
  "WebSocket connection to 'ws://localhost:3000/_next/hmr' failed". The port is not known
  here — `next dev -p` can change it — so the wildcard port is used, scoped to localhost
  and to development only. Production never carries it.
*/
const DEV_CONNECT = ["ws://localhost:*", "http://localhost:*"];

export function contentSecurityPolicy(options: CspOptions): string {
  const connect = [
    "'self'",
    ...new Set([...options.connectOrigins, ...(options.production ? [] : DEV_CONNECT)]),
  ];

  const directives: readonly (readonly [string, readonly string[]])[] = [
    ["default-src", ["'self'"]],
    ["script-src", scriptSrc(options.production)],
    ["style-src", STYLE_SRC],
    // data: covers the generated icon and any inlined SVG; blob: is not needed.
    ["img-src", ["'self'", "data:"]],
    ["font-src", ["'self'"]],
    ["connect-src", connect],
    // No plugins, no embedded documents, and nothing may frame Poolix.
    ["object-src", ["'none'"]],
    ["frame-src", ["'none'"]],
    ["frame-ancestors", ["'none'"]],
    // A swap page has no forms that post anywhere, and <base> rewriting is how a single
    // injected tag would redirect every relative URL on the page.
    ["form-action", ["'self'"]],
    ["base-uri", ["'self'"]],
    ["worker-src", ["'self'", "blob:"]],
    ["manifest-src", ["'self'"]],
    ["upgrade-insecure-requests", []],
  ];

  return directives
    .filter(([name]) => name !== "upgrade-insecure-requests" || options.production)
    .map(([name, values]) => (values.length === 0 ? name : `${name} ${values.join(" ")}`))
    .join("; ");
}

export interface SecurityHeader {
  readonly key: string;
  readonly value: string;
}

/**
 * Every security header Poolix sets, with the reasoning for each kept next to it.
 */
export function securityHeaders(options: CspOptions): readonly SecurityHeader[] {
  const headers: SecurityHeader[] = [
    { key: "Content-Security-Policy", value: contentSecurityPolicy(options) },

    // Stops a response being reinterpreted as a type it did not declare — the mechanism
    // behind "upload a .txt, have it executed as script".
    { key: "X-Content-Type-Options", value: "nosniff" },

    /*
      Send the full URL only to ourselves.

      Poolix URLs carry wallet and contract addresses in the path (/token/0x…), and the
      footer links out to a block explorer. Without this, every such navigation hands the
      explorer the address the user was just looking at. `strict-origin-when-cross-origin`
      sends the path internally and only the origin externally.
    */
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },

    /*
      Refuse powerful features outright. Poolix needs none of them, and a page that never
      asks is a page that cannot be tricked into asking.
    */
    {
      key: "Permissions-Policy",
      value: [
        "accelerometer=()",
        "autoplay=()",
        "camera=()",
        "display-capture=()",
        "encrypted-media=()",
        "fullscreen=(self)",
        "geolocation=()",
        "gyroscope=()",
        "magnetometer=()",
        "microphone=()",
        "midi=()",
        "payment=()",
        "usb=()",
        "xr-spatial-tracking=()",
      ].join(", "),
    },

    // Legacy clickjacking defence for anything predating frame-ancestors.
    { key: "X-Frame-Options", value: "DENY" },

    // Keeps this origin out of other pages' process, which is what makes a cross-origin
    // read of memory-resident state (a connected wallet address) harder.
    { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  ];

  if (options.production) {
    /*
      Two years, subdomains included, preload-eligible.

      Only in production: sending HSTS from a localhost dev server pins http://localhost to
      https in the developer's browser, which then refuses to load the dev server at all —
      a self-inflicted outage that survives restarting it.
    */
    headers.push({
      key: "Strict-Transport-Security",
      value: "max-age=63072000; includeSubDomains; preload",
    });
  }

  return headers;
}
