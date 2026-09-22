"use client";

import { ArrowDown, Settings2, TriangleAlert } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useMemo, useState } from "react";
import { formatUnits, parseEther } from "viem";

import { CurrencyInput } from "@/components/swap/currency-input";
import {
  DEFAULT_DEADLINE_MINUTES,
  DEFAULT_SLIPPAGE_BPS,
  SlippageControl,
} from "@/components/swap/slippage-control";
import { SwapDetails } from "@/components/swap/swap-details";
import { TokenSelect } from "@/components/swap/token-select";
import { TransactionDialog } from "@/components/transaction/transaction-dialog";
import { Button } from "@/components/ui/button";
import { poolixConfig } from "@/config/poolix";
import { isUniswapV2Available } from "@/config/resolve";
import { useAllowance, useCurrencyBalance } from "@/hooks/use-currency-balance";
import { useLiquiditySource } from "@/hooks/use-liquidity-source";
import { useNetworkFee } from "@/hooks/use-network-fee";
import { useSwapQuote } from "@/hooks/use-swap-quote";
import { useTransactionFlow } from "@/hooks/use-transaction-flow";
import { useWalletStatus } from "@/hooks/use-wallet-status";
import { maxSpendableNative, parseAmount, sanitizeAmountInput, toAmountInput } from "@/lib/amounts";
import { copy } from "@/lib/copy";
import { formatTokenAmount } from "@/lib/format";
import { DEFAULT_TOKENS } from "@/lib/token-storage";
import { cn } from "@/lib/utils";
import type { Currency } from "@/services/liquidity/types";
import { uniswapV2RevertReasons } from "@/services/liquidity/uniswap-v2/revert-reasons";
import { currencyId, sameCurrency } from "@/services/tokens/currency";

/** Held back from a native "Max" so the user can still pay for the transaction. */
const NATIVE_GAS_RESERVE = parseEther("0.0005");
const CONFIRM_IMPACT_BPS = 1_500;
/** Far-future deadline used only for gas estimation, never for a sent transaction. */
const ESTIMATE_DEADLINE = 2n ** 48n;

const [NATIVE_TOKEN] = DEFAULT_TOKENS;

