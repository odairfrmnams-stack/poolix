"use client";

import { ExternalLink } from "lucide-react";
import { useState } from "react";
import { formatUnits, getAddress } from "viem";
import { useReadContract } from "wagmi";

import { AddLiquidity } from "@/components/pools/add-liquidity";
import { PairBadge } from "@/components/pools/pair-badge";
import { PoolAnalyticsPanel } from "@/components/pools/pool-analytics-panel";
import { RemoveLiquidity } from "@/components/pools/remove-liquidity";
import { Badge } from "@/components/ui/badge";
import { MetricCard, MetricGrid } from "@/components/ui/metric-card";
import { Notice } from "@/components/ui/notice";
import { Skeleton } from "@/components/ui/skeleton";
import { usePool } from "@/hooks/use-pool";
import { useWalletStatus } from "@/hooks/use-wallet-status";
import { poolixConfig } from "@/config/poolix";
import { copy } from "@/lib/copy";
import {
  explorerUrl,
  formatBps,
  formatNumber,
  formatTokenAmount,
  formatUsd,
  truncateAddress,
} from "@/lib/format";
import { cn } from "@/lib/utils";
import { uniswapV2PairAbi } from "@/services/abis/uniswap-v2";
import { centsToNumber, usdCentsFrom } from "@/services/analytics/tvl-math";
import type { Currency } from "@/services/liquidity/types";
import {
  ethLiquidityOf,
  poolPrice,
  wethSideOf,
  type WethSide,
} from "@/services/pools/pool-analytics-math";
import type { PoolAnalyticsResult } from "@/services/pools/pool-analytics-view";
import { readPosition, type PoolState } from "@/services/pools/pool";

type Tab = "add" | "remove";

