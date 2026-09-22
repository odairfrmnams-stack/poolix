/*
  Checks the constants in config/chains.ts against the live chain.

    npm run verify:chain              # default network
    npm run verify:chain -- testnet

  Every address Poolix ships is asserted here rather than trusted from a document,
  because a wrong router or factory address routes user funds to the wrong contract.
*/

import {
  createPublicClient,
  getAddress,
  getCreate2Address,
  encodePacked,
  http,
  keccak256,
  parseAbi,
  type Address,
  type PublicClient,
} from "viem";

import { isPoolixNetwork, robinhoodNetworks, type PoolixNetwork } from "@/config/chains";
import { getAmountOut } from "@/services/liquidity/uniswap-v2/math";

/** Canonical UniswapV2Pair creation code hash, used to derive pair addresses offchain. */
const CANONICAL_INIT_CODE_HASH = "0x96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f";

const routerAbi = parseAbi([
  "function factory() view returns (address)",
  "function WETH() view returns (address)",
  "function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[])",
]);

const factoryAbi = parseAbi([
  "function allPairsLength() view returns (uint256)",
  "function allPairs(uint256) view returns (address)",
  "function getPair(address,address) view returns (address)",
  "function feeTo() view returns (address)",
]);

const pairAbi = parseAbi([
  "function factory() view returns (address)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
]);

