"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Check, Copy, ExternalLink } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { formatUnits, getAddress, type PublicClient } from "viem";
import { usePublicClient } from "wagmi";

import { PairBadge } from "@/components/pools/pair-badge";
import { TokenIcon } from "@/components/token/token-icon";
import { Notice } from "@/components/ui/notice";
import { Skeleton } from "@/components/ui/skeleton";
import { Stat, StatCell, StatGrid } from "@/components/ui/stat";
import { poolixConfig } from "@/config/poolix";
import { copy } from "@/lib/copy";
import { explorerUrl, formatPrice, formatTokenAmount, truncateAddress } from "@/lib/format";
import type { Currency } from "@/services/liquidity/types";
import { fetchPoolForPair, type PoolState } from "@/services/pools/pool";
import { midPrice, poolValueInQuote } from "@/services/pools/pricing";
import { fetchTokenMetadata } from "@/services/tokens/metadata";
import type { Address } from "@/types/web3";

interface TokenView {
  readonly token: Currency;
  readonly pool: PoolState | null;
}

export function TokenDetail({ address }: { address: string }) {
  const client = usePublicClient();
  const { weth, uniswapV2 } = poolixConfig.contracts;
  const native = poolixConfig.chain.nativeCurrency.symbol;
  const factory = uniswapV2.factory.status === "configured" ? uniswapV2.factory.address : null;

  const query = useQuery<TokenView>({
    queryKey: ["token-detail", address],
    enabled: client !== undefined,
    retry: 0,
    staleTime: 15_000,
    queryFn: async () => {
      const publicClient = client as PublicClient;
      const token = await fetchTokenMetadata(publicClient, address);
      if (token.kind !== "erc20" || factory === null) return { token, pool: null };

      // The token's own pool against WETH: the pair Poolix can price it from.
      const pool =
        getAddress(token.address) === getAddress(weth)
          ? null
          : await fetchPoolForPair(publicClient, factory, weth, token.address).catch(() => null);

      return { token, pool };
    },
  });

  if (query.isPending) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-72" />
        <Skeleton className="h-28 w-full rounded-poolix-lg" />
        <Skeleton className="h-64 w-full rounded-poolix-lg" />
      </div>
    );
  }

  if (query.isError || query.data === undefined) {
    return (
      <Notice title={copy.empty.tokens.title} tone="warning">
        {query.error instanceof Error ? query.error.message : copy.data.unavailableLong}
      </Notice>
    );
  }

  const { token, pool } = query.data;
  const tokenAddress = token.kind === "erc20" ? getAddress(token.address) : null;

  const reserves =
    pool === null || tokenAddress === null
      ? null
      : pool.token0.kind === "erc20" && getAddress(pool.token0.address) === tokenAddress
        ? { token: pool.reserve0, weth: pool.reserve1 }
        : { token: pool.reserve1, weth: pool.reserve0 };

  const price = reserves === null ? null : midPrice(reserves.token, token.decimals, reserves.weth, 18);
  const liquidity = reserves === null ? null : poolValueInQuote(reserves.weth);

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <TokenIcon address={tokenAddress} symbol={token.symbol} size={40} />
            <div className="min-w-0">
              <h1 className="truncate text-2xl font-semibold tracking-[-0.02em]">{token.symbol}</h1>
              {token.kind === "erc20" ? (
                <p className="truncate text-[13px] text-muted">{token.name}</p>
              ) : null}
            </div>
          </div>
          {tokenAddress !== null ? <AddressRow address={tokenAddress} /> : null}
        </div>

        <div className="flex shrink-0 gap-2">
          <Link
            href="/swap"
            className="inline-flex h-9 items-center gap-1.5 rounded-poolix bg-accent px-3.5 text-[13px] font-medium text-canvas transition-colors hover:bg-accent-hover"
          >
            {copy.swap.swap}
            <ArrowRight className="size-3.5" aria-hidden="true" />
          </Link>
          {pool !== null ? (
            <Link
              href={`/pools/${pool.address}`}
              className="inline-flex h-9 items-center rounded-poolix border border-line px-3.5 text-[13px] text-muted transition-colors hover:border-line-strong hover:text-fg"
            >
              {copy.liquidity.addLiquidity}
            </Link>
          ) : null}
        </div>
      </div>

      <StatGrid>
        <StatCell>
          <Stat
            label={`${copy.tokens.price} (${native})`}
            value={formatPrice(price)}
            hint={pool === null ? "No pool to price from" : "Mid price from pool reserves"}
          />
        </StatCell>
        <StatCell>
          <Stat
            label={copy.tokens.liquidity}
            value={
              liquidity === null
                ? copy.data.unavailable
                : `${formatTokenAmount(formatUnits(liquidity, 18), { maximumFractionDigits: 4 })} ${native}`
            }
            hint={`Both sides of the ${native} pool`}
          />
        </StatCell>
        <StatCell>
          <Stat label={copy.tokens.volume} value={copy.data.unavailable} hint="Needs swap history" />
        </StatCell>
        <StatCell>
          <Stat label={copy.tokens.holders} value={copy.data.unavailable} hint="Needs a transfer index" />
        </StatCell>
      </StatGrid>

      <section className="rounded-poolix-lg border border-line bg-surface">
        <h2 className="border-b border-line px-5 py-3.5 text-[14px] font-medium text-fg">{copy.tokens.pools}</h2>
        {pool === null ? (
          <p className="px-5 py-8 text-[13px] text-muted">
            {copy.empty.pools.title} This token has no pool against {native} on{" "}
            {poolixConfig.chain.name}.
          </p>
        ) : (
          <Link
            href={`/pools/${pool.address}`}
            className="flex items-center gap-4 px-5 py-4 transition-colors hover:bg-raised"
          >
            <PairBadge
              symbol0={pool.token0.symbol}
              symbol1={pool.token1.symbol}
              address0={pool.token0.kind === "erc20" ? pool.token0.address : null}
              address1={pool.token1.kind === "erc20" ? pool.token1.address : null}
              className="min-w-0 flex-1 text-[13.5px]"
            />
            <div className="text-right">
              <p className="text-[11px] tracking-wide text-subtle uppercase">{copy.liquidity.poolReserves}</p>
              <p className="poolix-numeric mt-1 text-[12.5px] text-fg">
                {formatTokenAmount(formatUnits(pool.reserve0, pool.token0.decimals), { maximumFractionDigits: 3 })}{" "}
                {pool.token0.symbol}
              </p>
              <p className="poolix-numeric text-[12px] text-muted">
                {formatTokenAmount(formatUnits(pool.reserve1, pool.token1.decimals), { maximumFractionDigits: 3 })}{" "}
                {pool.token1.symbol}
              </p>
            </div>
            <ArrowRight className="size-4 shrink-0 text-subtle" aria-hidden="true" />
          </Link>
        )}
      </section>

      <Notice title="Poolix does not verify tokens" tone="warning">
        Anyone can deploy a token using any name or symbol. Everything above is read from the
        contract at this address and from its pool; none of it implies the project is
        legitimate. Check the source on the explorer before trading.
      </Notice>
    </div>
  );
}

function AddressRow({ address }: { address: Address }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  return (
    <div className="mt-3 flex items-center gap-2">
      <span className="poolix-numeric text-[12.5px] text-subtle">{truncateAddress(address)}</span>
      <button
        type="button"
        onClick={() => void navigator.clipboard?.writeText(address).then(() => setCopied(true))}
        aria-label={copy.wallet.copyAddress}
        className="text-subtle transition-colors hover:text-fg"
      >
        {copied ? (
          <Check className="size-3.5 text-accent-text" aria-hidden="true" />
        ) : (
          <Copy className="size-3.5" aria-hidden="true" />
        )}
      </button>
      <a
        href={explorerUrl(poolixConfig.explorerUrl, "token", address)}
        target="_blank"
        rel="noreferrer noopener"
        className="text-subtle transition-colors hover:text-fg"
        aria-label={copy.wallet.viewOnExplorer}
      >
        <ExternalLink className="size-3.5" aria-hidden="true" />
      </a>
    </div>
  );
}
