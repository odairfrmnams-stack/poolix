"use client";

import { useId, useMemo, useState } from "react";
import { formatUnits } from "viem";
import { useReadContract } from "wagmi";

import { DEFAULT_DEADLINE_MINUTES, DEFAULT_SLIPPAGE_BPS } from "@/components/swap/slippage-control";
import { TransactionDialog } from "@/components/transaction/transaction-dialog";
import { Button } from "@/components/ui/button";
import { useTransactionFlow } from "@/hooks/use-transaction-flow";
import { useWalletStatus } from "@/hooks/use-wallet-status";
import { copy } from "@/lib/copy";
import { formatTokenAmount } from "@/lib/format";
import { cn } from "@/lib/utils";
import { uniswapV2PairAbi } from "@/services/abis/uniswap-v2";
import type { Currency } from "@/services/liquidity/types";
import { buildRemoveLiquidity } from "@/services/liquidity/uniswap-v2/liquidity";
import {
  applySlippage,
  liquidityForPercentage,
  removeLiquidityAmounts,
} from "@/services/liquidity/uniswap-v2/math";
import { uniswapV2RevertReasons } from "@/services/liquidity/uniswap-v2/revert-reasons";
import type { PoolState } from "@/services/pools/pool";
import type { Address } from "@/types/web3";

const PRESETS = [2_500, 5_000, 7_500, 10_000] as const;

interface RemoveLiquidityProps {
  pool: PoolState;
  /** The account's LP token balance. */
  balance: bigint;
  /** Aligned with pool.token0 and pool.token1, with ETH substituted where wanted. */
  currency0: Currency;
  currency1: Currency;
  router: Address;
  onCompleted?: () => void;
}

export function RemoveLiquidity({
  pool,
  balance,
  currency0,
  currency1,
  router,
  onCompleted,
}: RemoveLiquidityProps) {
  const [percentBps, setPercentBps] = useState(5_000);
  const sliderId = useId();

  const wallet = useWalletStatus();
  const flow = useTransactionFlow();

  const allowance = useReadContract({
    address: pool.address,
    abi: uniswapV2PairAbi,
    functionName: "allowance",
    args: wallet.address ? [wallet.address, router] : undefined,
    query: { enabled: wallet.address !== undefined },
  });

  const liquidity = liquidityForPercentage(balance, percentBps);

  const preview = useMemo(() => {
    if (liquidity <= 0n) return null;
    try {
      const { amountA, amountB } = removeLiquidityAmounts(
        liquidity,
        pool.reserve0,
        pool.reserve1,
        pool.totalSupply,
      );
      return { amount0: amountA, amount1: amountB };
    } catch {
      return null;
    }
  }, [liquidity, pool]);

  async function handleSubmit() {
    if (preview === null || wallet.address === undefined) return;

    const deadline = BigInt(Math.floor(Date.now() / 1000) + DEFAULT_DEADLINE_MINUTES * 60);

    const confirmed = await flow.execute({
      account: wallet.address,
      // Burning LP tokens moves them through the router, which needs an allowance.
      approvals: [
        {
          token: pool.address,
          spender: router,
          amount: liquidity,
          currentAllowance: allowance.data ?? 0n,
        },
      ],
      call: buildRemoveLiquidity({
        router,
        currencyA: currency0,
        currencyB: currency1,
        liquidity,
        amountA: preview.amount0,
        amountB: preview.amount1,
        slippageBps: DEFAULT_SLIPPAGE_BPS,
        recipient: wallet.address,
        deadline,
      }),
      revertReasons: uniswapV2RevertReasons,
      // The LP token is approved TO the router, and the burn call goes to the router.
      allowedTargets: [router],
      deadline,
    });

    void allowance.refetch();
    if (confirmed) onCompleted?.();
  }

  const disabled = !wallet.isConnected || wallet.wrongNetwork || preview === null || balance <= 0n;

  return (
    <div>
      <div className="rounded-poolix-lg border border-line bg-canvas p-4">
        <div className="flex items-baseline justify-between">
          <label htmlFor={sliderId} className="text-[12.5px] text-muted">
            Amount to remove
          </label>
          <span className="poolix-numeric text-[22px] leading-none text-fg">
            {(percentBps / 100).toFixed(0)}%
          </span>
        </div>

        <input
          id={sliderId}
          type="range"
          min={100}
          max={10_000}
          step={100}
          value={percentBps}
          onChange={(event) => setPercentBps(Number(event.target.value))}
          className="poolix-range mt-4"
        />

        <div className="mt-4 flex gap-2">
          {PRESETS.map((preset) => (
            <button
              key={preset}
              type="button"
              onClick={() => setPercentBps(preset)}
              className={cn(
                "h-8 flex-1 rounded-poolix border text-[12.5px] transition-colors",
                percentBps === preset
                  ? "border-accent/40 bg-accent-wash text-accent-text"
                  : "border-line text-muted hover:border-line-strong hover:text-fg",
              )}
            >
              {preset / 100}%
            </button>
          ))}
        </div>
      </div>

      <dl className="mt-3 space-y-2.5 rounded-poolix-lg border border-line bg-canvas px-4 py-3.5 text-[12.5px]">
        <Row label={`${currency0.symbol} received`}>
          {preview === null
            ? copy.data.unavailable
            : formatTokenAmount(formatUnits(preview.amount0, currency0.decimals), {
                maximumFractionDigits: 6,
              })}
        </Row>
        <Row label={`${currency1.symbol} received`}>
          {preview === null
            ? copy.data.unavailable
            : formatTokenAmount(formatUnits(preview.amount1, currency1.decimals), {
                maximumFractionDigits: 6,
              })}
        </Row>
        <Row label={copy.swap.minimumReceived}>
          {preview === null
            ? copy.data.unavailable
            : `${formatTokenAmount(
                formatUnits(applySlippage(preview.amount0, DEFAULT_SLIPPAGE_BPS), currency0.decimals),
                { maximumFractionDigits: 4 },
              )} / ${formatTokenAmount(
                formatUnits(applySlippage(preview.amount1, DEFAULT_SLIPPAGE_BPS), currency1.decimals),
                { maximumFractionDigits: 4 },
              )}`}
        </Row>
      </dl>

      <div className="pt-3">
        <Button size="xl" full variant="secondary" disabled={disabled} onClick={() => void handleSubmit()}>
          {balance <= 0n ? copy.empty.positions.title : copy.liquidity.removeLiquidity}
        </Button>
      </div>

      <TransactionDialog
        state={flow.state}
        action={copy.liquidity.removeLiquidity}
        onClose={() => flow.reset()}
        onRetry={() => {
          flow.reset();
          void handleSubmit();
        }}
      />
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className="text-muted">{label}</dt>
      <dd className="poolix-numeric text-right text-fg">{children}</dd>
    </div>
  );
}
