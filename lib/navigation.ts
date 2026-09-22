import { copy } from "@/lib/copy";

export interface NavItem {
  readonly href: string;
  readonly label: string;
  /**
   * Other routes this item represents. `/tokens` and `/token/0x…` are still real pages;
   * they live under Explore in the navigation rather than getting their own slot.
   */
  readonly covers?: readonly string[];
}

/*
  Four product surfaces, in the order they appear in the header.

  Analytics is deliberately not a fifth item. The navigation stays short because a long
  bar makes every destination feel equally weighted, and Swap is the one that matters;
  Analytics is reachable from Explore and from the footer.
*/
export const primaryNav: readonly NavItem[] = [
  { href: "/swap", label: copy.nav.swap },
  { href: "/explore", label: copy.nav.explore, covers: ["/tokens", "/token", "/analytics"] },
  { href: "/pools", label: copy.nav.pool },
  { href: "/portfolio", label: copy.nav.portfolio, covers: ["/dashboard"] },
];

export const secondaryNav: readonly NavItem[] = [{ href: "/docs", label: copy.nav.docs }];

/**
 * True when `href` is the active surface for `pathname`, so `/pools/0x…` keeps Pool
 * highlighted without `/` matching everything, and a route listed in `covers` lights up
 * the surface it belongs to.
 */
export function isActivePath(pathname: string, href: string, covers: readonly string[] = []): boolean {
  if (href === "/") return pathname === "/";
  const matches = (base: string) => pathname === base || pathname.startsWith(`${base}/`);
  return matches(href) || covers.some(matches);
}
