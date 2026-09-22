import {
  DEFAULT_NETWORK,
  isPoolixNetwork,
  robinhoodNetworks,
  type PoolixNetwork,
  type RobinhoodNetwork,
} from "@/config/chains";
import type { Address } from "@/types/web3";

/**
 * `verified` means the address is a constant in config/chains.ts that was checked
 * onchain; `env` means a deployment-specific override was supplied.
 */
export type ContractConfig =
  | { readonly status: "configured"; readonly address: Address; readonly source: "verified" | "env" }
  | { readonly status: "not-configured" }
  | { readonly status: "invalid"; readonly value: string };

export interface PublicEnv {
  readonly network: string | undefined;
  readonly rpcUrl: string | undefined;
  readonly uniswapV2Factory: string | undefined;
  readonly uniswapV2Router: string | undefined;
}

export interface PoolixConfig {
  readonly network: PoolixNetwork;
  readonly chain: RobinhoodNetwork["chain"];
  readonly rpcUrl: string;
  readonly explorerUrl: string;
  readonly contracts: {
    readonly weth: Address;
    readonly permit2: Address;
    readonly l2Multicall: Address;
    /** Null where the network has no verified ETH/USD feed; USD values then read `--`. */
    readonly chainlinkEthUsd: Address | null;
    readonly uniswapV2: {
      readonly factory: ContractConfig;
      readonly router: ContractConfig;
    };
  };
}

export class PoolixConfigError extends Error {
  override readonly name = "PoolixConfigError";
}

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS_PATTERN = /^0x0{40}$/;
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1"]);

function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** An env override wins when present; otherwise the verified constant is used. */
export function resolveContract(value: string | undefined, verified?: Address): ContractConfig {
  const candidate = nonBlank(value);
  if (candidate === undefined) {
    return verified ? { status: "configured", address: verified, source: "verified" } : { status: "not-configured" };
  }
  if (!ADDRESS_PATTERN.test(candidate) || ZERO_ADDRESS_PATTERN.test(candidate)) {
    return { status: "invalid", value: candidate };
  }
  return { status: "configured", address: candidate as Address, source: "env" };
}

function resolveNetwork(value: string | undefined): PoolixNetwork {
  const candidate = nonBlank(value);
  if (candidate === undefined) return DEFAULT_NETWORK;
  if (!isPoolixNetwork(candidate)) {
    throw new PoolixConfigError(
      `NEXT_PUBLIC_POOLIX_NETWORK must be "testnet" or "mainnet", received "${candidate}".`,
    );
  }
  return candidate;
}

/**
 * Shapes that mean "this URL carries a credential".
 *
 * Commercial RPC providers issue keys as a path segment, a query parameter or HTTP
 * userinfo. Any of those in NEXT_PUBLIC_RPC_URL would be inlined into the client bundle
 * and served to every visitor, so the check is on the URL's structure rather than on
 * recognising a particular vendor's format.
 */
function credentialInUrl(url: URL): string | null {
  if (url.username !== "" || url.password !== "") return "userinfo (user:password@host)";
  if (url.search !== "") return "a query string";

  // A path is normal for an RPC endpoint (/query, /rpc). A long opaque segment is a key.
  const opaque = url.pathname
    .split("/")
    .filter((segment) => segment.length >= 16 && /^[A-Za-z0-9_-]+$/.test(segment));
  if (opaque.length > 0) return "an opaque path segment that looks like an API key";

  return null;
}

export function resolveRpcUrl(value: string | undefined, fallback: string): string {
  const candidate = nonBlank(value);
  if (candidate === undefined) return fallback;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new PoolixConfigError("NEXT_PUBLIC_RPC_URL is not a valid URL.");
  }

  const isSecure = url.protocol === "https:";
  const isLocalHttp = url.protocol === "http:" && LOCAL_HOSTNAMES.has(url.hostname);
  if (!isSecure && !isLocalHttp) {
    throw new PoolixConfigError("NEXT_PUBLIC_RPC_URL must use https (http is allowed only for localhost).");
  }

  /*
    Fail closed on a credentialed URL rather than publishing it.

    NEXT_PUBLIC_ variables are inlined into the browser bundle by design, so a key placed
    here is not "leaked later" — it is published to every visitor on the first request, and
    deleting the variable afterwards does not un-publish the bundles already served. The
    variable's name invites the mistake, so refusing to start is the only warning that
    arrives in time.

    The message names the shape, never the value.
  */
  const credential = credentialInUrl(url);
  if (credential !== null) {
    throw new PoolixConfigError(
      `NEXT_PUBLIC_RPC_URL appears to contain ${credential}. NEXT_PUBLIC_ values are ` +
        "inlined into the browser bundle, so this would publish the credential to every " +
        "visitor. Use the server-only RPC_URL for a credentialed endpoint, and leave " +
        "NEXT_PUBLIC_RPC_URL either unset or pointing at a public endpoint.",
    );
  }
  return candidate;
}

export function resolvePoolixConfig(env: PublicEnv): PoolixConfig {
  const network = resolveNetwork(env.network);
  const { chain, contracts } = robinhoodNetworks[network];
  const [defaultRpcUrl] = chain.rpcUrls.default.http;
  if (defaultRpcUrl === undefined) {
    throw new PoolixConfigError(`No default RPC URL defined for ${chain.name}.`);
  }

  return {
    network,
    chain,
    rpcUrl: resolveRpcUrl(env.rpcUrl, defaultRpcUrl),
    explorerUrl: chain.blockExplorers.default.url,
    contracts: {
      weth: contracts.weth,
      permit2: contracts.permit2,
      l2Multicall: contracts.l2Multicall,
      chainlinkEthUsd: contracts.chainlinkEthUsd,
      uniswapV2: {
        factory: resolveContract(env.uniswapV2Factory, contracts.uniswapV2?.factory),
        router: resolveContract(env.uniswapV2Router, contracts.uniswapV2?.router),
      },
    },
  };
}

/** True only when both v2 contracts resolved to a usable address. */
export function isUniswapV2Available(config: PoolixConfig): boolean {
  return (
    config.contracts.uniswapV2.factory.status === "configured" &&
    config.contracts.uniswapV2.router.status === "configured"
  );
}
