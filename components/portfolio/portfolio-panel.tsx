"use client";

import { motion, useReducedMotion } from "motion/react";
import { ExternalLink, RefreshCw, Wallet } from "lucide-react";
import Link from "next/link";
import { formatUnits } from "viem";

import { PairBadge } from "@/components/pools/pair-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DataTable, type Column } from "@/components/ui/data-table";
import { MetricCard, MetricGrid } from "@/components/ui/metric-card";
import { Notice } from "@/components/ui/notice";
import { Skeleton } from "@/components/ui/skeleton";
import { usePortfolioView } from "@/hooks/use-portfolio-view";
import { useWalletStatus } from "@/hooks/use-wallet-status";
import { poolixConfig } from "@/config/poolix";
import { copy } from "@/lib/copy";
import { explorerUrl, formatNumber, formatTokenAmount, formatUsd, truncateAddress } from "@/lib/format";
import { cn } from "@/lib/utils";
import type {
  LpPositionView,
  PortfolioScope,
  TokenHoldingView,
} from "@/services/portfolio/portfolio-view";

/*
  The connected wallet's holdings.

  Two things this refuses to do. It never shows a zero where it means "unknown" — an
  unpriceable asset reads "--" and is excluded from the total, which is then labelled
  partial rather than presented as the portfolio's worth. And it never claims to have found
  every position: the pool universe is Poolix's scanned window, and the page says so.

  It also does not claim LP fee earnings. Fees accrue into the pool's reserves and a
  holder's share of them, so they are already inside the underlying amounts shown — but
  attributing a figure to one holder needs position history Poolix does not keep, and a
  number invented for that would be indistinguishable from a real one.
*/

const DASH = copy.data.unavailable;

const amount = (wei: string, decimals: number, digits = 6) =>
  formatTokenAmount(formatUnits(BigInt(wei), decimals), { maximumFractionDigits: digits });

const usd = (cents: string | null) => {
  if (cents === null) return DASH;
  const value = BigInt(cents);
  // A holding worth a fraction of a cent is small, not worthless.
  if (value === 0n) return "<$0.01";
  return formatUsd(Number(value) / 100);
};