const erc20Abi = parseAbi([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);

const multicall3Abi = parseAbi([
  "function getBlockNumber() view returns (uint256)",
  "function getEthBalance(address) view returns (uint256)",
]);

let failures = 0;
let checks = 0;

function record(label: string, actual: unknown, expected?: unknown): void {
  checks++;
  if (expected === undefined) {
    console.log(`  ·    ${label.padEnd(40)} ${String(actual)}`);
    return;
  }
  const ok = String(actual).toLowerCase() === String(expected).toLowerCase();
  if (!ok) failures++;
  console.log(
    `  ${ok ? "PASS" : "FAIL"} ${label.padEnd(40)} ${String(actual)}${ok ? "" : `\n       expected ${String(expected)}`}`,
  );
}

function section(title: string): void {
  console.log(`\n${title}\n${"-".repeat(title.length)}`);
}

async function verifyUniswapV2(client: PublicClient, network: PoolixNetwork): Promise<void> {
  const { contracts } = robinhoodNetworks[network];
  const deployment = contracts.uniswapV2;

  section("Uniswap v2");
  if (deployment === null) {
    console.log("  config declares no Uniswap v2 deployment on this network.");
    const codes = await Promise.all(
      [robinhoodNetworks.mainnet.contracts.uniswapV2?.factory, robinhoodNetworks.mainnet.contracts.uniswapV2?.router]
        .filter((address): address is Address => address !== undefined)
        .map((address) => client.getCode({ address })),
    );
    record("mainnet addresses hold no code here", codes.every((code) => code === undefined || code === "0x"), "true");
    return;
  }

  const { factory, router } = deployment;
  const [routerFactory, routerWeth] = await Promise.all([
    client.readContract({ address: router, abi: routerAbi, functionName: "factory" }),
    client.readContract({ address: router, abi: routerAbi, functionName: "WETH" }),
  ]);
  record("router.factory()", getAddress(routerFactory), factory);
  record("router.WETH()", getAddress(routerWeth), contracts.weth);

  const pairCount = await client.readContract({
    address: factory,
    abi: factoryAbi,
    functionName: "allPairsLength",
  });
  record("factory.allPairsLength()", pairCount);
  record("factory has pairs", pairCount > 0n, "true");

  const feeTo = await client.readContract({ address: factory, abi: factoryAbi, functionName: "feeTo" });
  const protocolFeeOn = getAddress(feeTo) !== "0x0000000000000000000000000000000000000000";
  record("factory.feeTo() (protocol fee on)", `${getAddress(feeTo)} -> ${protocolFeeOn}`);

  if (pairCount === 0n) return;

  section("Pair derivation and fee math");
  const weth = getAddress(contracts.weth);
  let sampled = 0;

  for (let index = 0n; index < pairCount && sampled < 3; index++) {
    const pair = await client.readContract({
      address: factory,
      abi: factoryAbi,
      functionName: "allPairs",
      args: [index],
    });

    const [token0, token1, reserves, pairFactory] = await Promise.all([
      client.readContract({ address: pair, abi: pairAbi, functionName: "token0" }),
      client.readContract({ address: pair, abi: pairAbi, functionName: "token1" }),
      client.readContract({ address: pair, abi: pairAbi, functionName: "getReserves" }),
      client.readContract({ address: pair, abi: pairAbi, functionName: "factory" }),
    ]);

    const [reserve0, reserve1] = reserves;
    if (reserve0 === 0n || reserve1 === 0n) continue;
    if (getAddress(token0) !== weth && getAddress(token1) !== weth) continue;
    sampled++;

    console.log(`\n  pair #${index} ${getAddress(pair)}`);
    record("pair.factory()", getAddress(pairFactory), factory);

    // getPair must round-trip, and the offchain CREATE2 derivation must agree with it.
    const looked = await client.readContract({
      address: factory,
      abi: factoryAbi,
      functionName: "getPair",
      args: [token0, token1],
    });
    record("factory.getPair(token0,token1)", getAddress(looked), getAddress(pair));

    const derived = getCreate2Address({
      from: factory,
      salt: keccak256(encodePacked(["address", "address"], [token0, token1])),
      bytecodeHash: CANONICAL_INIT_CODE_HASH,
    });
    record("CREATE2 derivation (canonical hash)", derived, getAddress(pair));

    const wethIsToken0 = getAddress(token0) === weth;
    const reserveIn = wethIsToken0 ? reserve0 : reserve1;
    const reserveOut = wethIsToken0 ? reserve1 : reserve0;
    const tokenOut = wethIsToken0 ? token1 : token0;

    const symbol = await client
      .readContract({ address: tokenOut, abi: erc20Abi, functionName: "symbol" })
      .catch(() => "?");
    console.log(`       WETH / ${symbol}`);

    for (const amountIn of [10n ** 15n, 10n ** 16n, 10n ** 17n]) {
      const [, onchain] = await client.readContract({
        address: router,
        abi: routerAbi,
        functionName: "getAmountsOut",
        args: [amountIn, [weth, tokenOut]],
      });
      const local = getAmountOut(amountIn, { reserveIn, reserveOut });
      record(`getAmountsOut(${amountIn})`, local, onchain);
    }
  }
}

async function verifyMulticall(client: PublicClient, network: PoolixNetwork, l2Multicall: Address): Promise<void> {
  const { chain, contracts } = robinhoodNetworks[network];
  section("L2 Multicall");
  const code = await client.getCode({ address: l2Multicall });
  record("code deployed", code !== undefined && code !== "0x", "true");

  /*
    HANDOFF item 3: confirm this is Multicall3 before wiring it into viem's multicall3 slot.
    The decisive test is aggregate3, which is the function viem's multicall calls. Note that
    Multicall3.getBlockNumber() returns `block.number`, which on this Arbitrum-stack L2 is the
    L1 block height, not the L2 height from eth_blockNumber. That difference is expected and
    is why Robinhood ships an L2-specific Multicall build.
  */
  try {
    await client.readContract({
      address: l2Multicall,
      abi: multicall3Abi,
      functionName: "getEthBalance",
      args: [l2Multicall],
    });
    record("Multicall3 getEthBalance() present", true, "true");

    const reportedBlock = await client.readContract({
      address: l2Multicall,
      abi: multicall3Abi,
      functionName: "getBlockNumber",
    });
    console.log(`  ·    block.number vs eth_blockNumber      ${reportedBlock} vs ${await client.getBlockNumber()}`);

    // Batch two reads through aggregate3 and compare against the same reads made individually.
    const batchClient = createPublicClient({
      chain: { ...chain, contracts: { multicall3: { address: l2Multicall } } },
      transport: http(client.transport.url as string),
    }) as PublicClient;

    const [batchedSymbol, batchedDecimals] = await batchClient.multicall({
      allowFailure: false,
      contracts: [
        { address: contracts.weth, abi: erc20Abi, functionName: "symbol" },
        { address: contracts.weth, abi: erc20Abi, functionName: "decimals" },
      ],
    });
    record("aggregate3 batched weth.symbol()", batchedSymbol, "WETH");
    record("aggregate3 batched weth.decimals()", batchedDecimals, 18);
    console.log("       -> Multicall3-compatible; safe for viem's multicall3 slot.");
  } catch (error) {
    console.log("  ·    aggregate3 unavailable; not a Multicall3.");
    console.log(`       ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    await probeLegacyMulticall(client, l2Multicall, contracts.weth);
  }
}

/** Reports which older multicall interface the contract exposes, if any. */
async function probeLegacyMulticall(client: PublicClient, multicall: Address, weth: Address): Promise<void> {
  const symbolCall = { target: weth, callData: "0x95d89b41" as const };
  const probes = [
    {
      name: "aggregate((address,bytes)[])",
      abi: parseAbi(["function aggregate((address target, bytes callData)[]) returns (uint256, bytes[])"]),
      args: [[symbolCall]],
    },
    {
      name: "tryAggregate(bool,(address,bytes)[])",
      abi: parseAbi([
        "function tryAggregate(bool requireSuccess, (address target, bytes callData)[]) returns ((bool success, bytes returnData)[])",
      ]),
      args: [false, [symbolCall]],
    },
  ] as const;

  const supported: string[] = [];
  for (const probe of probes) {
    try {
      await client.simulateContract({
        address: multicall,
        abi: probe.abi,
        functionName: probe.name.split("(")[0] as never,
        args: probe.args as never,
      });
      supported.push(probe.name);
    } catch {
      /* not supported */
    }
  }

  record("multicall interface", supported.length > 0 ? supported.join(", ") : "none detected");
  console.log(
    "       -> Do NOT set chain.contracts.multicall3. Poolix batches reads with\n" +
      "          JSON-RPC request batching (http transport `batch: true`) instead.",
  );
}

async function main(): Promise<void> {
  const requested = process.argv[2];
  if (requested !== undefined && !isPoolixNetwork(requested)) {
    throw new Error(`Unknown network "${requested}". Use "mainnet" or "testnet".`);
  }
  const network: PoolixNetwork = requested ?? "mainnet";
  const { chain, contracts } = robinhoodNetworks[network];
  const rpcUrl = process.env.RPC_URL ?? chain.rpcUrls.default.http[0];
  if (rpcUrl === undefined) throw new Error(`No RPC URL configured for ${chain.name}.`);

  console.log(`Poolix deployment verification\nnetwork: ${network} (${chain.name})\nrpc:     ${rpcUrl}`);

  const client = createPublicClient({ transport: http(rpcUrl) }) as PublicClient;

  section("Chain");
  record("eth_chainId", await client.getChainId(), chain.id);
  record("block number", await client.getBlockNumber());

  section("WETH");
  const [symbol, decimals] = await Promise.all([
    client.readContract({ address: contracts.weth, abi: erc20Abi, functionName: "symbol" }),
    client.readContract({ address: contracts.weth, abi: erc20Abi, functionName: "decimals" }),
  ]);
  record("weth.symbol()", symbol, "WETH");
  record("weth.decimals()", decimals, 18);

  await verifyMulticall(client, network, contracts.l2Multicall);
  await verifyUniswapV2(client, network);

  console.log(
    `\n${failures === 0 ? `All ${checks} checks passed.` : `${failures} of ${checks} checks FAILED.`}`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
