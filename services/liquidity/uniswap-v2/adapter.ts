import { encodeFunctionData, getAddress, type PublicClient } from "viem";

import type { PoolixConfig } from "@/config/resolve";
import { uniswapV2PairAbi, uniswapV2RouterAbi } from "@/services/abis/uniswap-v2";
import type {
  ExactInSwapRequest,
  LiquiditySource,
  PreparedCall,
  SourceAvailability,
  SwapExecutionParams,
  SwapQuote,
} from "@/services/liquidity/types";
import { applySlippage, getAmountsOut, priceImpactBps, type Reserves } from "@/services/liquidity/uniswap-v2/math";
import { computePairAddress, sortTokens } from "@/services/liquidity/uniswap-v2/pair";
import { currencyAddress } from "@/services/tokens/currency";
import type { Address } from "@/types/web3";

/** Longest route Poolix will quote. Two hops covers direct pairs and WETH-bridged pairs. */
const MAX_HOPS = 2;

export class QuoteAbortedError extends Error {
  override readonly name = "QuoteAbortedError";
}

interface PathCandidate {
  readonly path: readonly Address[];
  readonly reserves: readonly Reserves[];
  readonly amountOut: bigint;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new QuoteAbortedError("The quote was superseded.");
}

/**
 * Candidate routes, cheapest first. A direct pair is always tried; when neither side
 * is WETH, the WETH-bridged route is tried too, because most pairs on this chain are
 * quoted against WETH.
 */
function buildPaths(tokenIn: Address, tokenOut: Address, weth: Address): readonly Address[][] {
  const direct: Address[] = [tokenIn, tokenOut];
  if (tokenIn === weth || tokenOut === weth) return [direct];
  return [direct, [tokenIn, weth, tokenOut]];
}

/**
 * Reads the reserves behind each hop of a path, oriented for the swap direction.
 * Pair addresses are derived with CREATE2 rather than looked up, and token0 is known
 * from address ordering, so a hop costs a single getReserves call.
 * Returns null when any hop has no pair or no liquidity.
 */
async function readPathReserves(
  client: PublicClient,
  factory: Address,
  path: readonly Address[],
): Promise<readonly Reserves[] | null> {
  const hops: { from: Address; to: Address }[] = [];
  for (let index = 0; index < path.length - 1; index++) {
    const from = path[index];
    const to = path[index + 1];
    if (from === undefined || to === undefined) return null;
    hops.push({ from, to });
  }
  if (hops.length === 0 || hops.length > MAX_HOPS) return null;

  const results = await Promise.all(
    hops.map(async ({ from, to }): Promise<Reserves | null> => {
      try {
        const pair = computePairAddress(factory, from, to);
        const [reserve0, reserve1] = await client.readContract({
          address: pair,
          abi: uniswapV2PairAbi,
          functionName: "getReserves",
        });
        if (reserve0 === 0n || reserve1 === 0n) return null;

        const [token0] = sortTokens(from, to);
        return getAddress(from) === token0
          ? { reserveIn: reserve0, reserveOut: reserve1 }
          : { reserveIn: reserve1, reserveOut: reserve0 };
      } catch {
        // No pair deployed at the derived address, or it holds no reserves.
        return null;
      }
    }),
  );

  return results.every((reserves): reserves is Reserves => reserves !== null) ? results : null;
}

export function createUniswapV2Source(client: PublicClient, config: PoolixConfig): LiquiditySource {
  const { factory, router } = config.contracts.uniswapV2;
  const weth = getAddress(config.contracts.weth);

  function getAvailability(): SourceAvailability {
    if (factory.status === "invalid" || router.status === "invalid") {
      return { available: false, reason: "contractInvalid" };
    }
    if (factory.status !== "configured" || router.status !== "configured") {
      return { available: false, reason: "contractNotConfigured" };
    }
    return { available: true };
  }

  function addresses(): { factory: Address; router: Address } | null {
    if (factory.status !== "configured" || router.status !== "configured") return null;
    return { factory: factory.address, router: router.address };
  }

  return {
    id: "uniswap-v2",
    getAvailability,

    async quoteExactIn(request: ExactInSwapRequest, signal?: AbortSignal): Promise<SwapQuote | null> {
      const resolved = addresses();
      if (resolved === null || request.amountIn <= 0n) return null;

      const tokenIn = currencyAddress(request.currencyIn, weth);
      const tokenOut = currencyAddress(request.currencyOut, weth);
      if (tokenIn === tokenOut) return null;

      throwIfAborted(signal);

      const candidates = await Promise.all(
        buildPaths(tokenIn, tokenOut, weth).map(async (path): Promise<PathCandidate | null> => {
          const reserves = await readPathReserves(client, resolved.factory, path);
          if (reserves === null) return null;
          try {
            const amounts = getAmountsOut(request.amountIn, reserves);
            const amountOut = amounts[amounts.length - 1];
            if (amountOut === undefined || amountOut <= 0n) return null;
            return { path, reserves, amountOut };
          } catch {
            // Amount too small to produce output through this route.
            return null;
          }
        }),
      );

      throwIfAborted(signal);

      const [best] = candidates
        .filter((candidate): candidate is PathCandidate => candidate !== null)
        .sort((a, b) => (b.amountOut > a.amountOut ? 1 : b.amountOut < a.amountOut ? -1 : 0));
      if (best === undefined) return null;

      /*
        Reserves were read one call earlier, so the router is asked to price the chosen
        route as well. Its answer is what the swap will execute against, and it is the
        number shown to the user; the local figure only ranks the routes.
      */
      const [quotedAtBlock, onchainAmounts] = await Promise.all([
        client.getBlockNumber(),
        client.readContract({
          address: resolved.router,
          abi: uniswapV2RouterAbi,
          functionName: "getAmountsOut",
          args: [request.amountIn, best.path],
        }),
      ]);

      throwIfAborted(signal);

      const amountOut = onchainAmounts[onchainAmounts.length - 1];
      if (amountOut === undefined || amountOut <= 0n) return null;

      return {
        source: "uniswap-v2",
        request,
        amountOut,
        minimumAmountOut: applySlippage(amountOut, request.slippageBps),
        priceImpactBps: priceImpactBps(request.amountIn, amountOut, best.reserves),
        route: best.path,
        approvalSpender: request.currencyIn.kind === "native" ? null : resolved.router,
        quotedAtBlock,
      };
    },

    buildSwap({ quote, recipient, deadline }: SwapExecutionParams): PreparedCall {
      const resolved = addresses();
      if (resolved === null) {
        throw new Error("Uniswap v2 is not configured on this network.");
      }

      const { request, minimumAmountOut, route } = quote;
      const path = [...route];

      if (request.currencyIn.kind === "native") {
        return {
          to: resolved.router,
          data: encodeFunctionData({
            abi: uniswapV2RouterAbi,
            functionName: "swapExactETHForTokens",
            args: [minimumAmountOut, path, recipient, deadline],
          }),
          value: request.amountIn,
        };
      }

      if (request.currencyOut.kind === "native") {
        return {
          to: resolved.router,
          data: encodeFunctionData({
            abi: uniswapV2RouterAbi,
            functionName: "swapExactTokensForETH",
            args: [request.amountIn, minimumAmountOut, path, recipient, deadline],
          }),
          value: 0n,
        };
      }

      return {
        to: resolved.router,
        data: encodeFunctionData({
          abi: uniswapV2RouterAbi,
          functionName: "swapExactTokensForTokens",
          args: [request.amountIn, minimumAmountOut, path, recipient, deadline],
        }),
        value: 0n,
      };
    },
  };
}