export function PoolDetail({
  address,
  analytics,
}: {
  address: string;
  analytics: PoolAnalyticsResult;
}) {
  const [tab, setTab] = useState<Tab>("add");
  const [useNative, setUseNative] = useState(true);

  const wallet = useWalletStatus();
  const pool = usePool(address);

  const lpBalance = useReadContract({
    address: pool.data?.address,
    abi: uniswapV2PairAbi,
    functionName: "balanceOf",
    args: wallet.address ? [wallet.address] : undefined,
    query: { enabled: pool.data !== undefined && wallet.address !== undefined },
  });

  const router = poolixConfig.contracts.uniswapV2.router;

  if (pool.isPending) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-28 w-full rounded-poolix-lg" />
        <Skeleton className="h-96 w-full rounded-poolix-lg" />
      </div>
    );
  }

  if (pool.isError || pool.data === undefined) {
    return (
      <Notice title="Pool not found" tone="warning">
        {pool.error instanceof Error ? pool.error.message : copy.data.unavailableLong}
      </Notice>
    );
  }

  const state = pool.data;
  const balance = lpBalance.data ?? 0n;
  const position = readPosition(state, balance);
  const native = poolixConfig.chain.nativeCurrency.symbol;

  const { currency0, currency1, hasNativeSide } = displayCurrencies(state, useNative);

  /*
    The WETH side is decided from the pair's own token addresses, not taken from the
    indexer. The two agree, but the price shown here is derived from the reserves shown
    right beside it, and both must come from the same read or they can disagree on screen.
  */
  const side = wethSideOf(addressOf(state.token0), addressOf(state.token1), poolixConfig.contracts.weth);
  const reserves = { reserve0: state.reserve0, reserve1: state.reserve1 };
  const ethUsd = analytics.ethUsd;

  const ethLiquidity = ethLiquidityOf(reserves, side);
  const liquidityCents =
    ethLiquidity === null || ethUsd === null
      ? null
      : usdCentsFrom(ethLiquidity, BigInt(ethUsd.answer), ethUsd.decimals);

  const otherToken = side === "token0" ? state.token1 : side === "token1" ? state.token0 : null;
  const price =
    otherToken === null
      ? null
      : poolPrice(
          reserves,
          side,
          otherToken.decimals,
          ethUsd === null ? null : { answer: BigInt(ethUsd.answer), decimals: ethUsd.decimals },
        );

  // The 24H figures in the header come from the indexed history, so they are the same
  // numbers the panel below shows for its 24H frame — never a second measurement.
  const day = analytics.status === "ready" ? analytics.pool.timeframes["24H"] : null;

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <PairBadge
            symbol0={state.token0.symbol}
            symbol1={state.token1.symbol}
            address0={state.token0.kind === "erc20" ? state.token0.address : null}
            address1={state.token1.kind === "erc20" ? state.token1.address : null}
            className="text-xl font-semibold tracking-[-0.02em]"
          />
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <a
              href={explorerUrl(poolixConfig.explorerUrl, "address", state.address)}
              target="_blank"
              rel="noreferrer noopener"
              className="poolix-numeric inline-flex items-center gap-1.5 text-[12.5px] text-subtle transition-colors hover:text-fg"
            >
              {truncateAddress(state.address)}
              <ExternalLink className="size-3" aria-hidden="true" />
            </a>
            {analytics.status === "ready" && analytics.pool.creation !== null ? (
              <span className="text-[12.5px] text-subtle">
                Created {formatUtcDate(analytics.pool.creation.timestamp)}
              </span>
            ) : null}
          </div>
        </div>
        <span className="inline-flex h-7 items-center rounded-full border border-line px-2.5 text-[11.5px] text-subtle">
          Uniswap v2 · 0.30% fee
        </span>
      </div>

      <MetricGrid>
        <MetricCard
          label={copy.poolData.tvl}
          value={liquidityCents === null ? copy.data.unavailable : formatUsd(centsToNumber(liquidityCents))}
          hint={
            ethLiquidity === null
              ? "Not a WETH pair, so it has no ETH-denominated value"
              : ethUsd === null
                ? "ETH/USD feed unavailable or stale"
                : `Live ${native} liquidity × ${ethUsd.description}`
          }
          tip={{ label: copy.tooltips.tvl.title, body: copy.tooltips.tvl.body }}
        />
        <MetricCard
          label={copy.poolData.volume24h}
          value={
            day !== null && day.volumeComplete
              ? `${formatTokenAmount(formatUnits(BigInt(day.volumeWei), 18), { maximumFractionDigits: 4 })} ${native}`
              : copy.data.unavailable
          }
          hint={dayHint(analytics, day?.volumeComplete ?? false, day?.bucketsPresent, day?.bucketsExpected)}
        />
        <MetricCard
          label={copy.poolData.fees24h}
          value={
            day !== null && day.volumeComplete
              ? `${formatTokenAmount(formatUnits(BigInt(day.feesWei), 18), { maximumFractionDigits: 6 })} ${native}`
              : copy.data.unavailable
          }
          hint={
            day !== null && day.volumeComplete
              ? "0.30% of this pool's 24-hour volume"
              : dayHint(analytics, false, day?.bucketsPresent, day?.bucketsExpected)
          }
        />
        <MetricCard
          label={copy.liquidity.poolShare}
          value={wallet.isConnected ? formatBps(position.shareBps) : copy.data.unavailable}
          hint={wallet.isConnected ? "Your share of the pool" : "Connect your wallet"}
        />
      </MetricGrid>

      {/* Price sits directly under the reserves it is derived from. There is no second
          source: without a verified ETH/USD round the USD column simply is not shown. */}
      {price !== null && otherToken !== null ? (
        <MetricGrid columns={2}>
          <MetricCard
            label={`${otherToken.symbol} price (${native})`}
            value={
              price.tokenInWethWei === null
                ? copy.data.unavailable
                : formatTokenAmount(formatUnits(price.tokenInWethWei, 18), {
                    maximumFractionDigits: 8,
                  })
            }
            hint="Spot ratio of the live reserves, before fees and slippage"
          />
          <MetricCard
            label={`${otherToken.symbol} price (USD)`}
            value={
              price.usdCents === null
                ? copy.data.unavailable
                : // A token worth a fraction of a cent rounds to $0.00, which reads as
                  // worthless rather than as small. The bound says which one it is.
                  price.usdCents === 0n && (price.tokenInWethWei ?? 0n) > 0n
                  ? "<$0.01"
                  : formatUsd(centsToNumber(price.usdCents))
            }
            hint={
              price.usdCents === null
                ? "Needs a fresh ETH/USD round"
                : `Spot ratio × ${ethUsd?.description ?? "ETH/USD"}`
            }
          />
        </MetricGrid>
      ) : null}

      {analytics.status === "ready" ? (
        <PoolAnalyticsPanel
          view={analytics.pool}
          nativeSymbol={native}
          unavailableLabel={copy.data.unavailable}
        />
      ) : (
        <Notice
          title={
            analytics.status === "out-of-scope"
              ? "This pool is outside the scanned universe"
              : "Pool history is not available yet"
          }
        >
          {analytics.status === "out-of-scope" ? (
            <>
              Poolix indexes history for the pools it has scanned, and this pair is not one of
              them yet. Its reserves, supply and your position are still read live from the pair
              contract below. Volume, fees and APR read {copy.data.unavailable} rather than being
              estimated from a partial view.
            </>
          ) : (
            <>
              Historical ingestion has not produced anything for this chain yet, so per-pool
              volume, liquidity and APR read {copy.data.unavailable}. Everything below is read
              live from the pair contract and is unaffected.
            </>
          )}
        </Notice>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_1.1fr]">
        <div className="space-y-6">
          <section className="rounded-poolix-lg border border-line bg-surface">
            <h2 className="border-b border-line px-5 py-3.5 text-[14px] font-medium text-fg">
              {copy.liquidity.poolReserves}
            </h2>
            <dl className="divide-y divide-line">
              <ReserveRow token={state.token0} amount={state.reserve0} />
              <ReserveRow token={state.token1} amount={state.reserve1} />
              <div className="flex items-center justify-between px-5 py-3.5 text-[13px]">
                <dt className="text-muted">LP token supply</dt>
                <dd className="poolix-numeric text-fg">
                  {formatTokenAmount(formatUnits(state.totalSupply, 18), { maximumFractionDigits: 6 })}
                </dd>
              </div>
            </dl>
          </section>

          <PoolInformation state={state} side={side} analytics={analytics} />

          <section className="rounded-poolix-lg border border-line bg-surface">
            <h2 className="border-b border-line px-5 py-3.5 text-[14px] font-medium text-fg">
              {copy.liquidity.yourLiquidity}
            </h2>
            {!wallet.isConnected ? (
              <p className="px-5 py-6 text-[13px] text-muted">{copy.errors.walletNotConnected.message}</p>
            ) : balance === 0n ? (
              <p className="px-5 py-6 text-[13px] text-muted">{copy.empty.positions.title}</p>
            ) : (
              <dl className="divide-y divide-line">
                <div className="flex items-center justify-between px-5 py-3.5 text-[13px]">
                  <dt className="text-muted">LP tokens</dt>
                  <dd className="poolix-numeric text-fg">
                    {formatTokenAmount(formatUnits(balance, 18), { maximumFractionDigits: 6 })}
                  </dd>
                </div>
                <ReserveRow token={state.token0} amount={position.amount0} label="Pooled" />
                <ReserveRow token={state.token1} amount={position.amount1} label="Pooled" />
              </dl>
            )}
          </section>

          <Notice title="What this page measures">
            Reserves, supply, price and your position are read from the pair contract on every
            refresh. {copy.poolData.volume24h}, {copy.poolData.fees24h} and{" "}
            {copy.poolData.apr} are summed from this pool&rsquo;s own Uniswap v2 Swap events
            over exact clock hours, and its liquidity is reconstructed from its own Sync events
            — so no figure here borrows another pool&rsquo;s activity. An hour that was never
            ingested is reported as missing rather than counted as zero, which is why a window
            with a hole reads {copy.data.unavailable} instead of a smaller number.
          </Notice>
        </div>

        <section className="rounded-poolix-lg border border-line bg-surface p-4">
          <div className="mb-4 flex gap-1 rounded-poolix border border-line bg-canvas p-1">
            {(["add", "remove"] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setTab(value)}
                className={cn(
                  "h-9 flex-1 rounded-[7px] text-[13px] font-medium transition-colors",
                  tab === value ? "bg-raised text-fg" : "text-muted hover:text-fg",
                )}
              >
                {value === "add" ? copy.liquidity.addLiquidity : copy.liquidity.removeLiquidity}
              </button>
            ))}
          </div>

          {hasNativeSide ? (
            <label className="mb-3 flex items-center gap-2.5 px-1 text-[12.5px] text-muted">
              <input
                type="checkbox"
                checked={useNative}
                onChange={(event) => setUseNative(event.target.checked)}
                className="size-3.5 accent-[var(--poolix-accent)]"
              />
              Use {poolixConfig.chain.nativeCurrency.symbol} instead of WETH
            </label>
          ) : null}

          {router.status !== "configured" ? (
            <Notice title={copy.status.contractNotConfigured} tone="warning">
              {copy.errors.contractNotConfigured.message}
            </Notice>
          ) : tab === "add" ? (
            <AddLiquidity
              pool={state}
              currencyA={currency0}
              currencyB={currency1}
              router={router.address}
              onCompleted={() => {
                void pool.refetch();
                void lpBalance.refetch();
              }}
            />
          ) : (
            <RemoveLiquidity
              pool={state}
              balance={balance}
              currency0={currency0}
              currency1={currency1}
              router={router.address}
              onCompleted={() => {
                void pool.refetch();
                void lpBalance.refetch();
              }}
            />
          )}
        </section>
      </div>
    </div>
  );
}

