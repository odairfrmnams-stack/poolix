"use client";

import { useId, useMemo, useState } from "react";
import { formatUnits } from "viem";

import { copy } from "@/lib/copy";
import { formatBps, formatTokenAmount } from "@/lib/format";
import { getAmountOut, priceImpactBps } from "@/services/liquidity/uniswap-v2/math";

/*
  An illustration of constant product pricing, driven by the same functions the swap
  surface uses (services/liquidity/uniswap-v2/math.ts). The reserves are a round
  model, not a live pool, and the caption says so: nothing here is presented as
  onchain data.
*/
const DECIMALS = 18;
const ONE = 10n ** BigInt(DECIMALS);
const RESERVE_IN = 1_000n * ONE; // base asset, priced in the quote asset below
const RESERVE_OUT = 2_500_000n * ONE;

/** x * y = k, in whole units rather than wei, for plotting only. */
const K = 1_000 * 2_500_000;

const MAX_TRADE = 260;
const WIDTH = 520;
const HEIGHT = 280;
const PAD_X = 20;
const PAD_Y = 22;

// Framed so the traded segment covers a readable part of the curve.
const X_MIN = 860;
const X_MAX = 1_520;
const Y_MIN = K / X_MAX;
const Y_MAX = K / X_MIN;

const toX = (reserve: number) => PAD_X + ((reserve - X_MIN) / (X_MAX - X_MIN)) * (WIDTH - PAD_X * 2);
const toY = (reserve: number) => HEIGHT - PAD_Y - ((reserve - Y_MIN) / (Y_MAX - Y_MIN)) * (HEIGHT - PAD_Y * 2);

/** Samples x*y=k between two base-reserve values and returns an SVG path. */
function curvePath(fromReserve: number, toReserve: number, steps = 64): string {
  const points: string[] = [];
  for (let step = 0; step <= steps; step++) {
    const reserve = fromReserve + ((toReserve - fromReserve) * step) / steps;
    points.push(`${toX(reserve).toFixed(2)},${toY(K / reserve).toFixed(2)}`);
  }
  return `M ${points.join(" L ")}`;
}

const FULL_CURVE = curvePath(X_MIN, X_MAX);
const START_RESERVE = 1_000;

