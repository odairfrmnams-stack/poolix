import type { Metadata } from "next";
import { ExternalLink } from "lucide-react";

import { Notice } from "@/components/ui/notice";
import { robinhoodNetworks } from "@/config/chains";
import { poolixConfig } from "@/config/poolix";
import { explorerUrl } from "@/lib/format";
import type { Address } from "@/types/web3";

export const metadata: Metadata = {
  title: "Contract Addresses",
  description: `Verified contract addresses Poolix uses on ${poolixConfig.chain.name}.`,
};

export default function ContractsPage() {
  // Only mainnet is published here. Testnet stays a first-class target of the
  // codebase and the verify:chain gate — this file is just the docs surface.
  const { chain, contracts } = robinhoodNetworks.mainnet;
  const explorer = chain.blockExplorers.default.url;
  const active = poolixConfig.network === "mainnet";

  return (
    <article className="space-y-10">
      <header>
        <h1 className="text-2xl font-semibold tracking-[-0.02em]">Contract Addresses</h1>
        <p className="mt-3 text-[14px] leading-relaxed text-muted">
          These are the only addresses Poolix calls. They are constants in{" "}
          <code className="poolix-numeric text-subtle">config/chains.ts</code> rather than
          environment variables, because a mistyped address in an env file is a silent
          misconfiguration that would route funds to the wrong contract.
        </p>
      </header>

      <section className="space-y-4">
        <div className="flex items-center gap-3">
          <h2 className="text-[16px] font-medium text-fg">{chain.name}</h2>
          <span className="rounded-full border border-line px-2 py-0.5 text-[11px] text-subtle">
            Chain {chain.id}
          </span>
          {active ? (
            <span className="rounded-full border border-accent/40 bg-accent-wash px-2 py-0.5 text-[11px] text-accent-text">
              Selected
            </span>
          ) : null}
        </div>

        <div className="overflow-hidden rounded-poolix-lg border border-line">
          <AddressRow label="WETH" address={contracts.weth} explorer={explorer} />
          <AddressRow label="Permit2" address={contracts.permit2} explorer={explorer} />
          <AddressRow label="L2 Multicall" address={contracts.l2Multicall} explorer={explorer} />
          {contracts.uniswapV2 !== null ? (
            <>
              <AddressRow
                label="UniswapV2Factory"
                address={contracts.uniswapV2.factory}
                explorer={explorer}
              />
              <AddressRow
                label="UniswapV2Router02"
                address={contracts.uniswapV2.router}
                explorer={explorer}
              />
            </>
          ) : null}
        </div>
      </section>

      <section className="space-y-4">
        <h2 className="text-[16px] font-medium text-fg">How these were checked</h2>
        <p className="text-[14px] leading-relaxed text-muted">
          The Uniswap addresses come from Uniswap&rsquo;s official deployments list and were then
          confirmed against the chain. <code className="poolix-numeric text-subtle">npm run verify:chain</code>{" "}
          re-runs every assertion:
        </p>
        <ul className="space-y-2 text-[13.5px] leading-relaxed text-muted">
          <Check>router.factory() returns the factory address above.</Check>
          <Check>router.WETH() returns the WETH address above.</Check>
          <Check>Both contracts are verified source on Blockscout, under their canonical names.</Check>
          <Check>
            Pair addresses derived offchain from the canonical init code hash match
            factory.getPair for live pairs.
          </Check>
          <Check>
            router.getAmountsOut matches Poolix&rsquo;s own v2 arithmetic exactly across sampled
            pools, confirming the deployed 0.30% fee.
          </Check>
        </ul>

        <Notice title="The L2 Multicall is a Multicall2, not a Multicall3">
          It exposes <code className="poolix-numeric">aggregate</code> and{" "}
          <code className="poolix-numeric">tryAggregate</code> but not{" "}
          <code className="poolix-numeric">aggregate3</code>, so it is deliberately not wired into
          viem&rsquo;s multicall3 slot, where it would revert. Poolix batches reads at the JSON-RPC
          layer instead.
        </Notice>

        <Notice title="Check addresses before you trust them" tone="warning">
          Router lookalikes are documented on this chain, including modified builds whose
          calldata differs from stock Uniswap. Compare anything you are about to approve
          against the addresses above and against the explorer, not against a link someone
          sent you.
        </Notice>
      </section>
    </article>
  );
}

function AddressRow({
  label,
  address,
  explorer,
}: {
  label: string;
  address: Address;
  explorer: string;
}) {
  return (
    <div className="flex flex-col gap-1.5 border-b border-line bg-surface px-4 py-3 text-[13px] last:border-0 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <span className="shrink-0 text-muted">{label}</span>
      <a
        href={explorerUrl(explorer, "address", address)}
        target="_blank"
        rel="noreferrer noopener"
        className="poolix-numeric inline-flex items-center gap-1.5 break-all text-fg transition-colors hover:text-accent-text"
      >
        {address}
        <ExternalLink className="size-3 shrink-0 text-subtle" aria-hidden="true" />
      </a>
    </div>
  );
}

function Check({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex gap-2.5">
      <span className="mt-[7px] size-1 shrink-0 rounded-full bg-accent" aria-hidden="true" />
      <span>{children}</span>
    </li>
  );
}