export function SwapCard() {
  const [currencyIn, setCurrencyIn] = useState<Currency | null>(NATIVE_TOKEN ?? null);
  const [currencyOut, setCurrencyOut] = useState<Currency | null>(null);
  const [amountInput, setAmountInput] = useState("");
  const [slippageBps, setSlippageBps] = useState(DEFAULT_SLIPPAGE_BPS);
  const [deadlineMinutes, setDeadlineMinutes] = useState(DEFAULT_DEADLINE_MINUTES);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [selecting, setSelecting] = useState<"in" | "out" | null>(null);
  const [impactAcknowledged, setImpactAcknowledged] = useState(false);
  /** Only drives the direction icon's rotation; it has no bearing on the trade. */
  const [flipCount, setFlipCount] = useState(0);

  const reduceMotion = useReducedMotion();
  const wallet = useWalletStatus();
  const source = useLiquiditySource();
  const flow = useTransactionFlow();

  const sourceAvailable = isUniswapV2Available(poolixConfig);

  const amountIn = currencyIn ? parseAmount(amountInput, currencyIn.decimals) : null;

  const { quote, isPending: quotePending, hasNoRoute } = useSwapQuote({
    currencyIn,
    currencyOut,
    amountIn,
    slippageBps,
  });

  const balanceIn = useCurrencyBalance(currencyIn, wallet.address);
  const balanceOut = useCurrencyBalance(currencyOut, wallet.address);
  const allowance = useAllowance(currencyIn, wallet.address, quote?.approvalSpender ?? null);

  const needsApproval =
    quote !== null &&
    quote.approvalSpender !== null &&
    currencyIn?.kind === "erc20" &&
    (allowance.data ?? 0n) < quote.request.amountIn;

  // A fee estimate only succeeds once the router is already allowed to move the token.
  // The real deadline is stamped at execution; any future value estimates the same gas.
  const preparedCall = useMemo(() => {
    if (source === null || quote === null || wallet.address === undefined || needsApproval) return null;
    try {
      return source.buildSwap({ quote, recipient: wallet.address, deadline: ESTIMATE_DEADLINE });
    } catch {
      return null;
    }
  }, [source, quote, wallet.address, needsApproval]);

  const networkFee = useNetworkFee(preparedCall, wallet.address);

  const insufficientBalance =
    amountIn !== null && balanceIn.value !== undefined && amountIn > balanceIn.value;

  const highImpact = quote !== null && quote.priceImpactBps >= CONFIRM_IMPACT_BPS;

  const outputAmount =
    quote !== null && currencyOut !== null
      ? formatTokenAmount(formatUnits(quote.amountOut, currencyOut.decimals), { maximumFractionDigits: 8 })
      : "";

  function handleFlip() {
    setCurrencyIn(currencyOut);
    setCurrencyOut(currencyIn);
    // The typed amount belonged to the old input token, so it cannot carry over.
    setAmountInput("");
    setImpactAcknowledged(false);
  }

  function handleSelect(currency: Currency) {
    const side = selecting;
    if (side === null) return;
    const other = side === "in" ? currencyOut : currencyIn;

    if (other !== null && sameCurrency(currency, other)) {
      handleFlip();
      return;
    }
    if (side === "in") {
      setCurrencyIn(currency);
      setAmountInput("");
    } else {
      setCurrencyOut(currency);
    }
    setImpactAcknowledged(false);
  }

  function handleMax() {
    if (currencyIn === null || balanceIn.value === undefined) return;
    const spendable =
      currencyIn.kind === "native"
        ? maxSpendableNative(balanceIn.value, NATIVE_GAS_RESERVE)
        : balanceIn.value;
    setAmountInput(toAmountInput(spendable, currencyIn.decimals));
  }

  async function handleSubmit() {
    if (quote === null || wallet.address === undefined || source === null) return;

    const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineMinutes * 60);
    const call = source.buildSwap({ quote, recipient: wallet.address, deadline });
    const { currencyIn: input, amountIn: spend } = quote.request;

    await flow.execute({
      account: wallet.address,
      approvals:
        quote.approvalSpender !== null && input.kind === "erc20"
          ? [
              {
                token: input.address,
                spender: quote.approvalSpender,
                amount: spend,
                currentAllowance: allowance.data ?? 0n,
              },
            ]
          : [],
      call,
      revertReasons: uniswapV2RevertReasons,
      // The router is the only contract a swap may reach, as the call target and as the
      // approval spender. Anything else is a defect and the flow refuses to sign it.
      allowedTargets: quote.approvalSpender !== null ? [call.to, quote.approvalSpender] : [call.to],
      deadline,
    });

    balanceIn.refetch();
    balanceOut.refetch();
    void allowance.refetch();
  }

  const action = resolveAction({
    sourceAvailable,
    wallet,
    currencyIn,
    currencyOut,
    amountIn,
    quotePending,
    quote: quote !== null,
    hasNoRoute,
    insufficientBalance,
    needsApproval,
    highImpact,
    impactAcknowledged,
    symbolIn: currencyIn?.symbol ?? "",
  });

  return (
    <div className="mx-auto w-full max-w-[480px]">
      <div className="rounded-poolix-xl border border-line bg-surface p-4 shadow-2xl shadow-black/40">
        <div className="mb-3 flex items-center justify-between px-1">
          <h1 className="text-[16px] font-medium text-fg">{copy.swap.swap}</h1>
          <button
            type="button"
            onClick={() => setSettingsOpen((value) => !value)}
            aria-expanded={settingsOpen}
            aria-label={copy.nav.settings}
            className={cn(
              "flex size-9 items-center justify-center rounded-poolix transition-colors",
              settingsOpen ? "bg-raised text-fg" : "text-subtle hover:bg-raised hover:text-fg",
            )}
          >
            <Settings2 className="size-4" aria-hidden="true" />
          </button>
        </div>

        <AnimatePresence initial={false}>
          {settingsOpen ? (
            <motion.div
              initial={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
              animate={reduceMotion ? { opacity: 1 } : { height: "auto", opacity: 1 }}
              exit={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
              transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
              className="overflow-hidden"
            >
              <div className="pb-3">
                <SlippageControl
                  slippageBps={slippageBps}
                  onSlippageChange={setSlippageBps}
                  deadlineMinutes={deadlineMinutes}
                  onDeadlineChange={setDeadlineMinutes}
                />
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>

        <div className="relative space-y-1">
          <CurrencyInput
            inputId="swap-amount-in"
            label={copy.swap.sell}
            currency={currencyIn}
            amount={amountInput}
            onAmountChange={(value) =>
              setAmountInput(currencyIn ? sanitizeAmountInput(value, currencyIn.decimals) : value)
            }
            onSelectToken={() => setSelecting("in")}
            balance={balanceIn}
            showMax={wallet.isConnected && balanceIn.value !== undefined && balanceIn.value > 0n}
            onMax={handleMax}
            invalid={insufficientBalance}
          />

          {/* Sits in the seam between the two panels, so the direction it flips is
              obvious without a label. The icon rotates a half turn on each press. */}
          <div className="relative flex h-0 items-center justify-center">
            <button
              type="button"
              onClick={() => {
                setFlipCount((count) => count + 1);
                handleFlip();
              }}
              aria-label="Switch tokens"
              className="z-10 flex size-10 items-center justify-center rounded-poolix border-4 border-surface bg-raised text-muted transition-colors hover:text-accent-text active:scale-95"
            >
              <motion.span
                animate={reduceMotion ? undefined : { rotate: flipCount * 180 }}
                transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
                className="flex"
              >
                <ArrowDown className="size-4" aria-hidden="true" />
              </motion.span>
            </button>
          </div>

          <CurrencyInput
            label={copy.swap.buy}
            currency={currencyOut}
            amount={outputAmount}
            onSelectToken={() => setSelecting("out")}
            balance={balanceOut}
            readOnly
            loading={quotePending && amountIn !== null && currencyOut !== null}
          />
        </div>

        {currencyIn !== null && currencyOut !== null && amountIn !== null ? (
          <div className="mt-3">
            <SwapDetails
              quote={quote}
              currencyIn={currencyIn}
              currencyOut={currencyOut}
              networkFeeWei={preparedCall === null ? null : networkFee.data}
              nativeSymbol={poolixConfig.chain.nativeCurrency.symbol}
              isLoading={quotePending}
              slippageBps={slippageBps}
            />
          </div>
        ) : null}

        {highImpact ? (
          <label className="mt-3 flex items-start gap-2.5 rounded-poolix-lg border border-negative/30 bg-negative/5 p-3 text-[12.5px] leading-relaxed text-negative">
            <input
              type="checkbox"
              checked={impactAcknowledged}
              onChange={(event) => setImpactAcknowledged(event.target.checked)}
              className="mt-0.5 size-3.5 accent-[var(--poolix-negative)]"
            />
            <span>
              <TriangleAlert className="mr-1 inline size-3.5 align-[-2px]" aria-hidden="true" />
              This trade moves the price by more than 15%. You will receive substantially less
              than the mid price. Confirm you want to continue.
            </span>
          </label>
        ) : null}

        <div className="mt-3">
          <Button
            size="xl"
            full
            disabled={action.disabled}
            onClick={() => {
              if (action.kind === "connect") wallet.connect();
              else if (action.kind === "switch") wallet.switchToPoolix();
              else if (action.kind === "submit") void handleSubmit();
              else if (action.kind === "select") setSelecting(currencyOut === null ? "out" : "in");
            }}
            variant={action.kind === "submit" && highImpact ? "danger" : "primary"}
          >
            {action.label}
          </Button>
        </div>
      </div>

      <TokenSelect
        open={selecting !== null}
        onClose={() => setSelecting(null)}
        onSelect={handleSelect}
        selectedId={
          selecting === "in"
            ? currencyIn
              ? currencyId(currencyIn)
              : undefined
            : currencyOut
              ? currencyId(currencyOut)
              : undefined
        }
      />

      <TransactionDialog
        state={flow.state}
        action={copy.swap.swap}
        onClose={() => {
          flow.reset();
          if (flow.state.status === "confirmed") setAmountInput("");
        }}
        onRetry={() => {
          flow.reset();
          void handleSubmit();
        }}
      />
    </div>
  );
}

type ActionKind = "connect" | "switch" | "select" | "submit" | "none";

interface ResolvedAction {
  readonly kind: ActionKind;
  readonly label: string;
  readonly disabled: boolean;
}

/**
 * The single next step, resolved in priority order. Blocking conditions come before
 * anything the user could act on, so the button never invites an action that cannot
 * succeed.
 */
function resolveAction(input: {
  sourceAvailable: boolean;
  wallet: ReturnType<typeof useWalletStatus>;
  currencyIn: Currency | null;
  currencyOut: Currency | null;
  amountIn: bigint | null;
  quotePending: boolean;
  quote: boolean;
  hasNoRoute: boolean;
  insufficientBalance: boolean;
  needsApproval: boolean;
  highImpact: boolean;
  impactAcknowledged: boolean;
  symbolIn: string;
}): ResolvedAction {
  if (!input.sourceAvailable) {
    return { kind: "none", label: copy.status.contractNotConfigured, disabled: true };
  }
  if (!input.wallet.mounted) {
    return { kind: "none", label: copy.loading.generic, disabled: true };
  }
  if (!input.wallet.isConnected) {
    return input.wallet.hasWallet
      ? { kind: "connect", label: copy.wallet.connect, disabled: input.wallet.isConnecting }
      : { kind: "none", label: copy.wallet.unavailable, disabled: true };
  }
  if (input.wallet.wrongNetwork) {
    return { kind: "switch", label: copy.wallet.switchNetwork, disabled: input.wallet.isSwitching };
  }
  if (input.currencyIn === null || input.currencyOut === null) {
    return { kind: "select", label: copy.swap.selectToken, disabled: false };
  }
  if (input.amountIn === null) {
    return { kind: "none", label: copy.swap.enterAmount, disabled: true };
  }
  if (input.insufficientBalance) {
    return { kind: "none", label: copy.swap.insufficientBalance, disabled: true };
  }
  if (input.quotePending) {
    return { kind: "none", label: copy.loading.quote, disabled: true };
  }
  if (input.hasNoRoute) {
    return { kind: "none", label: copy.swap.insufficientLiquidity, disabled: true };
  }
  if (!input.quote) {
    return { kind: "none", label: copy.swap.quoteUnavailable, disabled: true };
  }
  if (input.highImpact && !input.impactAcknowledged) {
    return { kind: "none", label: copy.errors.priceImpactTooHigh.title, disabled: true };
  }
  if (input.needsApproval) {
    return { kind: "submit", label: `${copy.swap.approve} ${input.symbolIn}`, disabled: false };
  }
  return { kind: "submit", label: copy.swap.confirmSwap, disabled: false };
}
