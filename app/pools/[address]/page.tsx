import type { Metadata } from "next";

import { PoolDetail } from "@/components/pools/pool-detail";
import { poolixConfig } from "@/config/poolix";
import { truncateAddress } from "@/lib/format";
import { getPoolAnalytics } from "@/services/pools/pool-analytics";

export async function generateMetadata(props: PageProps<"/pools/[address]">): Promise<Metadata> {
  const { address } = await props.params;
  return {
    // The pair's tokens are only known after an onchain read, so the title stays
    // factual rather than guessing at symbols.
    title: `Pool ${truncateAddress(address)}`,
    description: `Liquidity pool ${address} on ${poolixConfig.chain.name}.`,
  };
}

/*
  The history behind this page is ingested on a two-minute cycle, so the page is revalidated
  on the same cadence. The live half — reserves, LP balance, the position — is read on the
  client on every refresh, because a position is the one figure here that must be current
  rather than merely recent.
*/
export const revalidate = 120;

export default async function PoolPage(props: PageProps<"/pools/[address]">) {
  const { address } = await props.params;
  const analytics = await getPoolAnalytics(address);

  return (
    <div className="mx-auto max-w-[1400px] px-4 py-10 sm:px-6 sm:py-14">
      <PoolDetail address={address} analytics={analytics} />
    </div>
  );
}
