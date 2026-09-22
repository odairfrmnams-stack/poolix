"use client";

import { Wallet } from "lucide-react";
import Link from "next/link";
import { formatUnits } from "viem";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { MetricCard, MetricGrid } from "@/components/ui/metric-card";
import { Notice } from "@/components/ui/notice";
import { Skeleton } from "@/components/ui/skeleton";
import { YourLiquidity } from "@/components/pools/your-liquidity";
import { usePortfolio } from "@/hooks/use-portfolio";
import { useWalletStatus } from "@/hooks/use-wallet-status";
import { poolixConfig } from "@/config/poolix";
import { TokenIcon } from "@/components/token/token-icon";
import { copy } from "@/lib/copy";
import { formatPrice, formatTokenAmount, truncateAddress } from "@/lib/format";

export function Portfolio() {
  const wallet = useWalletStatus();
  const portfolio = usePortfolio(wallet.address);
  const native = poolixConfig.chain.nativeCurrency.symbol;

  if (!wallet.mounted) {
    return <Skeleton className="h-64 w-full rounded-poolix-lg" />;
  }

  // Nothing here exists without an account, so the page says that plainly rather than
  // rendering zeroes that would read as real balances.
  if (!wallet.isConnected) {
    return (
      <Card padding="none" className="px-5 py-16 text-center">
        <Wallet className="mx-auto size-6 text-subtle" aria-hidden="true" />
        <p className="mt-4 text-[15px] text-fg">{copy.errors.walletNotConnected.title}</p>
        <p className="mx-auto mt-2 max-w-sm text-[13px] leading-relaxed text-muted">
          {copy.errors.walletNotConnected.message}
        </p>
        <Button className="mt-5" onClick={wallet.connect} disabled={!wallet.hasWallet}>
          {wallet.hasWallet ? copy.wallet.connect : copy.wallet.unavailable}
        </Button>
      </Card>
    );
  }

  const data = portfolio.data;

  return (
    <div className="space-y-8">
      <MetricGrid columns={3}>
        <MetricCard
          label={`Portfolio value (${native})`}
          value={
            portfolio.isPending || data === undefined ? (
              <Skeleton className="h-5 w-24" />
            ) : (
              formatTokenAmount(formatUnits(data.totalWei, 18), { maximumFractionDigits: 6 })
            )
          }
          hint={
            data?.partial ? "Partial: some holdings have no pool to price them" : "Priced from pool reserves"
          }
        />
        <MetricCard
          label="Tokens held"
          value={
            portfolio.isPending || data === undefined ? <Skeleton className="h-5 w-10" /> : data.holdings.length
          }
          hint="From the tokens in your list"
        />
        <MetricCard
          label="Claimable fees"
          value={copy.data.unavailable}
          hint="v2 fees accrue into reserves, not as a claim"
        />
      </MetricGrid>

      <section>
        <h2 className="text-[15px] font-medium text-fg">Token balances</h2>
        <div className="mt-4">
          {portfolio.isPending ? (
            <Skeleton className="h-40 w-full rounded-poolix-lg" />
          ) : portfolio.isError || data === undefined ? (
            <Notice title={copy.errors.rpcUnavailable.title} tone="warning">
              {copy.errors.rpcUnavailable.message}
            </Notice>
          ) : data.holdings.length === 0 ? (
            <div className="rounded-poolix-lg border border-line bg-surface px-5 py-12 text-center">
              <p className="text-[14px] text-fg">No balances found.</p>
              <p className="mx-auto mt-1.5 max-w-sm text-[12.5px] leading-relaxed text-muted">
                Poolix checks the tokens in your list. Import a token on the{" "}
                <Link href="/swap" className="text-accent-text hover:underline">
                  swap
                </Link>{" "}
                screen to include it here.
              </p>
            </div>
          ) : (
            <div className="overflow-hidden rounded-poolix-lg border border-line">
              {data.holdings.map((row) => (
                <div
                  key={row.currency.kind === "erc20" ? row.currency.address : "native"}
                  className="flex items-center gap-4 border-b border-line bg-surface px-4 py-3.5 last:border-0"
                >
                  <TokenIcon
                    address={row.currency.kind === "erc20" ? row.currency.address : null}
                    symbol={row.currency.symbol}
                    size={32}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px] text-fg">{row.currency.symbol}</span>
                    <span className="poolix-numeric block truncate text-[11.5px] text-subtle">
                      {row.currency.kind === "erc20"
                        ? truncateAddress(row.currency.address)
                        : "Native currency"}
                    </span>
                  </span>
                  <span className="text-right">
                    <span className="poolix-numeric block text-[13.5px] text-fg">
                      {formatTokenAmount(formatUnits(row.balance, row.currency.decimals), {
                        maximumFractionDigits: 6,
                      })}
                    </span>
                    <span className="poolix-numeric block text-[11.5px] text-subtle">
                      {row.valueWei === null
                        ? copy.data.unavailable
                        : `${formatTokenAmount(formatUnits(row.valueWei, 18), { maximumFractionDigits: 6 })} ${native}`}
                    </span>
                  </span>
                  {row.currency.kind === "erc20" ? (
                    <Link
                      href={`/token/${row.currency.address}`}
                      className="shrink-0 text-[12px] text-subtle transition-colors hover:text-accent-text"
                    >
                      View
                    </Link>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </div>
        {data?.holdings.some((row) => row.priceEth !== null && row.currency.kind === "erc20") ? (
          <p className="mt-3 text-[12px] text-subtle">
            Prices are mid prices from each token&rsquo;s {native} pool: {" "}
            {data.holdings
              .filter((row) => row.priceEth !== null && row.currency.kind === "erc20")
              .slice(0, 3)
              .map((row) => `1 ${row.currency.symbol} = ${formatPrice(row.priceEth)} ${native}`)
              .join(" · ")}
          </p>
        ) : null}
      </section>

      <section>
        <h2 className="text-[15px] font-medium text-fg">{copy.liquidity.yourLiquidity}</h2>
        <div className="mt-4">
          <YourLiquidity />
        </div>
      </section>

      <section>
        <h2 className="text-[15px] font-medium text-fg">{copy.nav.dashboard} data</h2>
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <Notice title="Recent transactions are not shown">
            A transaction history needs an index of past blocks. The public RPC rejects
            archive queries, so Poolix cannot build one and will not show a partial list that
            looks complete. Your wallet and the explorer both have it.
          </Notice>
          <Notice title="Why there are no claimable fees">
            Uniswap v2 does not accrue fees separately. Each swap leaves its fee in the pool&rsquo;s
            reserves, so a position&rsquo;s share is worth more over time rather than producing a
            balance to claim. Removing liquidity realises it.
          </Notice>
        </div>
      </section>
    </div>
  );
}
