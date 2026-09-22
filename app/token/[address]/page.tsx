import type { Metadata } from "next";

import { PonsTokenPanel } from "@/components/pons/pons-token-panel";
import { TokenDetail } from "@/components/tokens/token-detail";
import { poolixConfig } from "@/config/poolix";
import { toAddress } from "@/lib/address";
import { truncateAddress } from "@/lib/format";
import { getPonsView } from "@/services/pons/pons-view";

export async function generateMetadata(props: PageProps<"/token/[address]">): Promise<Metadata> {
  const { address } = await props.params;
  return {
    // The symbol is only known after reading the contract, so the title stays factual.
    title: `Token ${truncateAddress(address)}`,
    description: `Token ${address} on ${poolixConfig.chain.name}.`,
  };
}

export default async function TokenPage(props: PageProps<"/token/[address]">) {
  const { address } = await props.params;

  /*
    The Pons panel is looked up by normalised address against the index, so a malformed
    route parameter simply matches nothing — it never reaches a contract call. When the
    token is not a Pons launch the page is exactly what it was before.
  */
  const normalised = toAddress(address)?.toLowerCase() ?? null;
  const pons = normalised === null ? null : await getPonsView();
  const ponsRow =
    pons === null || !pons.available
      ? null
      : (pons.rows.find((row) => row.tokenAddress === normalised) ?? null);

  return (
    <div className="mx-auto max-w-[1400px] px-4 py-10 sm:px-6 sm:py-14">
      {ponsRow !== null && pons !== null ? (
        <div className="mb-10">
          <PonsTokenPanel
            row={ponsRow}
            thresholds={pons.thresholds}
            volumeWindowComplete={pons.volumeWindowComplete}
            indexedBlock={pons.index.indexedBlock}
          />
        </div>
      ) : null}
      <TokenDetail address={address} />
    </div>
  );
}
