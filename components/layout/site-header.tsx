"use client";

import { Menu, X } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

import { PoolixMark, PoolixWordmark } from "@/components/brand/poolix-mark";
import { GlobalSearch } from "@/components/search/global-search";
import { Badge } from "@/components/ui/badge";
import { ConnectWallet } from "@/components/wallet/connect-wallet";
import { poolixConfig } from "@/config/poolix";
import { isActivePath, primaryNav, secondaryNav } from "@/lib/navigation";
import { cn } from "@/lib/utils";

/*
  A compact bar: brand, four surfaces, and the wallet.

  The primary links sit in a single pill so they read as one control rather than four
  loose words, which keeps the eye on the page content underneath. Everything secondary —
  docs, search — is pushed right and quieter than the wallet button, because connecting
  is the only thing here anyone needs to find in a hurry.
*/
export function SiteHeader() {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPathname, setMenuPathname] = useState(pathname);

  // A route change should never leave the mobile sheet hanging open. Adjusting during
  // render rather than in an effect avoids a second paint with the stale menu showing.
  if (menuPathname !== pathname) {
    setMenuPathname(pathname);
    setMenuOpen(false);
  }

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-canvas/85 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-[1280px] items-center gap-4 px-4 sm:px-6">
        <Link href="/" className="flex shrink-0 items-center gap-2 text-ink" aria-label="Poolix home">
          <PoolixMark className="size-[22px]" />
          <PoolixWordmark className="text-[15px] font-semibold tracking-[-0.01em]" />
        </Link>

        {poolixConfig.chain.testnet ? (
          <Badge tone="warning" className="hidden shrink-0 sm:inline-flex">
            Testnet
          </Badge>
        ) : null}

        <nav
          className="ml-2 hidden items-center gap-0.5 rounded-poolix-full border border-line-strong bg-transparent p-1 md:flex"
          aria-label="Primary"
        >
          {primaryNav.map((item) => (
            <HeaderLink
              key={item.href}
              href={item.href}
              active={isActivePath(pathname, item.href, item.covers)}
            >
              {item.label}
            </HeaderLink>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <nav className="hidden items-center lg:flex" aria-label="Secondary">
            {secondaryNav.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                aria-current={isActivePath(pathname, item.href) ? "page" : undefined}
                className={cn(
                  "rounded-poolix px-3 py-2 text-[13.5px] transition-colors",
                  isActivePath(pathname, item.href) ? "text-fg" : "text-muted hover:text-fg",
                )}
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <GlobalSearch />
          <ConnectWallet />
          <button
            type="button"
            onClick={() => setMenuOpen((value) => !value)}
            aria-expanded={menuOpen}
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            className="flex size-9 items-center justify-center rounded-poolix border border-line text-muted transition-colors hover:border-line-strong hover:text-fg md:hidden"
          >
            {menuOpen ? <X className="size-4" /> : <Menu className="size-4" />}
          </button>
        </div>
      </div>

      {menuOpen ? (
        <nav className="border-t border-line bg-canvas px-4 py-2 md:hidden" aria-label="Mobile">
          {[...primaryNav, ...secondaryNav].map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "block rounded-poolix px-3 py-3 text-sm transition-colors",
                isActivePath(pathname, item.href, item.covers)
                  ? "bg-accent-wash text-accent-text"
                  : "text-muted hover:bg-raised hover:text-fg",
              )}
            >
              {item.label}
            </Link>
          ))}
        </nav>
      ) : null}
    </header>
  );
}

function HeaderLink({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  const reduceMotion = useReducedMotion();

  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "relative rounded-poolix-full px-3.5 py-1.5 text-[13.5px] transition-colors",
        active ? "text-mint-bright" : "text-muted hover:text-ink",
      )}
    >
      {active ? (
        <motion.span
          layoutId={reduceMotion ? undefined : "header-active"}
          className="absolute inset-0 rounded-poolix-full bg-ink"
          transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
        />
      ) : null}
      <span className="relative">{children}</span>
    </Link>
  );
}
