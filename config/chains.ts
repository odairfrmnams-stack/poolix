import type { Address } from "@/types/web3";

export type PoolixNetwork = "mainnet" | "testnet";

export interface ChainDefinition {
  readonly id: number;
  readonly name: string;
  readonly nativeCurrency: {
    readonly name: string;
    readonly symbol: string;
    readonly decimals: number;
  };
  readonly rpcUrls: {
    readonly default: { readonly http: readonly string[] };
    /** Robinhood's own endpoint. Rate-limited, and unreachable on some networks. */
    readonly robinhood: { readonly http: readonly string[] };
  };
  readonly blockExplorers: {
    readonly default: { readonly name: string; readonly url: string };
  };
  readonly testnet: boolean;
}

/** A Uniswap v2 deployment, or null where the protocol is not deployed. */
export interface UniswapV2Deployment {
  readonly factory: Address;
  readonly router: Address;
}

export interface NetworkContracts {
  readonly weth: Address;
  readonly permit2: Address;
  readonly l2Multicall: Address;
  readonly uniswapV2: UniswapV2Deployment | null;
  /** Chainlink ETH/USD aggregator, or null where no verified feed is known. */
  readonly chainlinkEthUsd: Address | null;
}

export interface RobinhoodNetwork {
  readonly chain: ChainDefinition;
  readonly contracts: NetworkContracts;
}

/*
  Network and protocol constants, verified 2026-09-17.

  Chain metadata follows https://docs.robinhood.com/chain/connecting and
  https://docs.robinhood.com/chain/protocol-contracts.

  Uniswap v2 addresses come from Uniswap's official deployments list
  (https://developers.uniswap.org/docs/protocols/v2/deployments) and were then
  confirmed onchain via `npm run verify:chain`:
    - router.factory() returns the factory below
    - router.WETH() returns the WETH below
    - both are verified source on Blockscout (UniswapV2Router02 / UniswapV2Factory)
    - getAmountsOut matches services/liquidity/uniswap-v2/math.ts exactly across
      sampled pairs, confirming the canonical 997/1000 fee

  The L2 Multicall is a Multicall2: it exposes aggregate and tryAggregate but not
  aggregate3. It is therefore deliberately NOT wired into viem's `multicall3` slot,
  which would revert. Poolix batches reads with JSON-RPC request batching instead
  (see lib/wagmi.ts). Re-check with `npm run verify:chain`.

  These are constants rather than environment variables for the same reason as the
  chain ID: a mistyped address in env is a silent misconfiguration that routes funds
  to the wrong contract. `.env` can still override them for a local fork or a future
  Poolix deployment; see config/resolve.ts.
*/
export const robinhoodNetworks: Readonly<Record<PoolixNetwork, RobinhoodNetwork>> = {
  mainnet: {
    chain: {
      id: 4663,
      name: "Robinhood Chain",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: {
        default: { http: ["https://robinhood-rpc.publicnode.com"] },
        robinhood: { http: ["https://rpc.mainnet.chain.robinhood.com"] },
      },
      blockExplorers: {
        default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" },
      },
      testnet: false,
    },
    contracts: {
      weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
      permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
      l2Multicall: "0x2cAC2D899eCC914d704FeaAE33ac1bF36277DaD1",
      uniswapV2: {
        factory: "0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f",
        router: "0x89e5DB8B5aA49aA85AC63f691524311AEB649eba",
      },
      /*
        Chainlink ETH/USD. Confirmed onchain 2026-09-18 by `npm run verify:tvl`:
        description() returns "ETH / USD", decimals() returns 8, version() 6, and
        latestRoundData() answers a positive price with answeredInRound >= roundId.
      */
      chainlinkEthUsd: "0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9",
    },
  },
  testnet: {
    chain: {
      id: 46630,
      name: "Robinhood Chain Testnet",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: {
        default: { http: ["https://robinhood-sepolia-rpc.publicnode.com"] },
        robinhood: { http: ["https://rpc.testnet.chain.robinhood.com"] },
      },
      blockExplorers: {
        default: { name: "Blockscout", url: "https://explorer.testnet.chain.robinhood.com" },
      },
      testnet: true,
    },
    contracts: {
      weth: "0x7943e237c7F95DA44E0301572D358911207852Fa",
      permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
      l2Multicall: "0xa432504b6F04Cafe775b09D8AA92e8dbe41Ec7a8",
      // Uniswap is not deployed on 46630: the mainnet factory and router addresses
      // hold no code there. Swap and pool surfaces report Contract Not Configured.
      uniswapV2: null,
      // No verified ETH/USD feed known for the testnet, so TVL reads "--" there.
      chainlinkEthUsd: null,
    },
  },
};

export const DEFAULT_NETWORK: PoolixNetwork = "mainnet";

export function isPoolixNetwork(value: string): value is PoolixNetwork {
  return value === "mainnet" || value === "testnet";
}
