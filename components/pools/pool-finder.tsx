"use client";

import { ArrowRight, ChevronDown, Plus } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { formatUnits } from "viem";

import { AddLiquidity } from "@/components/pools/add-liquidity";
import { PairBadge } from "@/components/pools/pair-badge";
import { TokenSelect } from "@/components/swap/token-select";
import { poolixConfig } from "@/config/poolix";
import { Skeleton } from "@/components/ui/skeleton";
import { usePoolForPair } from "@/hooks/use-pool";
import { copy } from "@/lib/copy";
import { formatTokenAmount, truncateAddress } from "@/lib/format";
import { DEFAULT_TOKENS } from "@/lib/token-storage";
import { cn } from "@/lib/utils";
import type { Currency } from "@/services/liquidity/types";
import { currencyId, sameCurrency } from "@/services/tokens/currency";

const [NATIVE_TOKEN] = DEFAULT_TOKENS;

/**
 * Resolves any pair to its pool without needing an index: the address is derived with
 * CREATE2 and then read from the chain.
 */
export function PoolFinder() {
  const [tokenA, setTokenA] = useState<Currency | null>(NATIVE_TOKEN ?? null);
  const [tokenB, setTokenB] = useState<Currency | null>(null);
  const [selecting, setSelecting] = useState<"a" | "b" | null>(null);
  const [creating, setCreating] = useState(false);

  const pool = usePoolForPair(tokenA, tokenB);
  const router = poolixConfig.contracts.uniswapV2.router;
  const ready = tokenA !== null && tokenB !== null && !sameCurrency(tokenA, tokenB);

  function handleSelect(currency: Currency) {
    if (selecting === "a") {
      if (tokenB && sameCurrency(currency, tokenB)) setTokenB(tokenA);
      setTokenA(currency);
    } else if (selecting === "b") {
      if (tokenA && sameCurrency(currency, tokenA)) setTokenA(tokenB);
      setTokenB(currency);
    }
  }

  return (
    <div className="rounded-poolix-lg border border-line bg-surface p-5">
      <h2 className="text-[14px] font-medium text-fg">Find a pool</h2>
      <p className="mt-1 text-[12.5px] leading-relaxed text-muted">
        Any pair, whether or not it appears in the list below.
      </p>

      <div className="mt-4 flex items-center gap-2">
        <TokenButton currency={tokenA} onClick={() => setSelecting("a")} />
        <Plus className="size-4 shrink-0 text-subtle" aria-hidden="true" />
        <TokenButton currency={tokenB} onClick={() => setSelecting("b")} />
      </div>

      <div className="mt-4">
        {!ready ? (
          <p className="text-[12.5px] text-subtle">Select two tokens to look up their pool.</p>
        ) : pool.isPending ? (
          <Skeleton className="h-16 w-full rounded-poolix" />
        ) : pool.isError ? (
          <p className="text-[12.5px] text-negative">{copy.errors.rpcUnavailable.message}</p>
        ) : pool.data === null || pool.data === undefined ? (
          <div className="rounded-poolix border border-line bg-canvas p-4">
            <p className="text-[13px] text-fg">No pool exists for this pair yet.</p>
            <p className="mt-1 text-[12.5px] text-muted">
              Adding liquidity creates it and sets the initial price.
            </p>
            {router.status === "configured" && tokenA && tokenB ? (
              <button
                type="button"
                onClick={() => setCreating((value) => !value)}
                className="mt-3 inline-flex items-center gap-1.5 text-[12.5px] text-accent-text transition-colors hover:text-accent"
              >
                {creating ? "Hide" : copy.liquidity.createPool}
                <ArrowRight className="size-3.5" aria-hidden="true" />
              </button>
            ) : null}

            {creating && router.status === "configured" && tokenA && tokenB ? (
              <div className="mt-4 border-t border-line pt-4">
                <AddLiquidity
                  pool={null}
                  currencyA={tokenA}
                  currencyB={tokenB}
                  router={router.address}
                  onCompleted={() => {
                    setCreating(false);
                    void pool.refetch();
                  }}
                />
              </div>
            ) : null}
          </div>
        ) : (
          <Link
            href={`/pools/${pool.data.address}`}
            className="flex items-center gap-4 rounded-poolix border border-line bg-canvas px-4 py-3.5 transition-colors hover:border-line-strong hover:bg-raised"
          >
            <div className="min-w-0 flex-1">
              <PairBadge
                symbol0={pool.data.token0.symbol}
                symbol1={pool.data.token1.symbol}
                address0={pool.data.token0.kind === "erc20" ? pool.data.token0.address : null}
                address1={pool.data.token1.kind === "erc20" ? pool.data.token1.address : null}
                className="text-[13.5px]"
              />
              <p className="poolix-numeric mt-1 pl-[46px] text-[11.5px] text-subtle">
                {truncateAddress(pool.data.address)}
              </p>
            </div>
            <div className="text-right">
              <p className="text-[11px] tracking-wide text-subtle uppercase">{copy.liquidity.poolReserves}</p>
              <p className="poolix-numeric mt-1 text-[12.5px] text-fg">
                {formatTokenAmount(formatUnits(pool.data.reserve0, pool.data.token0.decimals), {
                  maximumFractionDigits: 3,
                })}{" "}
                {pool.data.token0.symbol}
              </p>
              <p className="poolix-numeric text-[12px] text-muted">
                {formatTokenAmount(formatUnits(pool.data.reserve1, pool.data.token1.decimals), {
                  maximumFractionDigits: 3,
                })}{" "}
                {pool.data.token1.symbol}
              </p>
            </div>
            <ArrowRight className="size-4 shrink-0 text-subtle" aria-hidden="true" />
          </Link>
        )}
      </div>

      <TokenSelect
        open={selecting !== null}
        onClose={() => setSelecting(null)}
        onSelect={handleSelect}
        selectedId={
          selecting === "a"
            ? tokenA
              ? currencyId(tokenA)
              : undefined
            : tokenB
              ? currencyId(tokenB)
              : undefined
        }
      />
    </div>
  );
}

function TokenButton({ currency, onClick }: { currency: Currency | null; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex h-10 flex-1 items-center justify-between gap-2 rounded-poolix border px-3 text-[13.5px] transition-colors",
        currency === null
          ? "border-accent/40 bg-accent-wash text-accent-text hover:bg-accent/15"
          : "border-line bg-raised text-fg hover:border-line-strong",
      )}
    >
      <span className="truncate">{currency?.symbol ?? copy.swap.selectToken}</span>
      <ChevronDown className="size-3.5 shrink-0 text-subtle" aria-hidden="true" />
    </button>
  );
}
