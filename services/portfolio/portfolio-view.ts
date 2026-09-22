/*
  The shapes the portfolio's server half hands to its client half.

  No `server-only` here: the scope is built on the server and consumed in a client
  component, so both need these types.

  Amounts are decimal wei STRINGS — bigint cannot cross into a client component and a
  number would lose precision on a balance. `null` always means "not available" and never
  zero, which is what lets the UI render "--" from the absence itself.

  Nothing here is a contract object. The client receives plain data and re-reads the chain
  itself for wallet-specific values, because a wallet address only exists in the browser.
*/

/** One pair in Poolix's discovered universe, as the portfolio needs to see it. */
export interface ScopedPair {
  readonly pair: string;
  readonly token0: string;
  readonly token1: string;
  readonly symbol0: string;
  readonly symbol1: string;
  readonly decimals0: number;
  readonly decimals1: number;
  /** "none" for a token/token pair, which is listed but cannot be valued. */
  readonly wethSide: "token0" | "token1" | "none";
  /** From Phase 4's PairCreated lookup, when that pool is in its universe. */
  readonly createdAt: number | null;
}

/** A token worth asking the wallet about, drawn from the same discovered pools. */
export interface ScopedToken {
  readonly address: string;
  readonly symbol: string;
  readonly decimals: number;
  /** Reserves of the deepest pool holding it, for pricing through the pool ratio. */
  readonly tokenReserveWei: string;
  readonly wethReserveWei: string;
  /** True when this token is in the tracked universe the analytics page reports on. */
  readonly tracked: boolean;
}

export interface EthUsdView {
  readonly answer: string;
  readonly decimals: number;
  readonly description: string;
}

/**
 * Everything the client needs that does NOT depend on the wallet.
 *
 * Assembled once on the server from the existing pool and token universes, so the
 * portfolio can never disagree with the analytics pages about which pools exist.
 */
export interface PortfolioScope {
  readonly available: boolean;
  readonly chainId: number;
  readonly nativeSymbol: string;
  readonly weth: string;
  readonly pairs: readonly ScopedPair[];
  readonly tokens: readonly ScopedToken[];
  /** Null when the feed is unavailable or stale; then nothing shows a USD figure. */
  readonly ethUsd: EthUsdView | null;
  /** How the universe was bounded, stated on the page rather than implied. */
  readonly poolsScanned: number;
  readonly pairsTotal: number;
  readonly scanComplete: boolean;
}

export interface TokenHoldingView {
  readonly address: string;
  readonly symbol: string;
  readonly decimals: number;
  readonly balanceWei: string;
  /** Value in wei of the native asset, or null when no pool can price it. */
  readonly valueEthWei: string | null;
  readonly valueUsdCents: string | null;
  /** True when metadata could not be read and the row falls back to its address. */
  readonly metadataMissing: boolean;
  readonly isNative: boolean;
  readonly tracked: boolean;
}

/** One LP position, in the shape the page renders. */
export interface LpPositionView {
  readonly pairAddress: string;
  readonly token0Address: string;
  readonly token1Address: string;
  readonly token0Symbol: string;
  readonly token1Symbol: string;
  readonly token0Decimals: number;
  readonly token1Decimals: number;
  readonly userLpBalance: string;
  readonly totalSupply: string;
  /** Already formatted by the one share formatter, e.g. "0.184%". */
  readonly share: string | null;
  readonly reserve0: string;
  readonly reserve1: string;
  readonly userToken0Amount: string;
  readonly userToken1Amount: string;
  /** The position's value in the native asset. Null for a token/token pool. */
  readonly poolLiquidityEth: string | null;
  readonly valueUsdCents: string | null;
  readonly poolCreatedAt: number | null;
  readonly poolLink: string;
  readonly wethSide: "token0" | "token1" | "none";
}

export interface PortfolioTotals {
  /** Sum over holdings that carried a validated price. Null when none did. */
  readonly usdCents: string | null;
  readonly valued: number;
  readonly unvalued: number;
  /** False means "partial valuation" — some holdings are absent from the total. */
  readonly complete: boolean;
}

export interface PortfolioView {
  readonly tokens: readonly TokenHoldingView[];
  readonly positions: readonly LpPositionView[];
  readonly totals: PortfolioTotals;
  /** The block the reads were made around. Reads are not atomic across it. */
  readonly blockNumber: number | null;
  /** Reads that failed, so a partial portfolio can say so instead of looking empty. */
  readonly failedReads: number;
  readonly readAt: number;
}
