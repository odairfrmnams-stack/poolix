"use client";

import { ArrowRight, ChevronDown } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useId, useState } from "react";
import { formatUnits } from "viem";

import { InfoTip } from "@/components/ui/info-tip";
import { Skeleton } from "@/components/ui/skeleton";
import { copy } from "@/lib/copy";
import { formatBps, formatTokenAmount } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Currency, SwapQuote } from "@/services/liquidity/types";

const HIGH_IMPACT_BPS = 300;
const SEVERE_IMPACT_BPS = 1_000;

interface SwapDetailsProps {
  quote: SwapQuote | null;
  currencyIn: Currency;
  currencyOut: Currency;
  networkFeeWei: bigint | null | undefined;
  nativeSymbol: string;
  isLoading: boolean;
  slippageBps: number;
}

/*
  The terms of the trade.

  The rate stays visible because it is the one line that answers "is this a good price?".
  Everything else — impact, fee, route, slippage, the floor on what arrives — is a click
  away: it all matters, but showing five rows by default buries the rate among them.
*/
export function SwapDetails({
  quote,
  currencyIn,
  currencyOut,
  networkFeeWei,
  nativeSymbol,
  isLoading,
  slippageBps,
}: SwapDetailsProps) {
  const [open, setOpen] = useState(false);
  const reduceMotion = useReducedMotion();
  const bodyId = useId();

  const rate =
    quote === null
      ? null
      : Number(formatUnits(quote.amountOut, currencyOut.decimals)) /
        Number(formatUnits(quote.request.amountIn, currencyIn.decimals));

  const impact = quote?.priceImpactBps ?? null;

  return (
    <div className="rounded-poolix-lg border border-line bg-canvas px-4 py-3 text-[12.5px]">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={bodyId}
        className="flex w-full items-center justify-between gap-4 text-left"
      >
        <span className="text-muted">
          {isLoading ? (
            <Skeleton className="h-3 w-32" />
          ) : rate === null || !Number.isFinite(rate) ? (
            <span className="text-subtle">{copy.swap.details}</span>
          ) : (
            <span className="poolix-numeric text-fg">
              1 {currencyIn.symbol} ={" "}
              {formatTokenAmount(rate.toFixed(Math.min(currencyOut.decimals, 8)), {
                maximumFractionDigits: 6,
              })}{" "}
              {currencyOut.symbol}
            </span>
          )}
        </span>
        <ChevronDown
          className={cn("size-4 shrink-0 text-subtle transition-transform duration-200", open && "rotate-180")}
          aria-hidden="true"
        />
      </button>

      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            id={bodyId}
            initial={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
            animate={reduceMotion ? { opacity: 1 } : { height: "auto", opacity: 1 }}
            exit={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            className="overflow-hidden"
          >
            <dl className="mt-3 space-y-2.5 border-t border-line pt-3">
              <DetailRows
                quote={quote}
                currencyIn={currencyIn}
                currencyOut={currencyOut}
                networkFeeWei={networkFeeWei}
                nativeSymbol={nativeSymbol}
                isLoading={isLoading}
                slippageBps={slippageBps}
                impact={impact}
              />
            </dl>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function DetailRows({
  quote,
  currencyIn,
  currencyOut,
  networkFeeWei,
  nativeSymbol,
  isLoading,
  slippageBps,
  impact,
}: SwapDetailsProps & { impact: number | null }) {
  void currencyIn;
  return (
    <>
      <Row
        label={copy.swap.priceImpact}
        tip={{ title: copy.tooltips.priceImpact.title, body: copy.tooltips.priceImpact.body }}
      >
        {isLoading ? (
          <Skeleton className="h-3 w-12" />
        ) : impact === null ? (
          copy.data.unavailable
        ) : (
          <span
            className={cn(
              "poolix-numeric",
              impact >= SEVERE_IMPACT_BPS ? "text-negative" : impact >= HIGH_IMPACT_BPS ? "text-warning" : "text-muted",
            )}
          >
            {formatBps(impact)}
          </span>
        )}
      </Row>

      <Row label={copy.swap.minimumReceived}>
        {isLoading ? (
          <Skeleton className="h-3 w-24" />
        ) : quote === null ? (
          copy.data.unavailable
        ) : (
          <span className="poolix-numeric">
            {formatTokenAmount(formatUnits(quote.minimumAmountOut, currencyOut.decimals), {
              maximumFractionDigits: 6,
            })}{" "}
            {currencyOut.symbol}
          </span>
        )}
      </Row>

      <Row label={copy.swap.networkFee}>
        {networkFeeWei === undefined && quote !== null ? (
          <Skeleton className="h-3 w-20" />
        ) : networkFeeWei === null || networkFeeWei === undefined ? (
          copy.data.unavailable
        ) : (
          <span className="poolix-numeric">
            {formatTokenAmount(formatUnits(networkFeeWei, 18), { maximumFractionDigits: 6 })} {nativeSymbol}
          </span>
        )}
      </Row>

      <Row label={copy.swap.slippageTolerance}>
        <span className="poolix-numeric">{formatBps(slippageBps)}</span>
      </Row>

      <Row label={copy.swap.route}>
        {isLoading ? (
          <Skeleton className="h-3 w-24" />
        ) : quote === null ? (
          copy.data.unavailable
        ) : (
          <RoutePath quote={quote} currencyIn={currencyIn} currencyOut={currencyOut} />
        )}
      </Row>
    </>
  );
}

/**
 * Shows the hops the trade actually takes. Native currencies are labelled by the
 * symbol the user chose, since the router sees their wrapper.
 */
function RoutePath({
  quote,
  currencyIn,
  currencyOut,
}: {
  quote: SwapQuote;
  currencyIn: Currency;
  currencyOut: Currency;
}) {
  const labels = quote.route.map((_, index) => {
    if (index === 0) return currencyIn.symbol;
    if (index === quote.route.length - 1) return currencyOut.symbol;
    return "WETH";
  });

  return (
    <span className="flex items-center gap-1 text-muted">
      {labels.map((label, index) => (
        <span key={`${label}-${index}`} className="flex items-center gap-1">
          {index > 0 ? <ArrowRight className="size-3 text-subtle" aria-hidden="true" /> : null}
          {label}
        </span>
      ))}
    </span>
  );
}

function Row({
  label,
  tip,
  children,
}: {
  label: string;
  tip?: { title: string; body: string };
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className="flex items-center gap-1.5 text-muted">
        {label}
        {tip ? <InfoTip label={tip.title} body={tip.body} /> : null}
      </dt>
      <dd className="text-right text-fg">{children}</dd>
    </div>
  );
}
