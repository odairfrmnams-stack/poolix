import type { Metadata } from "next";
import Link from "next/link";

import { CodeBlock } from "@/components/docs/code-block";
import { Notice } from "@/components/ui/notice";
import { poolixConfig } from "@/config/poolix";
import { copy } from "@/lib/copy";

export const metadata: Metadata = {
  title: copy.nav.docs,
  description: `Technical reference for Poolix on ${poolixConfig.chain.name}.`,
};

export default function DocsPage() {
  const { chain, rpcUrl, explorerUrl } = poolixConfig;

  return (
    <article className="space-y-10">
      <header>
        <h1 className="text-2xl font-semibold tracking-[-0.02em]">Build on Poolix</h1>
        <p className="mt-3 text-[14px] leading-relaxed text-muted">
          Poolix is an interface to public liquidity contracts on {chain.name}. It holds no
          custody, runs no private orderbook, and adds no fee of its own. Everything the
          interface shows is read from contracts you can query yourself.
        </p>
      </header>

      <section className="space-y-4">
        <h2 className="text-[16px] font-medium text-fg">Network</h2>
        <dl className="overflow-hidden rounded-poolix-lg border border-line">
          <Row label="Network">{chain.name}</Row>
          <Row label="Chain ID">{chain.id}</Row>
          <Row label="Native currency">
            {chain.nativeCurrency.name} ({chain.nativeCurrency.symbol}), {chain.nativeCurrency.decimals} decimals
          </Row>
          <Row label="RPC endpoint">{rpcUrl}</Row>
          <Row label="Explorer">{explorerUrl}</Row>
        </dl>
        <p className="text-[13px] leading-relaxed text-muted">
          Robinhood&rsquo;s own endpoint, <code className="poolix-numeric text-subtle">{chain.rpcUrls.robinhood.http[0]}</code>,
          is rate limited and is not reachable from every network. Poolix defaults to a public
          gateway and reads <code className="poolix-numeric text-subtle">NEXT_PUBLIC_RPC_URL</code> when
          you want a different one.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-[16px] font-medium text-fg">Architecture</h2>
        <p className="text-[14px] leading-relaxed text-muted">
          Liquidity sources sit behind one interface, so the swap surface does not know which
          protocol quoted it. Today the only implementation is Uniswap v2; adding v3, v4 or
          Poolix&rsquo;s own pools means adding an adapter, not changing the UI.
        </p>
        <CodeBlock label="services/liquidity/types.ts">{`export interface LiquiditySource {
  readonly id: LiquiditySourceId;
  getAvailability(): SourceAvailability;
  /** Resolves to null when this source has no route for the pair. */
  quoteExactIn(request: ExactInSwapRequest, signal?: AbortSignal): Promise<SwapQuote | null>;
  buildSwap(params: SwapExecutionParams): PreparedCall;
}`}</CodeBlock>
        <p className="text-[13px] leading-relaxed text-muted">
          Liquidity management stays source specific on purpose: v2 uses fungible LP tokens,
          v3 and v4 use ranged positions, and v4 identifies pools by ID rather than address.
          Forcing those into one interface would leak the differences anyway.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-[16px] font-medium text-fg">Data availability</h2>
        <p className="text-[14px] leading-relaxed text-muted">
          Poolix shows {copy.data.unavailable} wherever a number cannot be derived from a
          source it can verify. That is a deliberate boundary, not a gap waiting to be filled
          with an estimate.
        </p>
        <dl className="overflow-hidden rounded-poolix-lg border border-line">
          <Row label="Reserves, supply, positions">Read per request from the pair contract</Row>
          <Row label="Quotes">router.getAmountsOut, confirmed against local v2 math</Row>
          <Row label="Token prices">Mid price from pool reserves, denominated in {chain.nativeCurrency.symbol}</Row>
          <Row label="TVL in USD">Unavailable — no verified price feed wired in</Row>
          <Row label="Volume, fees, APR">Unavailable — the public RPC rejects archive queries</Row>
          <Row label="Holders, active users">Unavailable — needs a transfer and transaction index</Row>
        </dl>
      </section>

      <section className="space-y-4">
        <h2 className="text-[16px] font-medium text-fg">Verifying what Poolix ships</h2>
        <p className="text-[14px] leading-relaxed text-muted">
          Every address in the interface is a constant in the repository, checked against the
          chain by a script you can run yourself. It asserts the router points at the factory,
          the factory&rsquo;s WETH matches, pair addresses derive correctly from the canonical init
          code hash, and the deployed fee arithmetic matches Poolix&rsquo;s own.
        </p>
        <CodeBlock label="Terminal">{`npm run verify:chain
npm run verify:chain -- testnet`}</CodeBlock>
        <Notice title={copy.status.unaudited} tone="warning">
          Poolix&rsquo;s interface code has not been audited, and it routes through third-party
          contracts that Poolix did not deploy. Read the addresses on{" "}
          <Link href="/docs/contracts" className="text-accent-text underline-offset-2 hover:underline">
            the contracts page
          </Link>{" "}
          and check them on the explorer before trusting anything with funds.
        </Notice>
      </section>

      <section className="space-y-4">
        <h2 className="text-[16px] font-medium text-fg">API and SDK</h2>
        <p className="text-[14px] leading-relaxed text-muted">
          Poolix does not publish a hosted API or an npm SDK yet, and this page will not
          pretend otherwise. What exists today is the service layer in this repository —{" "}
          <code className="poolix-numeric text-subtle">services/liquidity</code>,{" "}
          <code className="poolix-numeric text-subtle">services/pools</code> and{" "}
          <code className="poolix-numeric text-subtle">services/tokens</code> — which has no React
          dependency and can be imported directly. See{" "}
          <Link href="/docs/integration" className="text-accent-text underline-offset-2 hover:underline">
            Integration
          </Link>
          .
        </p>
      </section>
    </article>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 border-b border-line bg-surface px-4 py-3 text-[13px] last:border-0 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <dt className="shrink-0 text-muted">{label}</dt>
      <dd className="poolix-numeric break-all text-fg sm:text-right">{children}</dd>
    </div>
  );
}
