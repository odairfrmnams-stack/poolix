"use client";

import { ChevronDown } from "lucide-react";
import { formatUnits } from "viem";

import { TokenIcon } from "@/components/token/token-icon";
import { Skeleton } from "@/components/ui/skeleton";
import type { CurrencyBalance } from "@/hooks/use-currency-balance";
import { copy } from "@/lib/copy";
import { formatTokenAmount } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Currency } from "@/services/liquidity/types";

/*
  One side of a trade: a label, an amount, and the token it is denominated in.

  The amount is the largest type on the page because it is the only value the user is
  actually deciding. The token selector is a pill rather than a dropdown so it stays a
  comfortable tap target on a phone, and the balance sits underneath where it reads as
  context for the amount rather than as a second heading.
*/

interface CurrencyInputProps {
  label: string;
  currency: Currency | null;
  amount: string;
  onAmountChange?: (value: string) => void;
  /** Omit when the token is fixed, e.g. a pool's own pair. */
  onSelectToken?: () => void;
  balance?: CurrencyBalance;
  showMax?: boolean;
  onMax?: () => void;
  readOnly?: boolean;
  loading?: boolean;
  invalid?: boolean;
  inputId?: string;
}

export function CurrencyInput({
  label,
  currency,
  amount,
  onAmountChange,
  onSelectToken,
  balance,
  showMax = false,
  onMax,
  readOnly = false,
  loading = false,
  invalid = false,
  inputId,
}: CurrencyInputProps) {
  // With no account there is no balance to be missing, so the row is omitted rather
  // than showing an empty value.
  const showBalance =
    balance !== undefined && currency !== null && (balance.isLoading || balance.value !== undefined);

  const balanceText =
    balance === undefined || currency === null || balance.isLoading || balance.value === undefined
      ? null
      : formatTokenAmount(formatUnits(balance.value, currency.decimals), { maximumFractionDigits: 6 });

  return (
    <div
      className={cn(
        "rounded-poolix-lg border bg-raised p-4 transition-colors",
        invalid
          ? "border-negative/50"
          : "border-transparent focus-within:border-line-strong hover:border-line",
      )}
    >
      <label htmlFor={inputId} className="text-[13px] text-muted">
        {label}
      </label>

      <div className="mt-2 flex items-center gap-3">
        {loading ? (
          <Skeleton className="h-9 flex-1" />
        ) : (
          <input
            id={inputId}
            type="text"
            inputMode="decimal"
            autoComplete="off"
            spellCheck={false}
            placeholder="0"
            value={amount}
            readOnly={readOnly}
            aria-label={`${label} amount`}
            onChange={(event) => onAmountChange?.(event.target.value)}
            className={cn(
              "poolix-numeric min-w-0 flex-1 bg-transparent text-[32px] leading-none text-fg",
              "placeholder:text-subtle focus:outline-none focus-visible:outline-none",
              readOnly && "cursor-default",
            )}
          />
        )}

        {onSelectToken === undefined ? (
          <span className="flex h-11 shrink-0 items-center gap-2 rounded-poolix-full border border-line bg-surface px-3 text-[14px] font-medium text-fg">
            <TokenIcon
              address={currency?.kind === "erc20" ? currency.address : null}
              symbol={currency?.symbol ?? null}
              size={24}
            />
            {currency?.symbol}
          </span>
        ) : (
          <button
            type="button"
            onClick={onSelectToken}
            className={cn(
              "flex h-11 shrink-0 items-center gap-2 rounded-poolix-full border px-3 text-[14px] font-medium",
              "transition-[background-color,border-color,color] duration-150 active:scale-[0.985]",
              currency === null
                ? "border-accent/40 bg-accent-wash text-accent-text hover:bg-accent/15"
                : "border-line bg-surface text-fg hover:border-line-strong hover:bg-hover",
            )}
          >
            {currency === null ? (
              copy.swap.selectToken
            ) : (
              <>
                <TokenIcon
                  address={currency.kind === "erc20" ? currency.address : null}
                  symbol={currency.symbol}
                  size={24}
                />
                {currency.symbol}
              </>
            )}
            <ChevronDown className="size-3.5 text-subtle" aria-hidden="true" />
          </button>
        )}
      </div>

      {showBalance ? (
        <div className="mt-3 flex items-center justify-end gap-2 text-[12px] text-subtle">
          <span className="flex items-center gap-1">
            {copy.swap.balance}:{" "}
            {balanceText === null ? (
              <Skeleton className="h-3 w-10" />
            ) : (
              <span className="poolix-numeric">{balanceText}</span>
            )}
          </span>
          {showMax && onMax ? (
            <button
              type="button"
              onClick={onMax}
              className="rounded-poolix-sm border border-line px-1.5 py-0.5 text-[11px] font-medium text-accent-text transition-colors hover:border-accent/40 hover:bg-accent-wash"
            >
              {copy.swap.max}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

