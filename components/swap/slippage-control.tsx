"use client";

import { useId } from "react";

import { InfoTip } from "@/components/ui/info-tip";
import { copy } from "@/lib/copy";
import { cn } from "@/lib/utils";
import { MAX_SLIPPAGE_BPS } from "@/services/liquidity/uniswap-v2/math";

const PRESETS = [10, 50, 100] as const;
const LOW_SLIPPAGE_BPS = 10;
const HIGH_SLIPPAGE_BPS = 500;

export const DEFAULT_SLIPPAGE_BPS = 50;
export const DEFAULT_DEADLINE_MINUTES = 20;

const bpsToPercent = (bps: number) => String(Number((bps / 100).toFixed(2)));

interface SlippageControlProps {
  slippageBps: number;
  onSlippageChange: (bps: number) => void;
  deadlineMinutes: number;
  onDeadlineChange: (minutes: number) => void;
}

export function SlippageControl({
  slippageBps,
  onSlippageChange,
  deadlineMinutes,
  onDeadlineChange,
}: SlippageControlProps) {
  const slippageId = useId();
  const deadlineId = useId();
  const isCustom = !PRESETS.some((preset) => preset === slippageBps);

  const handleSlippageInput = (value: string) => {
    const percent = Number(value);
    if (!Number.isFinite(percent) || percent < 0) return;
    onSlippageChange(Math.min(Math.round(percent * 100), MAX_SLIPPAGE_BPS));
  };

  return (
    <div className="space-y-4 rounded-poolix-lg border border-line bg-canvas p-4">
      <div>
        <div className="flex items-center gap-1.5">
          <label htmlFor={slippageId} className="text-[12.5px] text-muted">
            {copy.swap.slippageTolerance}
          </label>
          <InfoTip label={copy.tooltips.slippageTolerance.title} body={copy.tooltips.slippageTolerance.body} />
        </div>

        <div className="mt-2.5 flex items-center gap-2">
          {PRESETS.map((preset) => (
            <button
              key={preset}
              type="button"
              onClick={() => onSlippageChange(preset)}
              className={cn(
                "h-8 rounded-poolix border px-2.5 text-[12.5px] transition-colors",
                slippageBps === preset
                  ? "border-accent/40 bg-accent-wash text-accent-text"
                  : "border-line text-muted hover:border-line-strong hover:text-fg",
              )}
            >
              {bpsToPercent(preset)}%
            </button>
          ))}

          <div
            className={cn(
              "flex h-8 flex-1 items-center rounded-poolix border px-2.5",
              isCustom ? "border-accent/40 bg-accent-wash" : "border-line",
            )}
          >
            <input
              id={slippageId}
              type="text"
              inputMode="decimal"
              value={isCustom ? bpsToPercent(slippageBps) : ""}
              placeholder="Custom"
              onChange={(event) => handleSlippageInput(event.target.value.replace(/[^\d.]/g, ""))}
              className="poolix-numeric w-full min-w-0 bg-transparent text-right text-[12.5px] text-fg placeholder:text-subtle focus:outline-none"
            />
            <span className="ml-1 text-[12.5px] text-subtle">%</span>
          </div>
        </div>

        {slippageBps >= HIGH_SLIPPAGE_BPS ? (
          <p className="mt-2 text-[11.5px] text-warning">
            A high tolerance lets the trade fill at a much worse price than quoted.
          </p>
        ) : null}
        {slippageBps < LOW_SLIPPAGE_BPS ? (
          <p className="mt-2 text-[11.5px] text-warning">
            A very low tolerance will often fail if the price moves before confirmation.
          </p>
        ) : null}
      </div>

      <div className="flex items-center justify-between gap-4">
        <label htmlFor={deadlineId} className="text-[12.5px] text-muted">
          Transaction deadline
        </label>
        <div className="flex h-8 items-center rounded-poolix border border-line px-2.5">
          <input
            id={deadlineId}
            type="text"
            inputMode="numeric"
            value={String(deadlineMinutes)}
            onChange={(event) => {
              const minutes = Number(event.target.value.replace(/\D/g, ""));
              if (Number.isFinite(minutes) && minutes > 0 && minutes <= 180) onDeadlineChange(minutes);
            }}
            className="poolix-numeric w-10 bg-transparent text-right text-[12.5px] text-fg focus:outline-none"
          />
          <span className="ml-1.5 text-[12.5px] text-subtle">min</span>
        </div>
      </div>
    </div>
  );
}
