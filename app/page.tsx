import { ArrowRight, BarChart3, Boxes, Droplets, Repeat } from "lucide-react";
import Link from "next/link";

import { LiquidityCurve } from "@/components/landing/liquidity-curve";
import { buttonVariants } from "@/components/ui/button";
import { poolixConfig } from "@/config/poolix";
import { copy } from "@/lib/copy";
import { cn } from "@/lib/utils";

const products = [
  {
    icon: Repeat,
    title: copy.nav.swap,
    body: "Fast onchain token swaps, quoted directly from pool reserves.",
    href: "/swap",
  },
  {
    icon: Droplets,
    title: copy.nav.pools,
    body: "Provide and manage liquidity, and track the fees a position has earned.",
    href: "/pools",
  },
  {
    icon: BarChart3,
    title: copy.nav.analytics,
    body: "Understand liquidity and market activity across the chain.",
    href: "/analytics",
  },
  {
    icon: Boxes,
    title: "Infrastructure",
    body: "Contracts, addresses and references for projects building on Robinhood Chain.",
    href: "/docs",
  },
] as const;

/*
  The hero visual is pure CSS: a liquid field of drifting radial gradients behind
  three concentric SVG rings that breathe on long cycles. No image asset, no canvas,
  no browser-only APIs used during render — every animation is expressed as CSS
  keyframes so server and client emit the same markup.
*/
function HeroLiquidVisual() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 overflow-hidden"
    >
      <div className="poolix-liquid-field">
        <span className="poolix-liquid-orb poolix-liquid-orb--a" />
        <span className="poolix-liquid-orb poolix-liquid-orb--b" />
        <span className="poolix-liquid-orb poolix-liquid-orb--c" />
      </div>

      <svg
        viewBox="0 0 1200 640"
        preserveAspectRatio="xMidYMid slice"
        className="absolute inset-0 h-full w-full"
      >
        <defs>
          <radialGradient id="poolix-hero-ring" cx="50%" cy="50%" r="50%">
            <stop offset="60%" stopColor="var(--poolix-black)" stopOpacity="0" />
            <stop offset="100%" stopColor="var(--poolix-black)" stopOpacity="0.22" />
          </radialGradient>
        </defs>
        <g style={{ transformOrigin: "600px 340px" }} className="poolix-wave-ring">
          <circle cx="600" cy="340" r="220" fill="none" stroke="url(#poolix-hero-ring)" strokeWidth="1.5" />
        </g>
        <g style={{ transformOrigin: "600px 340px" }} className="poolix-wave-ring poolix-wave-ring--b">
          <circle cx="600" cy="340" r="340" fill="none" stroke="url(#poolix-hero-ring)" strokeWidth="1.5" />
        </g>
        <g style={{ transformOrigin: "600px 340px" }} className="poolix-wave-ring poolix-wave-ring--c">
          <circle cx="600" cy="340" r="470" fill="none" stroke="url(#poolix-hero-ring)" strokeWidth="1.5" />
        </g>
      </svg>
    </div>
  );
}

