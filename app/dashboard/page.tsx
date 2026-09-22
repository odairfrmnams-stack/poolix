import type { Metadata } from "next";

import { Portfolio } from "@/components/dashboard/portfolio";
import { PageHeader } from "@/components/ui/page-header";
import { poolixConfig } from "@/config/poolix";
import { copy } from "@/lib/copy";

export const metadata: Metadata = {
  title: copy.nav.dashboard,
  description: `Your balances and liquidity positions on ${poolixConfig.chain.name}.`,
};

export default function DashboardPage() {
  return (
    <div className="mx-auto max-w-[1280px] px-4 py-10 sm:px-6 sm:py-14">
      <PageHeader
        title={copy.nav.dashboard}
        description={`Balances and liquidity positions for the connected account, read from ${poolixConfig.chain.name}.`}
      />
      <div className="mt-10">
        <Portfolio />
      </div>
    </div>
  );
}
