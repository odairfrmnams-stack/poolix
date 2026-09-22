import type { Metadata } from "next";

import { CodeBlock } from "@/components/docs/code-block";
import { Notice } from "@/components/ui/notice";
import { poolixConfig } from "@/config/poolix";

export const metadata: Metadata = {
  title: "Integration",
  description: `Quote and execute swaps against ${poolixConfig.chain.name} using Poolix's service layer.`,
};

export default function IntegrationPage() {
  const { chain, rpcUrl } = poolixConfig;

  return (
    <article className="space-y-10">
      <header>
        <h1 className="text-2xl font-semibold tracking-[-0.02em]">Integration</h1>
        <p className="mt-3 text-[14px] leading-relaxed text-muted">
          Poolix&rsquo;s service layer is plain TypeScript over viem, with no React dependency. The
          same functions that drive the interface can be imported directly.
        </p>
      </header>

      <section className="space-y-4">
        <h2 className="text-[16px] font-medium text-fg">Connect a client</h2>
        <CodeBlock label="TypeScript">{`import { createPublicClient, http } from "viem";
import { resolvePoolixConfig } from "@/config/resolve";
import { createUniswapV2Source } from "@/services/liquidity/uniswap-v2/adapter";

const config = resolvePoolixConfig({
  network: "${poolixConfig.network}",
  rpcUrl: undefined,
  uniswapV2Factory: undefined,
  uniswapV2Router: undefined,
});

const client = createPublicClient({
  transport: http(config.rpcUrl, { batch: { wait: 16 } }),
});

const source = createUniswapV2Source(client, config);`}</CodeBlock>
        <p className="text-[13px] leading-relaxed text-muted">
          The transport batches JSON-RPC requests rather than using a multicall contract,
          because {chain.name}&rsquo;s L2 Multicall has no{" "}
          <code className="poolix-numeric text-subtle">aggregate3</code>.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-[16px] font-medium text-fg">Quote a swap</h2>
        <p className="text-[14px] leading-relaxed text-muted">
          <code className="poolix-numeric text-subtle">quoteExactIn</code> ranks the direct pair
          against the WETH-bridged route, then asks the router to price the winner. It resolves
          to <code className="poolix-numeric text-subtle">null</code> when no route exists — it
          never returns an estimate it could not confirm onchain.
        </p>
        <CodeBlock label="TypeScript">{`const quote = await source.quoteExactIn({
  currencyIn: { kind: "native", symbol: "${chain.nativeCurrency.symbol}", decimals: 18 },
  currencyOut: {
    kind: "erc20",
    address: "0x…",
    symbol: "TOKEN",
    name: "Token",
    decimals: 18,
  },
  amountIn: 10n ** 16n,  // 0.01 ${chain.nativeCurrency.symbol}
  slippageBps: 50,       // 0.50%
});

if (quote === null) {
  // No pool with liquidity for this pair.
} else {
  quote.amountOut;        // bigint, from router.getAmountsOut
  quote.minimumAmountOut; // amountOut floored by slippageBps
  quote.priceImpactBps;   // excludes the LP fee, which is shown separately
  quote.route;            // [tokenIn, …, tokenOut]
  quote.approvalSpender;  // null when the input is native
}`}</CodeBlock>
      </section>

      <section className="space-y-4">
        <h2 className="text-[16px] font-medium text-fg">Build the transaction</h2>
        <p className="text-[14px] leading-relaxed text-muted">
          <code className="poolix-numeric text-subtle">buildSwap</code> returns calldata rather
          than sending anything, so the caller decides how it is signed. Stamp the deadline at
          the moment of sending, not when quoting.
        </p>
        <CodeBlock label="TypeScript">{`const call = source.buildSwap({
  quote,
  recipient: account,
  deadline: BigInt(Math.floor(Date.now() / 1000) + 20 * 60),
});

// call.to, call.data, call.value — pass to your signer.`}</CodeBlock>
        <Notice title="Simulate before you prompt a wallet">
          Poolix runs <code className="poolix-numeric">eth_call</code> against the prepared
          transaction first. A revert caught there surfaces the real reason — slippage, an
          expired deadline, missing liquidity — instead of an opaque wallet estimation failure.
        </Notice>
      </section>

      <section className="space-y-4">
        <h2 className="text-[16px] font-medium text-fg">Derive a pair address</h2>
        <p className="text-[14px] leading-relaxed text-muted">
          Pair addresses are deterministic, so a lookup costs nothing. This derivation is
          asserted against live pairs by <code className="poolix-numeric text-subtle">npm run verify:chain</code>.
        </p>
        <CodeBlock label="TypeScript">{`import { computePairAddress } from "@/services/liquidity/uniswap-v2/pair";

const pair = computePairAddress(factory, tokenA, tokenB);
// Argument order does not matter; the result is checksummed.`}</CodeBlock>
      </section>

      <section className="space-y-4">
        <h2 className="text-[16px] font-medium text-fg">Environment</h2>
        <CodeBlock label=".env.local">{`NEXT_PUBLIC_POOLIX_NETWORK=${poolixConfig.network}

# Browser RPC. Visible to every visitor, so never a keyed URL.
NEXT_PUBLIC_RPC_URL=

# Server-only RPC, used by route handlers and the pool scan.
# A keyed provider widens the scan and enables archive queries.
RPC_URL=

# How many of the newest pairs the pool scan looks at.
POOLIX_POOL_SCAN_WINDOW=400`}</CodeBlock>
        <p className="text-[13px] leading-relaxed text-muted">
          Chain ID, explorer, WETH and the Uniswap deployment are not environment variables.
          They are verified constants; only values that genuinely vary per deployment live in
          the environment. Default RPC today: <code className="poolix-numeric text-subtle">{rpcUrl}</code>.
        </p>
      </section>
    </article>
  );
}