export default function HomePage() {
  return (
    <>
      <section className="relative overflow-hidden border-b border-line">
        <div
          className="poolix-grid pointer-events-none absolute inset-0"
          style={{ maskImage: "radial-gradient(ellipse 80% 70% at 50% 0%, black, transparent)" }}
          aria-hidden="true"
        />
        <HeroLiquidVisual />

        <div className="relative mx-auto max-w-[1120px] px-4 pt-24 pb-24 sm:px-6 sm:pt-32 sm:pb-28 lg:pt-40">
          <div className="mx-auto max-w-3xl text-center">
            <p className="poolix-hero-eyebrow text-[12px] font-medium tracking-[0.22em] text-fg/70">POOLIX</p>
            <h1 className="poolix-hero-heading mt-6 text-5xl leading-[1.02] font-semibold tracking-[-0.035em] text-balance text-fg sm:text-6xl lg:text-[76px]">
              Liquidity infrastructure for {poolixConfig.chain.name}.
            </h1>
            <p className="poolix-hero-subtitle mx-auto mt-7 max-w-xl text-[15.5px] leading-relaxed text-muted">
              Swap, provide liquidity, and explore onchain markets from one interface.
            </p>

            <div className="poolix-hero-ctas mt-10 flex flex-wrap items-center justify-center gap-3">
              <Link href="/swap" className={cn(buttonVariants({ size: "lg" }))}>
                Launch App
                <ArrowRight className="size-4" aria-hidden="true" />
              </Link>
              <Link href="/pools" className={cn(buttonVariants({ variant: "secondary", size: "lg" }))}>
                Explore Pools
              </Link>
            </div>
          </div>
        </div>
      </section>

      <section className="border-b border-line">
        <div className="mx-auto max-w-[1280px] px-4 py-16 sm:px-6">
          <LiquidityCurve />
        </div>
      </section>

      <section className="border-b border-line">
        <div className="mx-auto max-w-[1280px] px-4 py-16 sm:px-6">
          <h2 className="text-xl font-semibold tracking-[-0.02em] text-fg">What Poolix does</h2>
          <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {products.map((product) => (
              <Link
                key={product.href}
                href={product.href}
                className="group flex flex-col rounded-poolix-lg bg-surface p-6 transition-transform duration-200 hover:-translate-y-0.5"
              >
                <product.icon className="size-5 text-accent-text" aria-hidden="true" />
                <h3 className="mt-4 text-[15px] font-medium text-fg">{product.title}</h3>
                <p className="mt-2 text-[13px] leading-relaxed text-muted">{product.body}</p>
                <span className="mt-6 inline-flex items-center gap-1.5 text-[13px] text-accent-text transition-colors">
                  Open
                  <ArrowRight
                    className="size-3.5 transition-transform group-hover:translate-x-0.5"
                    aria-hidden="true"
                  />
                </span>
              </Link>
            ))}
          </div>
        </div>
      </section>

      <EcosystemSection />
    </>
  );
}

function EcosystemSection() {
  const branches = [copy.nav.swap, copy.nav.pools, copy.nav.analytics];

  return (
    <section>
      <div className="mx-auto max-w-[1280px] px-4 py-16 sm:px-6">
        <div className="grid items-center gap-12 lg:grid-cols-2">
          <div>
            <h2 className="text-xl font-semibold tracking-[-0.02em] text-fg">Built on one chain, on purpose</h2>
            <p className="mt-4 max-w-md text-[14px] leading-relaxed text-muted">
              Poolix targets {poolixConfig.chain.name} only. Every quote, reserve and balance is read
              from chain {poolixConfig.chain.id}, and every address the interface uses is published in
              the documentation.
            </p>
            <Link
              href="/docs"
              className="mt-7 inline-flex items-center gap-1.5 text-[13.5px] font-medium text-fg transition-opacity hover:opacity-70"
            >
              Read the Docs
              <ArrowRight className="size-3.5" aria-hidden="true" />
            </Link>
          </div>

          <div className="rounded-poolix-lg bg-surface p-8">
            <div className="flex flex-col items-center">
              <Node label={poolixConfig.chain.name} muted />
              <Connector />
              <Node label="Poolix" accent />

              <div className="relative h-8 w-full max-w-sm" aria-hidden="true">
                <svg viewBox="0 0 300 32" className="h-full w-full" preserveAspectRatio="none">
                  <path
                    d="M150 0 V12 M150 12 H30 V32 M150 12 H150 V32 M150 12 H270 V32"
                    fill="none"
                    stroke="var(--poolix-border-strong)"
                    strokeWidth="1"
                  />
                </svg>
              </div>

              <div className="grid w-full max-w-sm grid-cols-3 gap-2">
                {branches.map((branch) => (
                  <div
                    key={branch}
                    className="rounded-poolix border border-line bg-raised py-2.5 text-center text-[12.5px] text-muted"
                  >
                    {branch}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function Node({ label, accent = false, muted = false }: { label: string; accent?: boolean; muted?: boolean }) {
  return (
    <div
      className={cn(
        "rounded-poolix border px-4 py-2 text-[13px]",
        accent && "border-accent/40 bg-accent-wash font-medium text-accent-text",
        muted && "border-line bg-raised text-muted",
      )}
    >
      {label}
    </div>
  );
}

function Connector() {
  return <div className="h-7 w-px bg-line-strong" aria-hidden="true" />;
}
