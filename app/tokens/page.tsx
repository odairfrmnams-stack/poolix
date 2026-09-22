import type { Metadata } from "next";

import { TokenSearch } from "@/components/tokens/token-search";
import { TokenTable } from "@/components/tokens/token-table";
import { Notice } from "@/components/ui/notice";
import { PageHeader } from "@/components/ui/page-header";
import { poolixConfig } from "@/config/poolix";
import { isUniswapV2Available } from "@/config/resolve";
import { copy } from "@/lib/copy";
import { discoverPools } from "@/services/pools/discovery";
import { listTokens } from "@/services/tokens/listing";

export const metadata: Metadata = {
  title: copy.nav.tokens,
  description: `Explore tokens traded on ${poolixConfig.chain.name}, priced from pool reserves.`,
};

export const revalidate = 120;

export default async function TokensPage() {
  const available = isUniswapV2Available(poolixConfig);
  const discovery = available
    ? await discoverPools()
    : { pools: [], totalPairs: 0, scanned: 0, complete: false };
  const tokens = listTokens(discovery);
  const native = poolixConfig.chain.nativeCurrency.symbol;

  return (
    <div className="mx-auto max-w-[1280px] px-4 py-10 sm:px-6 sm:py-14">
      <PageHeader
        title={copy.nav.tokens}
        description={`Tokens with a pool against ${native} on ${poolixConfig.chain.name}. Prices are the mid price implied by pool reserves.`}
        actions={<TokenSearch />}
      />

      <div className="mt-8">
        <TokenTable tokens={tokens} />
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Notice title="How these prices are derived">
          Each price is the ratio of the two reserves in the token&rsquo;s deepest {native} pool,
          before fees and price impact. It is a real onchain number, not a market rate, and it
          is quoted in {native} because Poolix has no verified USD feed on this chain.
        </Notice>
        <Notice title="Why some columns read --">
          {copy.tokens.volume} needs swap history and {copy.tokens.holders} needs a transfer
          index. The public RPC rejects archive queries, so neither is available and Poolix
          shows {copy.data.unavailable} rather than a guess. Paste any address above to read a
          token straight from its contract.
        </Notice>
      </div>
    </div>
  );
}
