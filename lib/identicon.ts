/*
  Deterministic address-derived identicon.

  Same address in, same picture out, forever. That property is what makes the fallback
  useful: two tables side by side, or a swap page and an explore page, will show the
  same visual for the same token even when neither has a logo. The rules:

    - Input is a lowercased string (whatever `normalizeAddressKey` produced). Casing
      matters here because the hash is byte-level; the caller lowercases first.
    - Output is a small, self-contained SVG description with no external references,
      no scripts, no filters, no `<foreignObject>` — nothing that could be a
      rendering-time surprise. React renders it directly as JSX.
    - No random, no clock, no browser API. This module is safe to import from a server
      component and produces identical HTML on both sides of the hydration boundary.

  The visual is a 5×5 grid mirrored around the vertical axis (so 15 independent cells)
  in a foreground colour selected from a small palette derived from Poolix's Aqua-Mint ×
  Black system. Every colour in the palette reads well on both the mint canvas and the
  black cards, so a badge does not need to know which surface it will land on.
*/

import { normalizeAddressKey } from "@/lib/token-logo";

export interface IdenticonSpec {
  readonly background: string;
  readonly foreground: string;
  /** 25 booleans, row-major, top-left → bottom-right, already mirrored. */
  readonly cells: readonly boolean[];
}

/**
 * A tiny non-cryptographic hash. FNV-1a with a 32-bit state. Good enough for picking a
 * pattern out of a small space; not good enough for anything else. We do not want
 * `crypto.subtle` here because it is async, browser-only, and would force the identicon
 * to render asynchronously — which would defeat the point of having a synchronous
 * fallback that never shows a broken image.
 */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // Multiply by the 32-bit FNV prime, kept in the safe-integer range with Math.imul.
    hash = Math.imul(hash, 0x01000193);
  }
  // Fold to unsigned 32-bit.
  return hash >>> 0;
}

/**
 * Palette used for identicon foregrounds. All values are drawn from the Aqua-Mint ×
 * Black tokens in app/globals.css. Backgrounds sit at ~12% opacity of the same hue so
 * a token badge reads as a soft chip on either the canvas or a dark card.
 */
const PALETTE: ReadonlyArray<{ fg: string; bg: string }> = [
  { fg: "#0A0F0D", bg: "rgba(10, 15, 13, 0.10)" },   // ink
  { fg: "#12382F", bg: "rgba(18, 56, 47, 0.14)" },   // dark-mint
  { fg: "#4DE8C1", bg: "rgba(77, 232, 193, 0.16)" }, // deep-mint
  { fg: "#4E766A", bg: "rgba(78, 118, 106, 0.14)" }, // muted-mint
  { fg: "#B8FFE9", bg: "rgba(184, 255, 233, 0.20)" },// mint-bright — high contrast
  { fg: "#0A0F0D", bg: "rgba(143, 255, 224, 0.22)" },// ink on aqua wash
];

/** Derives the full spec from an address-shaped seed. */
export function identiconSpec(seed: string): IdenticonSpec {
  const key = normalizeAddressKey(seed) ?? "";
  const hash = fnv1a(key === "" ? "poolix-empty" : key);

  const palette = PALETTE[hash % PALETTE.length]!;

  const cells: boolean[] = Array.from({ length: 25 }, () => false);
  // The grid is 5×5 mirrored around column 2, so we independently roll columns 0..2 for
  // each of the 5 rows. That is 15 bits of pattern space.
  for (let row = 0; row < 5; row++) {
    for (let col = 0; col < 3; col++) {
      const bit = (row * 3 + col) % 32;
      // Re-mix with a shifted hash to get 15 independent bits out of a 32-bit hash.
      const mixed = (hash ^ Math.imul(hash + bit + 1, 0x85ebca6b)) >>> 0;
      const on = ((mixed >>> bit) & 1) === 1;
      cells[row * 5 + col] = on;
      cells[row * 5 + (4 - col)] = on;
    }
  }

  return {
    background: palette.bg,
    foreground: palette.fg,
    cells,
  };
}

/**
 * Serialises an identicon spec to an SVG string. Used by the component and, in tests,
 * by determinism checks. `size` is the pixel size of the whole square; the internal
 * viewBox stays 0..5 so the SVG scales cleanly at any resolution.
 */
export function identiconSvgString(seed: string, size: number): string {
  const spec = identiconSpec(seed);
  const rects: string[] = [];
  for (let i = 0; i < spec.cells.length; i++) {
    if (!spec.cells[i]) continue;
    const x = i % 5;
    const y = Math.floor(i / 5);
    rects.push(`<rect x="${x}" y="${y}" width="1" height="1" fill="${spec.foreground}"/>`);
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 5 5" width="${size}" height="${size}" ` +
    `shape-rendering="crispEdges" aria-hidden="true">` +
    `<rect width="5" height="5" fill="${spec.background}"/>` +
    rects.join("") +
    `</svg>`
  );
}
