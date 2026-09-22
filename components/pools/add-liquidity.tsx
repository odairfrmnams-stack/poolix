"use client";

import { Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { formatUnits, getAddress } from "viem";

import { poolixConfig } from "@/config/poolix";
import { currencyAddress } from "@/services/tokens/currency";

import { CurrencyInput } from "@/components/swap/currency-input";
import { DEFAULT_SLIPPAGE_BPS, DEFAULT_DEADLINE_MINUTES } from "@/components/swap/slippage-control";
import { TransactionDialog } from "@/components/transaction/transaction-dialog";
import { Button } from "@/components/ui/button";
import { useAllowance, useCurrencyBalance } from "@/hooks/use-currency-balance";
import { useTransactionFlow, type ApprovalRequest } from "@/hooks/use-transaction-flow";
import { useWalletStatus } from "@/hooks/use-wallet-status";
import { maxSpendableNative, parseAmount, sanitizeAmountInput, toAmountInput } from "@/lib/amounts";
import { copy } from "@/lib/copy";
import { formatBps, formatTokenAmount } from "@/lib/format";
import type { Currency } from "@/services/liquidity/types";
import { buildAddLiquidity } from "@/services/liquidity/uniswap-v2/liquidity";
import {
  liquidityMinted,
  poolShareBps,
  quote as quoteRatio,
} from "@/services/liquidity/uniswap-v2/math";
import { uniswapV2RevertReasons } from "@/services/liquidity/uniswap-v2/revert-reasons";
import type { PoolState } from "@/services/pools/pool";
import type { Address } from "@/types/web3";

const NATIVE_GAS_RESERVE = 500_000_000_000_000n; // 0.0005 ETH

interface AddLiquidityProps {
  /** Null when the pool does not exist yet, in which case the user sets the price. */
  pool: PoolState | null;
  currencyA: Currency;
  currencyB: Currency;
  router: Address;
  onCompleted?: () => void;
}

export function AddLiquidity({ pool, currencyA, currencyB, router, onCompleted }: AddLiquidityProps) {
  const [inputA, setInputA] = useState("");
  const [inputB, setInputB] = useState("");
  const [lastEdited, setLastEdited] = useState<"a" | "b">("a");

  const wallet = useWalletStatus();
  const flow = useTransactionFlow();

  const balanceA = useCurrencyBalance(currencyA, wallet.address);
  const balanceB = useCurrencyBalance(currencyB, wallet.address);
  const allowanceA = useAllowance(currencyA, wallet.address, currencyA.kind === "erc20" ? router : null);
  const allowanceB = useAllowance(currencyB, wallet.address, currencyB.kind === "erc20" ? router : null);

  // Reserves oriented to the currencies as displayed, not to the pair's token0/token1.
  // A native side is matched by its wrapper, which is what the pool actually holds.
  const reserves = useMemo(() => {
    if (pool === null || pool.reserve0 === 0n || pool.reserve1 === 0n) return null;
    const addressA = currencyAddress(currencyA, poolixConfig.contracts.weth);
    const token0 = pool.token0.kind === "erc20" ? getAddress(pool.token0.address) : null;
    return token0 !== null && addressA === token0
      ? { a: pool.reserve0, b: pool.reserve1 }
      : { a: pool.reserve1, b: pool.reserve0 };
  }, [pool, currencyA]);

  /*
    With reserves present the pool fixes the ratio, so the untouched field mirrors the
    edited one. An empty pool has no ratio yet: the first deposit sets the price, and
    both fields stay free.
  */
  const derived = useMemo(() => {
    if (reserves === null) return { a: inputA, b: inputB };

    if (lastEdited === "a") {
      const amountA = parseAmount(inputA, currencyA.decimals);
      if (amountA === null) return { a: inputA, b: "" };
      return { a: inputA, b: toAmountInput(quoteRatio(amountA, reserves.a, reserves.b), currencyB.decimals) };
    }

    const amountB = parseAmount(inputB, currencyB.decimals);
    if (amountB === null) return { a: "", b: inputB };
    return { a: toAmountInput(quoteRatio(amountB, reserves.b, reserves.a), currencyA.decimals), b: inputB };
  }, [reserves, lastEdited, inputA, inputB, currencyA.decimals, currencyB.decimals]);

  const amountA = parseAmount(derived.a, currencyA.decimals);
  const amountB = parseAmount(derived.b, currencyB.decimals);

  const insufficientA = amountA !== null && balanceA.value !== undefined && amountA > balanceA.value;
  const insufficientB = amountB !== null && balanceB.value !== undefined && amountB > balanceB.value;

  // Expected LP tokens and resulting share, from the same functions the pair uses.
  const preview = useMemo(() => {
    if (amountA === null || amountB === null || pool === null) return null;
    try {
      const minted = liquidityMinted({
        amountA,
        amountB,
        reserveA: reserves?.a ?? 0n,
        reserveB: reserves?.b ?? 0n,
        totalSupply: pool.totalSupply,
      });
      return { minted, shareBps: poolShareBps(minted, pool.totalSupply + minted) };
    } catch {
      return null;
    }
  }, [amountA, amountB, pool, reserves]);

  async function handleSubmit() {
    if (amountA === null || amountB === null || wallet.address === undefined) return;

    const approvals: ApprovalRequest[] = [];
    if (currencyA.kind === "erc20") {
      approvals.push({
        token: currencyA.address,
        spender: router,
        amount: amountA,
        currentAllowance: allowanceA.data ?? 0n,
      });
    }
    if (currencyB.kind === "erc20") {
      approvals.push({
        token: currencyB.address,
        spender: router,
        amount: amountB,
        currentAllowance: allowanceB.data ?? 0n,
      });
    }

    const deadline = BigInt(Math.floor(Date.now() / 1000) + DEFAULT_DEADLINE_MINUTES * 60);

    const confirmed = await flow.execute({
      account: wallet.address,
      approvals,
      call: buildAddLiquidity({
        router,
        currencyA,
        currencyB,
        amountA,
        amountB,
        slippageBps: DEFAULT_SLIPPAGE_BPS,
        recipient: wallet.address,
        deadline,
      }),
      revertReasons: uniswapV2RevertReasons,
      // Both approvals and the call itself go to the router, and nowhere else.
      allowedTargets: [router],
      deadline,
    });

    balanceA.refetch();
    balanceB.refetch();
    void allowanceA.refetch();
    void allowanceB.refetch();
    if (confirmed) onCompleted?.();
  }

  const label = resolveLabel({
    wallet,
    amountA,
    amountB,
    insufficient: insufficientA || insufficientB,
  });

  return (
    <div className="space-y-1">
      {reserves === null ? (
        <p className="mb-3 rounded-poolix border border-warning/30 bg-warning/5 px-3 py-2.5 text-[12px] leading-relaxed text-warning">
          This pool holds no liquidity. The amounts you deposit set its starting price, so
          check them against the market before confirming.
        </p>
      ) : null}

      <CurrencyInput
        inputId="add-liquidity-a"
        label={`${copy.swap.from} A`}
        currency={currencyA}
        amount={derived.a}
        onAmountChange={(value) => {
          setLastEdited("a");
          setInputA(sanitizeAmountInput(value, currencyA.decimals));
        }}
        balance={balanceA}
        showMax={wallet.isConnected && balanceA.value !== undefined && balanceA.value > 0n}
        onMax={() => {
          if (balanceA.value === undefined) return;
          setLastEdited("a");
          setInputA(
            toAmountInput(
              currencyA.kind === "native"
                ? maxSpendableNative(balanceA.value, NATIVE_GAS_RESERVE)
                : balanceA.value,
              currencyA.decimals,
            ),
          );
        }}
        invalid={insufficientA}
      />

      <div className="relative flex h-0 items-center justify-center">
        <span className="z-10 flex size-8 items-center justify-center rounded-poolix border border-line bg-raised text-subtle">
          <Plus className="size-3.5" aria-hidden="true" />
        </span>
      </div>

      <CurrencyInput
        inputId="add-liquidity-b"
        label={`${copy.swap.from} B`}
        currency={currencyB}
        amount={derived.b}
        onAmountChange={(value) => {
          setLastEdited("b");
          setInputB(sanitizeAmountInput(value, currencyB.decimals));
        }}
        balance={balanceB}
        showMax={wallet.isConnected && balanceB.value !== undefined && balanceB.value > 0n}
        onMax={() => {
          if (balanceB.value === undefined) return;
          setLastEdited("b");
          setInputB(
            toAmountInput(
              currencyB.kind === "native"
                ? maxSpendableNative(balanceB.value, NATIVE_GAS_RESERVE)
                : balanceB.value,
              currencyB.decimals,
            ),
          );
        }}
        invalid={insufficientB}
      />

      {preview !== null ? (
        <dl className="mt-3 space-y-2.5 rounded-poolix-lg border border-line bg-canvas px-4 py-3.5 text-[12.5px]">
          <div className="flex items-center justify-between">
            <dt className="text-muted">LP tokens received</dt>
            <dd className="poolix-numeric text-fg">
              {formatTokenAmount(formatUnits(preview.minted, 18), { maximumFractionDigits: 6 })}
            </dd>
          </div>
          <div className="flex items-center justify-between">
            <dt className="text-muted">{copy.liquidity.poolShare}</dt>
            <dd className="poolix-numeric text-fg">{formatBps(preview.shareBps)}</dd>
          </div>
          <div className="flex items-center justify-between">
            <dt className="text-muted">{copy.swap.slippageTolerance}</dt>
            <dd className="poolix-numeric text-muted">{formatBps(DEFAULT_SLIPPAGE_BPS)}</dd>
          </div>
        </dl>
      ) : null}

      <div className="pt-3">
        <Button size="xl" full disabled={label.disabled} onClick={() => void handleSubmit()}>
          {label.text}
        </Button>
      </div>

      <TransactionDialog
        state={flow.state}
        action={copy.liquidity.addLiquidity}
        onClose={() => {
          flow.reset();
          if (flow.state.status === "confirmed") {
            setInputA("");
            setInputB("");
          }
        }}
        onRetry={() => {
          flow.reset();
          void handleSubmit();
        }}
      />
    </div>
  );
}

function resolveLabel({
  wallet,
  amountA,
  amountB,
  insufficient,
}: {
  wallet: ReturnType<typeof useWalletStatus>;
  amountA: bigint | null;
  amountB: bigint | null;
  insufficient: boolean;
}): { text: string; disabled: boolean } {
  if (!wallet.mounted) return { text: copy.loading.generic, disabled: true };
  if (!wallet.isConnected) return { text: copy.errors.walletNotConnected.title, disabled: true };
  if (wallet.wrongNetwork) return { text: copy.wallet.wrongNetwork, disabled: true };
  if (amountA === null || amountB === null) return { text: copy.swap.enterAmount, disabled: true };
  if (insufficient) return { text: copy.swap.insufficientBalance, disabled: true };
  return { text: copy.liquidity.addLiquidity, disabled: false };
}
