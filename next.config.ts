import type { NextConfig } from "next";

import { originOf, securityHeaders } from "./config/security-headers";

/*
  The RPC origin the BROWSER is allowed to contact.

  Read straight from the environment rather than through config/poolix.ts, because a
  next.config module is evaluated by the Next CLI outside the app's module graph and
  importing the config chain from here would drag "server-only" into it.

  Both defaults are listed so a deployment that leaves NEXT_PUBLIC_RPC_URL unset still
  gets a working connect-src for whichever network it selects.
*/
const DEFAULT_RPC_ORIGINS = [
  "https://robinhood-rpc.publicnode.com",
  "https://robinhood-sepolia-rpc.publicnode.com",
];

const connectOrigins = [
  ...DEFAULT_RPC_ORIGINS,
  originOf(process.env.NEXT_PUBLIC_RPC_URL),
].filter((origin): origin is string => origin !== null);

const nextConfig: NextConfig = {
  // Poolix serves no untrusted uploads and no user-supplied HTML, so the header set below
  // is the whole of its browser-side hardening. See config/security-headers.ts for why
  // each directive is what it is.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [...securityHeaders({
          connectOrigins,
          production: process.env.NODE_ENV === "production",
        })],
      },
    ];
  },

  // Poolix renders no remote images. Leaving the optimizer without a remote allowlist
  // means next/image cannot be pointed at an arbitrary host.
  images: { remotePatterns: [] },

  // The framework version is a free hint to anyone scanning for known advisories.
  poweredByHeader: false,

  // Hide the dev-only route indicator (the small circular "N" in the corner). It is
  // dev-time UI overlaid by the Next.js CLI, not part of the built app, so this
  // has no effect on the production bundle. The earlier `buildActivity` /
  // `appIsrStatus` sub-options were removed in Next 16 — the whole value is now
  // just `false`. See node_modules/next/dist/docs/…/devIndicators.md.
  devIndicators: false,
};

export default nextConfig;