/**
 * The pool's own facts: what it is, what it holds and when it came into existence.
 *
 * Creation is shown only when it came from the factory's PairCreated event. A pool's
 * first trade is not its creation, and reporting one as the other would be a fabrication
 * dressed as a detail — so an unresolved creation reads as unavailable.
 */
function PoolInformation({
  state,
  side,
  analytics,
}: {
  state: PoolState;
  side: WethSide;
  analytics: PoolAnalyticsResult;
}) {
  const factory = poolixConfig.contracts.uniswapV2.factory;
  const creation = analytics.status === "ready" ? analytics.pool.creation : null;
  const indexed = analytics.status === "ready" ? analytics.pool : null;

  return (
    <section className="rounded-poolix-lg border border-line bg-surface">
      <h2 className="border-b border-line px-5 py-3.5 text-[14px] font-medium text-fg">
        Pool information
      </h2>
      <dl className="divide-y divide-line">
        <InfoRow label="Pair address" value={<AddressLink address={state.address} />} />
        <InfoRow
          label={`Token 0 (${state.token0.symbol})`}
          value={<CurrencyLink token={state.token0} />}
        />
        <InfoRow
          label={`Token 1 (${state.token1.symbol})`}
          value={<CurrencyLink token={state.token1} />}
        />
        <InfoRow
          label="Factory"
          value={
            factory.status === "configured" ? (
              <AddressLink address={factory.address} />
            ) : (
              <span className="text-subtle">{copy.data.unavailable}</span>
            )
          }
        />
        <InfoRow label="Fee tier" value={<span>0.30% of every swap</span>} />
        <InfoRow
          label={`${poolixConfig.chain.nativeCurrency.symbol} side`}
          value={
            side === "none" ? (
              <span className="text-subtle">Token-to-token pair</span>
            ) : (
              <span>{side === "token0" ? state.token0.symbol : state.token1.symbol}</span>
            )
          }
        />
        <InfoRow
          label="Created"
          value={
            creation === null ? (
              <span className="text-subtle">{copy.data.unavailable}</span>
            ) : (
              <span className="flex flex-wrap items-center justify-end gap-2">
                {formatUtcDate(creation.timestamp)}
                <span className="text-subtle">
                  block {formatNumber(creation.blockNumber, { maximumFractionDigits: 0 })}
                </span>
                {creation.fromPairCreated ? (
                  <Badge tone="neutral" size="sm">
                    PairCreated
                  </Badge>
                ) : null}
              </span>
            )
          }
        />
        <InfoRow
          label="Swaps indexed"
          value={
            indexed === null ? (
              <span className="text-subtle">{copy.data.unavailable}</span>
            ) : (
              <span>{formatNumber(indexed.swapsIndexed, { maximumFractionDigits: 0 })}</span>
            )
          }
        />
        <InfoRow
          label="Transactions indexed"
          value={
            indexed === null ? (
              <span className="text-subtle">{copy.data.unavailable}</span>
            ) : (
              <span>{formatNumber(indexed.transactionsIndexed, { maximumFractionDigits: 0 })}</span>
            )
          }
        />
      </dl>
    </section>
  );
}

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 px-5 py-3.5 text-[13px]">
      <dt className="shrink-0 text-muted">{label}</dt>
      <dd className="poolix-numeric min-w-0 text-right text-fg">{value}</dd>
    </div>
  );
}

