/*
  Historical Fee APR. Pure arithmetic — no I/O, no network, no state.

  This is a measurement of what already happened, annualized. It is not a projection, not
  a yield, and not compounded: there is deliberately no APY here, because compounding
  would assert that fees were reinvested, which nothing in the data says.

      APR = (fees over W / time-weighted average liquidity over W)
            x (year / W)
            x 100

  Both sides are ETH, so the ratio is dimensionless and the result is a percentage.

  PRECISION. Every value arriving here is a raw on-chain integer in wei, and a uint112
  reserve does not survive a double. So the whole calculation is one integer expression
  with a single division at the end:

      aprScaled = fees x SUM(duration) x year x 100 x SCALE
                  ------------------------------------------
                  SUM(liquidity x duration) x windowSeconds

  Folding the time-weighted average into the same fraction matters: computing TWAL first
  would truncate once, then truncate again on the division, and the error compounds at
  exactly the low-liquidity end where APR is largest. One division truncates once.
*/

/** 365 days. Not 365.25: the window is annualized against a plain year, stated as such. */
export const YEAR_SECONDS = 365 * 24 * 60 * 60;

/** APR is carried as an integer scaled by this, giving six decimal places of a percent. */
export const APR_SCALE = 1_000_000n;

export interface LiquiditySample {
  readonly startTimestamp: number;
  /** Duration this snapshot represents, in seconds. */
  readonly durationSeconds: number;
  /** ETH liquidity held, in wei. */
  readonly liquidityWei: bigint;
}

export interface AprInput {
  /** Fees earned over the window, in wei, from the SAME pools as the samples. */
  readonly feesWei: bigint;
  readonly samples: readonly LiquiditySample[];
  /** The window's own length, from its real boundaries. */
  readonly windowSeconds: number;
}

export interface AprResult {
  /** APR as a percentage scaled by APR_SCALE, or null when it cannot be computed. */
  readonly aprScaled: bigint | null;
  /** Time-weighted average liquidity, in wei. Null when there is no weight to average. */
  readonly twalWei: bigint | null;
  /** SUM(liquidity x duration), kept so a verifier can reproduce the division. */
  readonly weightedWei: bigint;
  readonly totalDurationSeconds: number;
  readonly reason: "ok" | "no-samples" | "zero-duration" | "zero-liquidity" | "zero-window";
}

/**
 * Time-weighted average liquidity.
 *
 * Weighted by each snapshot's real duration rather than assuming every bucket is the
 * same length. The hourly grid is in fact uniform, verified, but encoding that assumption
 * here would make the function quietly wrong the first time it is not.
 */
export function timeWeightedLiquidity(samples: readonly LiquiditySample[]): {
  weightedWei: bigint;
  totalDurationSeconds: number;
  twalWei: bigint | null;
} {
  let weightedWei = 0n;
  let totalDurationSeconds = 0;

  for (const sample of samples) {
    if (sample.durationSeconds <= 0) continue;
    weightedWei += sample.liquidityWei * BigInt(sample.durationSeconds);
    totalDurationSeconds += sample.durationSeconds;
  }

  return {
    weightedWei,
    totalDurationSeconds,
    twalWei: totalDurationSeconds > 0 ? weightedWei / BigInt(totalDurationSeconds) : null,
  };
}

/**
 * Historical Fee APR for one window.
 *
 * Returns null rather than a number whenever the calculation has no meaning — no
 * samples, no duration, or no liquidity to divide by. Zero liquidity is the important
 * one: it is not an infinite return, it is an absence of a denominator, and the caller
 * must show it as unavailable rather than as a very large figure.
 *
 * No cap is applied. A genuinely high APR over genuinely thin liquidity is a real
 * measurement and clamping it would be the fabrication, not the honesty.
 */
export function historicalFeeApr(input: AprInput): AprResult {
  const { weightedWei, totalDurationSeconds, twalWei } = timeWeightedLiquidity(input.samples);

  if (input.samples.length === 0) {
    return { aprScaled: null, twalWei: null, weightedWei, totalDurationSeconds, reason: "no-samples" };
  }
  if (totalDurationSeconds <= 0) {
    return { aprScaled: null, twalWei: null, weightedWei, totalDurationSeconds, reason: "zero-duration" };
  }
  if (input.windowSeconds <= 0) {
    return { aprScaled: null, twalWei, weightedWei, totalDurationSeconds, reason: "zero-window" };
  }
  if (weightedWei <= 0n) {
    // Dividing here would be Infinity or NaN; neither is a fact about the window.
    return { aprScaled: null, twalWei, weightedWei, totalDurationSeconds, reason: "zero-liquidity" };
  }

  // One division, on integers, at the end. See the note at the top of this file.
  const numerator =
    input.feesWei * BigInt(totalDurationSeconds) * BigInt(YEAR_SECONDS) * 100n * APR_SCALE;
  const denominator = weightedWei * BigInt(input.windowSeconds);

  return {
    aprScaled: numerator / denominator,
    twalWei,
    weightedWei,
    totalDurationSeconds,
    reason: "ok",
  };
}

/**
 * Formats a scaled APR for display.
 *
 * Two decimals normally. A value that would round to 0.00 but is not zero gets enough
 * places to show it is small rather than absent — reporting a real return as "0.00%"
 * loses the only information it carries. No scientific notation, and no more precision
 * than the figure deserves at the large end.
 */
export function formatApr(aprScaled: bigint | null): string | null {
  if (aprScaled === null) return null;

  const negative = aprScaled < 0n;
  const magnitude = negative ? -aprScaled : aprScaled;

  const whole = magnitude / APR_SCALE;
  const fraction = magnitude % APR_SCALE;

  /*
    Below 0.01% a two-decimal rendering would read as zero, so show more — but only for
    a value that actually is non-zero. An exact zero is a plain zero and printing it as
    "0.000000%" would imply a precision that the figure does not carry.
  */
  const small = magnitude > 0n && whole === 0n && fraction < APR_SCALE / 100n;
  const decimals = small ? 6 : 2;
  const divisor = APR_SCALE / 10n ** BigInt(decimals);
  const rounded = (fraction + divisor / 2n) / divisor;

  // Rounding the fraction can carry into the whole part.
  const carry = rounded >= 10n ** BigInt(decimals) ? 1n : 0n;
  const finalWhole = whole + carry;
  const finalFraction = carry === 1n ? 0n : rounded;

  const body = `${finalWhole.toLocaleString("en-US")}.${finalFraction.toString().padStart(decimals, "0")}`;
  return `${negative ? "-" : ""}${body}%`;
}
