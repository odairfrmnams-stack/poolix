import type { Metadata } from "next";

import { PortfolioPanel } from "@/components/portfolio/portfolio-panel";
import { PageHeader } from "@/components/ui/page-header";
import { poolixConfig } from "@/config/poolix";
import { copy } from "@/lib/copy";
import { getPortfolioScope } from "@/services/portfolio/portfolio-scope";

export const metadata: Metadata = {
  title: copy.nav.portfolio,
  description: `Your balances and liquidity positions on ${poolixConfig.chain.name}.`,
};

/*
  The wallet's own surface, split at the one place it can be.

  A wallet address only exists in the browser, so balances have to be read there. What does
  NOT depend on the wallet — which pools and tokens are worth asking about, and the one
  validated ETH/USD round — is settled here on the server from Poolix's existing universes.
  That split is what keeps the portfolio and the pool pages describing the same set of
  pools instead of two scans that can disagree.

  Nothing about the account is held server-side: with no wallet connected the page says so
  rather than showing placeholder rows.
*/
export const revalidate = 120;

export default async function PortfolioPage() {
  const scope = await getPortfolioScope();

  return (
    <div className="mx-auto max-w-[1080px] px-4 py-10 sm:px-6 sm:py-14">
      <PageHeader
        title={copy.nav.portfolio}
        description={`Balances and liquidity positions for the connected account, read from ${poolixConfig.chain.name}.`}
      />
      <div className="mt-8">
        <PortfolioPanel scope={scope} />
      </div>
    </div>
  );
}
