import Link from "next/link";

import { PoolixMark, PoolixWordmark } from "@/components/brand/poolix-mark";
import { poolixConfig } from "@/config/poolix";
import { copy } from "@/lib/copy";

const columns = [
  {
    title: "Product",
    links: [
      { href: "/swap", label: copy.nav.swap },
      { href: "/explore", label: copy.nav.explore },
      { href: "/pools", label: copy.nav.pool },
      { href: "/portfolio", label: copy.nav.portfolio },
      // Analytics is not in the header — the footer is where it stays reachable.
      { href: "/analytics", label: copy.nav.analytics },
    ],
  },
  {
    title: copy.nav.developers,
    links: [
      { href: "/docs", label: copy.nav.docs },
      { href: "/docs/contracts", label: "Contract Addresses" },
      { href: "/docs/integration", label: "Integration" },
    ],
  },
] as const;

export function SiteFooter() {
  return (
    <footer className="mt-auto border-t border-line">
      <div className="mx-auto grid max-w-[1280px] gap-10 px-4 py-12 sm:px-6 md:grid-cols-[1.4fr_1fr_1fr]">
        <div>
          <div className="flex items-center gap-2 text-fg">
            <PoolixMark className="size-[22px]" />
            <PoolixWordmark className="text-[15px] font-semibold tracking-[-0.01em]" />
          </div>
          <p className="mt-3 max-w-xs text-[13px] leading-relaxed text-muted">
            Liquidity infrastructure for Robinhood Chain.
          </p>
          {/*
            States maturity, not security. The audit disclosure lives in the security
            section of /docs, where it has room to be explained; a check glyph is left
            out here because it would read as a verification claim.
          */}
          <p
            className="mt-4 inline-flex items-center gap-2 rounded-full border border-line px-2.5 py-1 text-[11px] text-subtle transition-[border-color,color,box-shadow] duration-150 hover:border-accent/40 hover:text-muted hover:shadow-[0_0_0_1px_rgba(16,185,129,0.18),0_0_18px_rgba(16,185,129,0.16)]"
          >
            <span className="size-1.5 rounded-full bg-accent" aria-hidden="true" />
            {poolixConfig.chain.name} · {copy.status.beta}
          </p>
        </div>

        {columns.map((column) => (
          <div key={column.title}>
            <h2 className="text-[11px] font-medium tracking-wider text-subtle uppercase">{column.title}</h2>
            <ul className="mt-3 space-y-2">
              {column.links.map((link) => (
                <li key={link.href}>
                  <Link href={link.href} className="text-[13px] text-muted transition-colors hover:text-fg">
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <div className="border-t border-line">
        <div className="mx-auto flex max-w-[1280px] flex-col gap-2 px-4 py-5 text-[12px] text-subtle sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <p>Poolix is an interface to public smart contracts. It holds no custody of your assets.</p>
          <div className="flex items-center gap-4">
            <a
              href={poolixConfig.explorerUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="transition-colors hover:text-fg"
            >
              Explorer
            </a>
            <a
              href="https://x.com/Poolixnetwork"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Poolix on X"
              className="inline-flex size-6 items-center justify-center rounded-poolix-sm text-fg transition-transform duration-150 hover:scale-110"
            >
              <XLogo className="size-[16px]" />
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}

/*
  X (Twitter) logo. Inline SVG rather than a package: lucide has a legacy Twitter
  bird but no current X mark, and pulling a whole brand-icon library for one glyph
  would be more weight than the mark itself. `currentColor` lets the anchor's
  text-fg drive it, so it inherits the palette on any surface without a rule.
*/
function XLogo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      className={className}
    >
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231 5.451-6.231Zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77Z" />
    </svg>
  );
}