export function LiquidityCurve() {
  const [tradeSize, setTradeSize] = useState(140);
  const sliderId = useId();

  const trade = useMemo(() => {
    const amountIn = (BigInt(Math.round(tradeSize * 1000)) * ONE) / 1000n;
    const amountOut = getAmountOut(amountIn, { reserveIn: RESERVE_IN, reserveOut: RESERVE_OUT });
    const impact = priceImpactBps(amountIn, amountOut, [{ reserveIn: RESERVE_IN, reserveOut: RESERVE_OUT }]);

    const receivedUnits = Number(formatUnits(amountOut, DECIMALS));
    const nextIn = START_RESERVE + tradeSize;

    return {
      received: formatTokenAmount(formatUnits(amountOut, DECIMALS), { maximumFractionDigits: 0 }),
      impact,
      executionPrice: receivedUnits / tradeSize,
      nextIn,
      segment: curvePath(START_RESERVE, nextIn, 32),
      point: { x: toX(nextIn), y: toY(K / nextIn) },
    };
  }, [tradeSize]);

  const start = { x: toX(START_RESERVE), y: toY(K / START_RESERVE) };
  const midPrice = 2_500_000 / 1_000;

  return (
    <div className="overflow-hidden rounded-poolix-lg border border-line bg-surface">
      <div className="flex flex-col gap-1 border-b border-line px-5 py-4 sm:flex-row sm:items-baseline sm:justify-between">
        <h2 className="text-sm font-medium text-fg">Constant product pricing</h2>
        <p className="text-[12px] text-subtle">Illustration · not live pool data</p>
      </div>

      <div className="grid lg:grid-cols-[1.3fr_1fr]">
        <div className="border-line p-4 lg:border-r">
          <svg
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
            className="mx-auto h-auto w-full max-w-[560px]"
            role="img"
            aria-label={`Constant product curve. Trading ${tradeSize} units returns about ${trade.received}, a price impact of ${formatBps(trade.impact)}.`}
          >
            <defs>
              <linearGradient id="poolix-curve-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--poolix-accent)" stopOpacity="0.12" />
                <stop offset="100%" stopColor="var(--poolix-accent)" stopOpacity="0" />
              </linearGradient>
            </defs>

            <path
              d={`${trade.segment} L ${trade.point.x.toFixed(2)},${HEIGHT - PAD_Y} L ${start.x.toFixed(2)},${HEIGHT - PAD_Y} Z`}
              fill="url(#poolix-curve-fill)"
            />

            <path d={FULL_CURVE} fill="none" stroke="var(--poolix-border-strong)" strokeWidth="1.5" />
            <path
              d={trade.segment}
              fill="none"
              stroke="var(--poolix-accent)"
              strokeWidth="2.5"
              strokeLinecap="round"
            />

            {/* Chord between the two points: its slope is the execution price. */}
            <line
              x1={start.x}
              y1={start.y}
              x2={trade.point.x}
              y2={trade.point.y}
              stroke="var(--poolix-fg-subtle)"
              strokeWidth="1"
              strokeDasharray="3 3"
            />

            <circle
              cx={start.x}
              cy={start.y}
              r="4"
              fill="var(--poolix-bg)"
              stroke="var(--poolix-fg-subtle)"
              strokeWidth="1.5"
            />
            <circle cx={trade.point.x} cy={trade.point.y} r="11" fill="var(--poolix-accent)" opacity="0.16" />
            <circle
              cx={trade.point.x}
              cy={trade.point.y}
              r="5"
              fill="var(--poolix-accent)"
              stroke="var(--poolix-bg)"
              strokeWidth="1.5"
            />

            <text x={PAD_X} y={HEIGHT - 4} fill="var(--poolix-fg-subtle)" fontSize="10">
              base reserve →
            </text>
            <text x={PAD_X} y={12} fill="var(--poolix-fg-subtle)" fontSize="10">
              ← quote reserve
            </text>
          </svg>
        </div>

        <div className="flex flex-col gap-5 border-t border-line p-5 lg:border-t-0">
          <div>
            <label htmlFor={sliderId} className="flex items-baseline justify-between text-[12px] text-muted">
              <span>Trade size</span>
              <span className="poolix-numeric text-fg">
                {tradeSize} / {START_RESERVE} in reserve
              </span>
            </label>
            <input
              id={sliderId}
              type="range"
              min={5}
              max={MAX_TRADE}
              step={5}
              value={tradeSize}
              onChange={(event) => setTradeSize(Number(event.target.value))}
              className="poolix-range mt-3"
            />
          </div>

          <dl className="space-y-3 text-[13px]">
            <Row label="Receives">
              <span className="poolix-numeric text-fg">{trade.received}</span>
            </Row>
            <Row label="Execution price">
              <span className="poolix-numeric text-muted">{trade.executionPrice.toFixed(2)}</span>
            </Row>
            <Row label="Mid price">
              <span className="poolix-numeric text-subtle">{midPrice.toFixed(2)}</span>
            </Row>
            <Row label={copy.swap.priceImpact}>
              <span className={`poolix-numeric ${trade.impact > 300 ? "text-warning" : "text-accent-text"}`}>
                {formatBps(trade.impact)}
              </span>
            </Row>
          </dl>

          <p className="mt-auto text-[12px] leading-relaxed text-subtle">
            Each unit of a larger trade is filled further along the curve, so the execution price drifts
            from the mid price. This is the arithmetic behind every quote Poolix shows.
          </p>
        </div>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between border-b border-line pb-3 last:border-0 last:pb-0">
      <dt className="text-muted">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
