"use client";

import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { formatUnits } from "viem";

import { PairBadge } from "@/components/pools/pair-badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useLpPositions } from "@/hooks/use-lp-positions";
import { useWalletStatus } from "@/hooks/use-wallet-status";
import { copy } from "@/lib/copy";
import { formatBps, formatTokenAmount } from "@/lib/format";

export function YourLiquidity() {
  const wallet = useWalletStatus();
  const positions = useLpPositions(wallet.address);

  if (!wallet.mounted) {
    return <Skeleton className="h-28 w-full rounded-poolix-lg" />;
  }

  if (!wallet.isConnected) {
    return (
      <EmptyPanel title={copy.errors.walletNotConnected.title} message={copy.errors.walletNotConnected.message}>
        <button
          type="button"
          onClick={wallet.connect}
          disabled={!wallet.hasWallet}
          className="mt-4 inline-flex h-9 items-center rounded-poolix bg-accent px-4 text-[13px] font-medium text-canvas transition-colors hover:bg-accent-hover disabled:opacity-45"
        >
          {wallet.hasWallet ? copy.wallet.connect : copy.wallet.unavailable}
        </button>
      </EmptyPanel>
    );
  }

  if (positions.isPending) {
    return <Skeleton className="h-28 w-full rounded-poolix-lg" />;
  }

  if (positions.data === undefined || positions.data.length === 0) {
    return (
      <EmptyPanel title={copy.empty.positions.title} message={copy.empty.positions.message}>
        <p className="mt-3 text-[12px] text-subtle">
          Poolix checks pools pairing ETH with the tokens in your list. Import a token to
          include its pool here.
        </p>
      </EmptyPanel>
    );
  }

  return (
    <div className="overflow-hidden rounded-poolix-lg border border-line">
      {positions.data.map(({ pool, position }) => (
        <Link
          key={pool.address}
          href={`/pools/${pool.address}`}
          className="flex items-center gap-4 border-b border-line bg-surface px-4 py-4 transition-colors last:border-0 hover:bg-raised"
        >
          <PairBadge
            symbol0={pool.token0.symbol}
            symbol1={pool.token1.symbol}
            address0={pool.token0.kind === "erc20" ? pool.token0.address : null}
            address1={pool.token1.kind === "erc20" ? pool.token1.address : null}
            className="min-w-0 flex-1 text-[13.5px]"
          />

          <div className="hidden text-right sm:block">
            <p className="text-[11px] tracking-wide text-subtle uppercase">{copy.liquidity.poolShare}</p>
            <p className="poolix-numeric mt-1 text-[13px] text-fg">{formatBps(position.shareBps)}</p>
          </div>

          <div className="text-right">
            <p className="text-[11px] tracking-wide text-subtle uppercase">Pooled</p>
            <p className="poolix-numeric mt-1 text-[13px] text-fg">
              {formatTokenAmount(formatUnits(position.amount0, pool.token0.decimals), { maximumFractionDigits: 4 })}{" "}
              {pool.token0.symbol}
            </p>
            <p className="poolix-numeric text-[12px] text-muted">
              {formatTokenAmount(formatUnits(position.amount1, pool.token1.decimals), { maximumFractionDigits: 4 })}{" "}
              {pool.token1.symbol}
            </p>
          </div>

          <ChevronRight className="size-4 shrink-0 text-subtle" aria-hidden="true" />
        </Link>
      ))}
    </div>
  );
}

function EmptyPanel({
  title,
  message,
  children,
}: {
  title: string;
  message: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="rounded-poolix-lg border border-line bg-surface px-5 py-10 text-center">
      <p className="text-[14px] text-fg">{title}</p>
      <p className="mx-auto mt-1.5 max-w-sm text-[12.5px] leading-relaxed text-muted">{message}</p>
      {children}
    </div>
  );
}