export function PortfolioPanel({ scope }: { scope: PortfolioScope }) {
  const wallet = useWalletStatus();
  const reduceMotion = useReducedMotion();
  const portfolio = usePortfolioView(scope, wallet.address);

  if (!wallet.mounted) {
    return <Skeleton className="h-64 w-full rounded-poolix-lg" />;
  }

  // Nothing here exists without an account, so the page says that rather than rendering
  // zeroes that would read as real balances.
  if (!wallet.isConnected) {
    return (
      <Card padding="none" className="px-5 py-16 text-center">
        <Wallet className="mx-auto size-6 text-subtle" aria-hidden="true" />
        <p className="mt-4 text-[15px] text-fg">Connect wallet to view your portfolio.</p>
        <p className="mx-auto mt-2 max-w-sm text-[13px] leading-relaxed text-muted">
          {copy.errors.walletNotConnected.message}
        </p>
        <Button className="mt-5" onClick={wallet.connect} disabled={!wallet.hasWallet}>
          {wallet.hasWallet ? copy.wallet.connect : copy.wallet.unavailable}
        </Button>
      </Card>
    );
  }

  if (wallet.wrongNetwork) {
    return (
      <Notice title="Wrong network" tone="warning">
        This portfolio reads {poolixConfig.chain.name} (chain {poolixConfig.chain.id}). Switch
        networks to see your balances.
        <Button className="mt-4" onClick={wallet.switchToPoolix} disabled={wallet.isSwitching}>
          Switch to {poolixConfig.chain.name}
        </Button>
      </Notice>
    );
  }

  if (!scope.available) {
    return (
      <Notice title="Pool universe unavailable" tone="warning">
        Poolix could not read the factory, so it has no set of pools to check your balances
        against. Nothing is shown rather than an empty portfolio that would read as
        &ldquo;you hold nothing&rdquo;.
      </Notice>
    );
  }

  if (portfolio.isPending) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-24 w-full rounded-poolix-lg" />
        <Skeleton className="h-48 w-full rounded-poolix-lg" />
        <Skeleton className="h-48 w-full rounded-poolix-lg" />
      </div>
    );
  }

  if (portfolio.isError || portfolio.data === undefined) {
    return (
      <Notice title="Could not read your balances" tone="warning">
        The endpoint did not answer. Your holdings are unchanged; this is a read failure, not
        an empty portfolio.
        <Button className="mt-4" onClick={() => void portfolio.refetch()}>
          Try again
        </Button>
      </Notice>
    );
  }

  const data = portfolio.data;
  const empty = data.tokens.length === 0 && data.positions.length === 0;

  return (
    <motion.div
      initial={reduceMotion ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
      className="space-y-8"
    >
      {/* ------------------------------------------------------------- header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-[12px] uppercase tracking-[0.07em] text-subtle">Wallet</span>
          <a
            href={explorerUrl(poolixConfig.explorerUrl, "address", wallet.address ?? "")}
            target="_blank"
            rel="noreferrer noopener"
            className="poolix-numeric inline-flex items-center gap-1.5 text-[13px] text-fg transition-colors hover:text-accent"
          >
            {truncateAddress(wallet.address ?? "")}
            <ExternalLink className="size-3" aria-hidden="true" />
          </a>
        </div>

        <div className="flex items-center gap-3">
          {/* The block is a reference point, not a snapshot: the reads land over a short
              span and the chain moves under them. */}
          <span className="text-[11.5px] text-subtle">
            {data.blockNumber === null
              ? "Block unavailable"
              : `Read around block ${formatNumber(data.blockNumber, { maximumFractionDigits: 0 })}`}
          </span>
          <Button
            variant="secondary"
            onClick={() => void portfolio.refetch()}
            disabled={portfolio.isFetching}
            className="h-8 px-3 text-[12.5px]"
          >
            <RefreshCw
              className={cn("size-3.5", portfolio.isFetching ? "animate-spin" : "")}
              aria-hidden="true"
            />
            Refresh
          </Button>
        </div>
      </div>

      {/* ----------------------------------------------------------- overview */}
      <MetricGrid columns={3}>
        <MetricCard
          label="Total value"
          value={usd(data.totals.usdCents)}
          hint={
            data.totals.usdCents === null
              ? "No holding has a validated USD price"
              : data.totals.complete
                ? `Across ${data.totals.valued} valued holding${data.totals.valued === 1 ? "" : "s"}`
                : `Partial valuation — ${data.totals.unvalued} holding${data.totals.unvalued === 1 ? "" : "s"} could not be priced and are excluded`
          }
          aside={
            data.totals.complete ? null : (
              <Badge tone="warning" size="sm">
                Partial
              </Badge>
            )
          }
        />
        <MetricCard
          label="Token assets"
          value={formatNumber(data.tokens.length, { maximumFractionDigits: 0 })}
          hint="Non-zero balances in the scanned universe"
        />
        <MetricCard
          label="LP positions"
          value={formatNumber(data.positions.length, { maximumFractionDigits: 0 })}
          hint="Uniswap v2 pairs where you hold LP tokens"
        />
      </MetricGrid>

      {data.failedReads > 0 ? (
        <Notice title="Some reads did not answer" tone="warning">
          {data.failedReads} read{data.failedReads === 1 ? "" : "s"} failed, so this view may be
          missing holdings. Nothing shown is affected — a failed read is skipped, never counted
          as a zero balance.
        </Notice>
      ) : null}

      {empty ? (
        <Card padding="none" className="px-5 py-14 text-center">
          <p className="text-[15px] text-fg">No holdings found in the scanned universe.</p>
          <p className="mx-auto mt-2 max-w-md text-[13px] leading-relaxed text-muted">
            This account holds no balance in the {scope.poolsScanned} pools and{" "}
            {scope.tokens.length} tokens Poolix currently tracks. It may still hold assets
            outside that set — see the scope note below.
          </p>
        </Card>
      ) : null}

      {/* ------------------------------------------------------------- tokens */}
      {data.tokens.length > 0 ? <TokenTable rows={data.tokens} scope={scope} /> : null}

      {/* ---------------------------------------------------------- positions */}
      {data.positions.length > 0 ? <PositionList rows={data.positions} scope={scope} /> : null}

      {/* -------------------------------------------------------------- scope */}
      <div className="space-y-3 rounded-poolix-lg border border-line bg-surface/60 px-4 py-4 text-[12.5px] leading-relaxed text-muted">
        <div>
          <p className="text-[12px] font-medium text-fg">What this page covers</p>
          <p className="mt-1">
            Balances are read from the pools Poolix has scanned — {scope.poolsScanned} of{" "}
            {scope.pairsTotal.toLocaleString("en-US")} pairs the factory has created
            {scope.scanComplete ? ", which covered the whole space" : ", a window rather than the whole space"}.
            An LP position in a pool outside that set will not appear here, and this is not a
            claim to have found every token or position the account holds.
          </p>
        </div>
        <div>
          <p className="text-[12px] font-medium text-fg">Valuation</p>
          <p className="mt-1">
            {scope.ethUsd === null
              ? `The ETH/USD feed is unavailable or stale, so no USD figure is shown at all.`
              : `USD comes from ${scope.ethUsd.description}, read fresh and rejected if the round is stale.`}{" "}
            A token is valued through the deepest pool holding it against W{scope.nativeSymbol}.
            A token-to-token LP position is listed but not valued: pricing it would need a rate
            for a third asset Poolix cannot verify, so it reads {DASH} rather than a guess.
          </p>
        </div>
        <div>
          <p className="text-[12px] font-medium text-fg">Fees and returns</p>
          <p className="mt-1">
            Trading fees accrue into the pool&rsquo;s reserves, so your share of them is already
            inside the underlying amounts above. Poolix does not attribute a fee figure to an
            individual position — that needs a record of every deposit and withdrawal over time,
            which this deployment does not keep. No profit, earnings or APR figure is shown for
            your position for that reason.
          </p>
        </div>
      </div>
    </motion.div>
  );
}

