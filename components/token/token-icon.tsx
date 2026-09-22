"use client";

/*
  <TokenIcon> — the single component every surface in Poolix uses to render a token's
  logo. Its job is to never produce a broken image and to always look coherent with the
  Aqua-Mint × Black palette.

  It is a client component because the "remote URL failed → fall back to the identicon"
  path needs an onError handler. On the server it renders the initial (best) attempt,
  so hydration matches: same markup either side unless the browser has already tried
  the image and marked it as failed for this session.

  The resolver in lib/token-logo.ts decides WHAT to render; this file only decides HOW.
*/

import { useMemo, useState } from "react";

import { identiconSpec } from "@/lib/identicon";
import { resolveTokenLogo, type TokenLogoInput } from "@/lib/token-logo";
import { tokenBadgeLabel } from "@/lib/token-text";
import { cn } from "@/lib/utils";

export interface TokenIconProps extends TokenLogoInput {
  /** Pixel size of the outer circle. 32 (table row), 40 (selector), 48+ (detail). */
  readonly size?: 24 | 28 | 32 | 40 | 48 | 56 | 64;
  /** Optional visible alt text for the `<img>` tier. Defaults to the symbol or address. */
  readonly title?: string | null;
  readonly className?: string;
}

/**
 * Per-failed-URL memory. If a token's remote image failed once during this page load we
 * do not try it again on the next render — that would produce a flash of the broken
 * image every time the component remounts (e.g. when a virtualised list scrolls). The
 * set is process-local, cleared on a full reload, and keyed by canonical URL, so two
 * tokens that happen to share a logo also share its failure.
 */
const failedUrls = new Set<string>();

export function TokenIcon({
  address,
  symbol,
  logoUrl,
  size = 32,
  title,
  className,
}: TokenIconProps) {
  const resolved = useMemo(
    () => resolveTokenLogo({ address, symbol, logoUrl }),
    [address, symbol, logoUrl],
  );

  // The URL tier can move to identicon; the identicon tier is terminal.
  const initiallyBroken = resolved.kind === "url" && failedUrls.has(resolved.src);
  const [broken, setBroken] = useState<boolean>(initiallyBroken);

  const dimensions = { width: size, height: size };
  const altText = (title ?? symbol ?? address ?? "").toString();

  // Outer wrapper: circular, subtle border. The border and background are driven by
  // CSS custom properties that already re-scope on dark surfaces (see app/globals.css),
  // so the same class reads correctly on the mint canvas and inside a dark card.
  const outer = cn(
    "relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full",
    "border border-line bg-raised",
    className,
  );

  if (resolved.kind === "url" && !broken) {
    return (
      <span className={outer} style={dimensions}>
        {/*
          <img> rather than next/image because next.config.ts intentionally leaves
          remotePatterns empty — Poolix does not proxy arbitrary remote hosts through
          the image optimiser. Native <img> loads the URL directly and, on failure,
          hands us onError to switch to the identicon.
        */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={resolved.src}
          alt={altText}
          width={size}
          height={size}
          referrerPolicy="no-referrer"
          decoding="async"
          loading="lazy"
          onError={() => {
            failedUrls.add(resolved.src);
            setBroken(true);
          }}
          className="size-full object-cover"
        />
      </span>
    );
  }

  if (resolved.kind === "initial") {
    // A resolved initial only happens when the caller supplied no address — very rare.
    // We still route through tokenBadgeLabel so surrogate pairs stay whole.
    const label = tokenBadgeLabel(symbol, "");
    return (
      <span
        className={cn(outer, "font-medium text-fg")}
        style={{ ...dimensions, fontSize: Math.max(9, Math.round(size * 0.32)) }}
        aria-label={altText || undefined}
      >
        {label !== "" ? label : resolved.char}
      </span>
    );
  }

  // Identicon path: either the resolver picked it, or the URL failed. Render the SVG
  // directly as JSX (not dangerouslySetInnerHTML) so nothing can smuggle markup through
  // the seed.
  const spec = identiconSpec(resolved.kind === "identicon" ? resolved.seed : (address ?? ""));
  return (
    <span
      className={outer}
      style={dimensions}
      role="img"
      aria-label={altText || "token"}
    >
      <svg
        viewBox="0 0 5 5"
        width={size}
        height={size}
        shapeRendering="crispEdges"
        aria-hidden="true"
        className="size-full"
      >
        <rect width={5} height={5} fill={spec.background} />
        {spec.cells.map((on, i) =>
          on ? (
            <rect
              // Index is stable for a given seed, so it is a legitimate key here.
              key={i}
              x={i % 5}
              y={Math.floor(i / 5)}
              width={1}
              height={1}
              fill={spec.foreground}
            />
          ) : null,
        )}
      </svg>
    </span>
  );
}

/**
 * Pair of overlapping token icons. Used in pool rows and LP position tiles, where the
 * two tokens together identify the row. The second icon is nudged left by ~35% of the
 * icon size, which is close enough to overlap without hiding either symbol.
 */
export interface TokenPairIconProps {
  readonly a: TokenLogoInput;
  readonly b: TokenLogoInput;
  readonly size?: TokenIconProps["size"];
  readonly className?: string;
}

export function TokenPairIcon({ a, b, size = 28, className }: TokenPairIconProps) {
  return (
    <span className={cn("inline-flex items-center", className)}>
      <TokenIcon {...a} size={size} />
      <TokenIcon {...b} size={size} className="-ml-2 ring-1 ring-canvas/60" />
    </span>
  );
}