function AddressLink({ address }: { address: string }) {
  return (
    <a
      href={explorerUrl(poolixConfig.explorerUrl, "address", address)}
      target="_blank"
      rel="noreferrer noopener"
      className="inline-flex items-center gap-1.5 transition-colors hover:text-accent"
    >
      {truncateAddress(address)}
      <ExternalLink className="size-3 shrink-0" aria-hidden="true" />
    </a>
  );
}

function CurrencyLink({ token }: { token: Currency }) {
  if (token.kind !== "erc20") return <span>{token.symbol}</span>;
  return <AddressLink address={token.address} />;
}

/** UTC throughout, because every window on this page is defined in UTC hours. */
function formatUtcDate(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  return `${date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  })} ${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")} UTC`;
}

function addressOf(token: Currency): string {
  return token.kind === "erc20" ? token.address : poolixConfig.contracts.weth;
}

/** Says why a 24-hour figure is missing, rather than leaving "--" unexplained. */
function dayHint(
  analytics: PoolAnalyticsResult,
  complete: boolean,
  present?: number,
  expected?: number,
): string {
  if (analytics.status === "out-of-scope") return "Outside the scanned pool universe";
  if (analytics.status === "unavailable") return "Needs indexed swap history";
  if (complete) return "Last 24 clock hours, this pool only";
  if (present !== undefined && expected !== undefined) {
    return `Building: ${present} of ${expected} hours ingested`;
  }
  return "Needs indexed swap history";
}

