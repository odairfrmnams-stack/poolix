import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Notice } from "@/components/ui/notice";
import { poolixConfig } from "@/config/poolix";
import { copy } from "@/lib/copy";
import { explorerUrl, formatUsd, truncateAddress } from "@/lib/format";
import { PONS_POOL_FEE } from "@/services/pons/pons-config";
import type { PonsTokenRow } from "@/services/pons/pons-view";

/*
  The Pons half of a token page, kept visually and structurally separate from Poolix's own
  Uniswap v2 analytics.

  The separation is the point. Pons launch data describes a V3 pool; Poolix's analytics
  describe V2 pools. Presenting them in one block would invite a reader to compare two
  numbers that measure different things in different pools — so they are two sections with
  two headings, and this one says where its numbers come from.
*/

export interface PonsTokenPanelProps {
  readonly row: PonsTokenRow;
  readonly thresholds: { readonly minMarketCapUsd: number; readonly minVolume24hUsd: number };
  readonly volumeWindowComplete: boolean;
  readonly indexedBlock: number;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-[11.5px] text-subtle">{label}</p>
      <div className="mt-1 truncate text-[13px] text-fg">{children}</div>
    </div>
  );
}

const dash = <span className="text-subtle">{copy.data.unavailable}</span>;

export function PonsTokenPanel({ row, thresholds, volumeWindowComplete, indexedBlock }: PonsTokenPanelProps) {
  const explorer = poolixConfig.explorerUrl;

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-[15px] font-medium text-fg">Pons launch</h2>
        <Badge tone="accent">Source: Pons</Badge>
        {row.v2Availability === "available" ? (
          <Badge tone="accent">V2 Available</Badge>
        ) : row.v2Availability === "unavailable" ? (
          <Badge tone="neutral">V2 Not Available</Badge>
        ) : null}
        {row.qualified ? <Badge tone="accent">Qualified</Badge> : null}
      </div>

      <Card padding="md">
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Symbol">{row.symbol ?? dash}</Field>
          <Field label="Name">{row.name ?? dash}</Field>
          <Field label="Decimals">{row.decimals ?? dash}</Field>

          <Field label="Token">
            <a
              href={explorerUrl(explorer, "address", row.tokenAddress)}
              target="_blank"
              rel="noopener noreferrer"
              className="poolix-numeric underline-offset-4 hover:underline"
            >
              {truncateAddress(row.tokenAddress)}
            </a>
          </Field>
          <Field label="Creator">
            <a
              href={explorerUrl(explorer, "address", row.creatorAddress)}
              target="_blank"
              rel="noopener noreferrer"
              className="poolix-numeric underline-offset-4 hover:underline"
            >
              {truncateAddress(row.creatorAddress)}
            </a>
          </Field>
          <Field label="Total supply">
            {row.totalSupply === null || row.decimals === null
              ? dash
              : (Number(BigInt(row.totalSupply) / 10n ** BigInt(row.decimals))).toLocaleString("en-US")}
          </Field>

          <Field label="Launch block">
            <span className="poolix-numeric">{row.launchBlock.toLocaleString("en-US")}</span>
          </Field>
          <Field label="Launch transaction">
            <a
              href={explorerUrl(explorer, "tx", row.launchTxHash)}
              target="_blank"
              rel="noopener noreferrer"
              className="poolix-numeric underline-offset-4 hover:underline"
            >
              {truncateAddress(row.launchTxHash)}
            </a>
          </Field>
          <Field label="Locked position">
            <span className="poolix-numeric">#{row.positionTokenId}</span>
          </Field>

          <Field label={`Source pool · Pons reference (Uniswap v3, ${(PONS_POOL_FEE / 10_000).toFixed(0)}% fee)`}>
            {row.poolVerified ? (
              <a
                href={explorerUrl(explorer, "address", row.poolAddress)}
                target="_blank"
                rel="noopener noreferrer"
                className="poolix-numeric underline-offset-4 hover:underline"
              >
                {truncateAddress(row.poolAddress)}
              </a>
            ) : (
              dash
            )}
          </Field>
          <Field label="Price (ETH)">
            {row.priceInQuoteE18 === null ? (
              dash
            ) : (
              <span className="poolix-numeric">
                {(Number(BigInt(row.priceInQuoteE18)) / 1e18).toPrecision(6)}
              </span>
            )}
          </Field>
          <Field label="Market cap">
            {row.marketCapUsdCents === null ? dash : formatUsd(Number(BigInt(row.marketCapUsdCents)) / 100)}
          </Field>

          <Field label="Volume 24H">
            {row.volume24hUsdCents === null ? dash : formatUsd(Number(BigInt(row.volume24hUsdCents)) / 100)}
          </Field>
          <Field label="Swaps 24H">
            {row.volume24hSwaps === null ? dash : row.volume24hSwaps.toLocaleString("en-US")}
          </Field>
          <Field label="Indexed through block">
            <span className="poolix-numeric">{indexedBlock.toLocaleString("en-US")}</span>
          </Field>
          <Field label="Uniswap v2 pair">
            {row.v2PairAddress !== null ? (
              <a
                href={explorerUrl(explorer, "address", row.v2PairAddress)}
                target="_blank"
                rel="noopener noreferrer"
                className="poolix-numeric underline-offset-4 hover:underline"
              >
                {truncateAddress(row.v2PairAddress)}
              </a>
            ) : (
              dash
            )}
          </Field>
        </div>
      </Card>

      {/*
        Poolix trades through Uniswap v2 and only through Uniswap v2.

        Whether that is possible for a given Pons token is decided by the v2 factory, not
        by anything Pons published — so this branches on the factory's own answer. When
        there is no v2 pair the token is discovery-only, and the user is NOT pointed at v3
        as a substitute: a route Poolix does not execute is not an alternative it should
        recommend.
      */}
      {row.v2Availability === "available" ? (
        <Notice title="Tradeable on Poolix" tone="neutral">
          A Uniswap v2 pair exists for this token, so Poolix&rsquo;s normal swap, liquidity and
          analytics flows apply — the same ones used for every other v2 token.{" "}
          <Link href="/swap" className="text-accent-text underline-offset-4 hover:underline">
            Swap
          </Link>{" "}
          or{" "}
          <Link href="/pools" className="text-accent-text underline-offset-4 hover:underline">
            provide liquidity
          </Link>
          .
        </Notice>
      ) : row.v2Availability === "unavailable" ? (
        <Notice title="Discovery only — no Uniswap v2 pair" tone="neutral">
          The Uniswap v2 factory reports no pair for this token, so Poolix cannot trade it. It is
          listed here so the launch is visible, not as something to buy. Its launch liquidity sits
          in the Uniswap v3 source pool above, which Poolix records as a reference and does not
          route through.
        </Notice>
      ) : (
        <Notice title="Uniswap v2 availability not yet read" tone="neutral">
          Poolix has not yet asked the Uniswap v2 factory about this token. That is not the same as
          there being no pair — the answer is unknown until the read happens, and it is shown as{" "}
          {copy.data.unavailable} rather than guessed.
        </Notice>
      )}

      <p className="text-[11.5px] leading-relaxed text-subtle">
        Price comes from the pool&rsquo;s current <code className="poolix-numeric">slot0</code> and
        market cap multiplies it by the token&rsquo;s own{" "}
        <code className="poolix-numeric">totalSupply</code> at the verified ETH/USD rate. Volume sums
        Uniswap v3 <code className="poolix-numeric">Swap</code> events over the last 24 hours;{" "}
        {volumeWindowComplete
          ? "that window was read completely."
          : `it reads ${copy.data.unavailable} because the window was not read completely, and a partial sum would understate it.`}{" "}
        A figure that cannot be derived is shown as {copy.data.unavailable} rather than estimated.
        These figures describe the Pons source pool and are <strong className="font-medium text-muted">
        reference data</strong>; they are not part of Poolix&rsquo;s Uniswap v2 analytics and are never
        mixed into them. &ldquo;Qualified&rdquo; means market cap at or above{" "}
        {formatUsd(thresholds.minMarketCapUsd)} and 24-hour volume at or above{" "}
        {formatUsd(thresholds.minVolume24hUsd)} — a numerical filter, not a judgement.{" "}
        <Link href="/explore" className="text-accent-text underline-offset-4 hover:underline">
          Browse Pons launches
        </Link>
        .
      </p>
    </section>
  );
}