// ------------------------------------------------------------------ token table

function TokenTable({
  rows,
  scope,
}: {
  rows: readonly TokenHoldingView[];
  scope: PortfolioScope;
}) {
  const columns: readonly Column<TokenHoldingView>[] = [
    {
      key: "asset",
      header: "Asset",
      cell: (row) =>
        row.isNative ? (
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="text-[13px] text-fg">{row.symbol}</span>
            <span className="text-[11.5px] text-subtle">Native</span>
          </span>
        ) : (
          <Link href={`/token/${row.address}`} className="flex min-w-0 flex-col gap-0.5">
            <span className="flex items-center gap-1.5 text-[13px] text-fg">
              {/* Metadata that could not be read falls back to the address rather than
                  being invented. */}
              {row.metadataMissing ? truncateAddress(row.address) : row.symbol}
              {row.tracked ? (
                <Badge tone="neutral" size="sm">
                  Tracked
                </Badge>
              ) : null}
            </span>
            <span className="poolix-numeric text-[11.5px] text-subtle">
              {truncateAddress(row.address)}
            </span>
          </Link>
        ),
    },
    {
      key: "balance",
      align: "right",
      header: "Balance",
      cell: (row) => (
        <span className="poolix-numeric text-[13px]">{amount(row.balanceWei, row.decimals)}</span>
      ),
    },
    {
      key: "price",
      align: "right",
      hideBelow: "sm",
      header: `Value (${scope.nativeSymbol})`,
      cell: (row) => (
        <span className="poolix-numeric text-[13px]">
          {row.valueEthWei === null ? DASH : amount(row.valueEthWei, 18, 6)}
        </span>
      ),
    },
    {
      key: "value",
      align: "right",
      header: "Value",
      cell: (row) => <span className="poolix-numeric text-[13px]">{usd(row.valueUsdCents)}</span>,
    },
  ];

  return (
    <section className="min-w-0">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-[14px] font-medium text-fg">Tokens</h2>
        <span className="text-[11.5px] text-subtle">{rows.length} with a balance</span>
      </div>
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(row) => row.address}
        caption="Token balances for the connected wallet"
        empty="No token balances found."
      />
    </section>
  );
}

// --------------------------------------------------------------- LP positions

function PositionList({
  rows,
  scope,
}: {
  rows: readonly LpPositionView[];
  scope: PortfolioScope;
}) {
  return (
    <section className="min-w-0">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-[14px] font-medium text-fg">LP positions</h2>
        <span className="text-[11.5px] text-subtle">{rows.length} held</span>
      </div>

      {/* Cards rather than a table: a position carries two underlying amounts and a share,
          which a row squeezes into columns that stop being readable on a phone. */}
      <div className="grid gap-3 sm:grid-cols-2">
        {rows.map((row) => (
          <Link
            key={row.pairAddress}
            href={row.poolLink}
            className={cn(
              "group flex min-w-0 flex-col gap-4 rounded-poolix-lg border border-line bg-surface p-4",
              "transition-colors hover:border-line-strong",
            )}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <PairBadge
                  symbol0={row.token0Symbol}
                  symbol1={row.token1Symbol}
                  address0={row.token0Address}
                  address1={row.token1Address}
                  className="text-[14px]"
                />
                <p className="poolix-numeric mt-1 text-[11.5px] text-subtle">
                  {truncateAddress(row.pairAddress)}
                </p>
              </div>
              {row.wethSide === "none" ? (
                <Badge tone="warning" size="sm">
                  Not valued
                </Badge>
              ) : null}
            </div>

            <dl className="grid grid-cols-2 gap-x-3 gap-y-3">
              <Field label="LP tokens" value={amount(row.userLpBalance, 18)} />
              <Field label="Pool share" value={row.share ?? DASH} />
              <Field
                label={`Pooled ${row.token0Symbol}`}
                value={amount(row.userToken0Amount, row.token0Decimals)}
              />
              <Field
                label={`Pooled ${row.token1Symbol}`}
                value={amount(row.userToken1Amount, row.token1Decimals)}
              />
              <Field
                label={`Value (${scope.nativeSymbol})`}
                value={row.poolLiquidityEth === null ? DASH : amount(row.poolLiquidityEth, 18, 6)}
              />
              <Field label="Value" value={usd(row.valueUsdCents)} />
            </dl>

            {row.poolCreatedAt !== null ? (
              <p className="text-[11.5px] text-subtle">
                Pool created{" "}
                {new Date(row.poolCreatedAt * 1000).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                  timeZone: "UTC",
                })}
              </p>
            ) : null}
          </Link>
        ))}
      </div>
    </section>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10.5px] font-medium uppercase tracking-[0.07em] text-subtle">{label}</dt>
      <dd className="poolix-numeric mt-1 truncate text-[13px] text-fg">{value}</dd>
    </div>
  );
}