/**
 * The pair always holds WETH, but depositing and withdrawing ETH directly is what most
 * people want, so a WETH side is presented as the native currency unless turned off.
 */
function displayCurrencies(
  pool: PoolState,
  useNative: boolean,
): { currency0: Currency; currency1: Currency; hasNativeSide: boolean } {
  const weth = getAddress(poolixConfig.contracts.weth);
  const native: Currency = {
    kind: "native",
    symbol: poolixConfig.chain.nativeCurrency.symbol,
    decimals: poolixConfig.chain.nativeCurrency.decimals,
  };

  const isWeth = (token: Currency) => token.kind === "erc20" && getAddress(token.address) === weth;
  const hasNativeSide = isWeth(pool.token0) || isWeth(pool.token1);

  return {
    currency0: useNative && isWeth(pool.token0) ? native : pool.token0,
    currency1: useNative && isWeth(pool.token1) ? native : pool.token1,
    hasNativeSide,
  };
}

function ReserveRow({
  token,
  amount,
  label,
}: {
  token: Currency;
  amount: bigint;
  label?: string;
}) {
  return (
    <div className="flex items-center justify-between px-5 py-3.5 text-[13px]">
      <dt className="text-muted">{label ? `${label} ${token.symbol}` : token.symbol}</dt>
      <dd className="poolix-numeric text-fg">
        {formatTokenAmount(formatUnits(amount, token.decimals), { maximumFractionDigits: 6 })}
      </dd>
    </div>
  );
}
