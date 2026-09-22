import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isUniswapV2Available, PoolixConfigError, resolveContract, resolvePoolixConfig, resolveRpcUrl, type PublicEnv } from "@/config/resolve";

const emptyEnv: PublicEnv = {
  network: undefined,
  rpcUrl: undefined,
  uniswapV2Factory: undefined,
  uniswapV2Router: undefined,
};

const FALLBACK = "https://robinhood-rpc.publicnode.com";

/*
  NEXT_PUBLIC_RPC_URL is inlined into the browser bundle by design. A key placed there is
  not "leaked later" — it is published to every visitor on the first request, and removing
  the variable afterwards does not un-publish the bundles already served. So a credentialed
  URL has to fail at startup, while it can still be corrected.
*/
describe("resolveRpcUrl — credential exposure", () => {
  it("accepts a plain public endpoint", () => {
    assert.equal(resolveRpcUrl(FALLBACK, FALLBACK), FALLBACK);
    assert.equal(resolveRpcUrl(undefined, FALLBACK), FALLBACK);
    assert.equal(resolveRpcUrl("  ", FALLBACK), FALLBACK);
  });

  it("accepts a short, meaningful path", () => {
    // /rpc and /query are ordinary endpoint paths, not keys.
    assert.equal(resolveRpcUrl("https://node.example.com/rpc", FALLBACK), "https://node.example.com/rpc");
    assert.equal(resolveRpcUrl("https://node.example.com/v1/query", FALLBACK), "https://node.example.com/v1/query");
  });

  it("rejects userinfo credentials", () => {
    assert.throws(
      () => resolveRpcUrl("https://user:hunter2@node.example.com", FALLBACK),
      PoolixConfigError,
    );
  });

  it("rejects an API key in the query string", () => {
    assert.throws(() => resolveRpcUrl("https://node.example.com/?apiKey=abcdef", FALLBACK), PoolixConfigError);
  });

  it("rejects an API key as a path segment", () => {
    // This is how most commercial RPC providers issue keys.
    assert.throws(
      () => resolveRpcUrl("https://eth-mainnet.example.com/v2/0123456789abcdefghij", FALLBACK),
      PoolixConfigError,
    );
  });

  it("never puts the credential in the error message", () => {
    try {
      resolveRpcUrl("https://user:SUPERSECRETVALUE@node.example.com", FALLBACK);
      assert.fail("should have thrown");
    } catch (error) {
      const message = (error as Error).message;
      assert.ok(!message.includes("SUPERSECRETVALUE"));
      assert.ok(message.includes("userinfo"));
    }
  });

  it("still rejects plain http on a remote host", () => {
    assert.throws(() => resolveRpcUrl("http://node.example.com", FALLBACK), PoolixConfigError);
    assert.equal(resolveRpcUrl("http://localhost:8545", FALLBACK), "http://localhost:8545");
  });

  it("rejects a value that is not a URL at all", () => {
    assert.throws(() => resolveRpcUrl("not a url", FALLBACK), PoolixConfigError);
  });
});

describe("resolvePoolixConfig", () => {
  it("defaults to Robinhood Chain mainnet", () => {
    const config = resolvePoolixConfig(emptyEnv);
    assert.equal(config.network, "mainnet");
    assert.equal(config.chain.id, 4663);
    assert.equal(config.explorerUrl, "https://robinhoodchain.blockscout.com");
    assert.equal(config.contracts.weth, "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73");
  });

  it("selects testnet with its verified constants", () => {
    const config = resolvePoolixConfig({ ...emptyEnv, network: "testnet" });
    assert.equal(config.chain.id, 46630);
    assert.equal(config.explorerUrl, "https://explorer.testnet.chain.robinhood.com");
    assert.equal(config.contracts.weth, "0x7943e237c7F95DA44E0301572D358911207852Fa");
  });

  it("keeps Robinhood's own endpoint alongside the default RPC", () => {
    const config = resolvePoolixConfig(emptyEnv);
    assert.equal(config.rpcUrl, "https://robinhood-rpc.publicnode.com");
    assert.deepEqual(config.chain.rpcUrls.robinhood.http, ["https://rpc.mainnet.chain.robinhood.com"]);
  });

  it("rejects an unknown network instead of falling back silently", () => {
    assert.throws(() => resolvePoolixConfig({ ...emptyEnv, network: "mainet" }), PoolixConfigError);
  });

  it("uses the verified Uniswap v2 deployment on mainnet", () => {
    const config = resolvePoolixConfig(emptyEnv);
    assert.deepEqual(config.contracts.uniswapV2.factory, {
      status: "configured",
      address: "0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f",
      source: "verified",
    });
    assert.deepEqual(config.contracts.uniswapV2.router, {
      status: "configured",
      address: "0x89e5DB8B5aA49aA85AC63f691524311AEB649eba",
      source: "verified",
    });
    assert.equal(isUniswapV2Available(config), true);
  });

  it("reports Uniswap as not configured on testnet, where it is not deployed", () => {
    const config = resolvePoolixConfig({ ...emptyEnv, network: "testnet" });
    assert.deepEqual(config.contracts.uniswapV2.factory, { status: "not-configured" });
    assert.deepEqual(config.contracts.uniswapV2.router, { status: "not-configured" });
    assert.equal(isUniswapV2Available(config), false);
  });

  it("lets an env override replace a verified address", () => {
    const override = "0x1111111111111111111111111111111111111111";
    const config = resolvePoolixConfig({ ...emptyEnv, uniswapV2Router: override });
    assert.deepEqual(config.contracts.uniswapV2.router, {
      status: "configured",
      address: override,
      source: "env",
    });
    // The factory keeps its verified value.
    assert.equal(config.contracts.uniswapV2.factory.status, "configured");
  });

  it("treats a blank env override as absent rather than as a clear", () => {
    const config = resolvePoolixConfig({ ...emptyEnv, uniswapV2Router: "   " });
    assert.deepEqual(config.contracts.uniswapV2.router, {
      status: "configured",
      address: "0x89e5DB8B5aA49aA85AC63f691524311AEB649eba",
      source: "verified",
    });
  });

  it("accepts an https RPC override and localhost over http", () => {
    assert.equal(
      resolvePoolixConfig({ ...emptyEnv, rpcUrl: "https://rpc.example.org" }).rpcUrl,
      "https://rpc.example.org",
    );
    assert.equal(
      resolvePoolixConfig({ ...emptyEnv, rpcUrl: "http://127.0.0.1:8545" }).rpcUrl,
      "http://127.0.0.1:8545",
    );
  });

  it("rejects insecure or malformed RPC overrides without echoing the value", () => {
    for (const rpcUrl of ["http://rpc.example.org", "not a url"]) {
      assert.throws(
        () => resolvePoolixConfig({ ...emptyEnv, rpcUrl }),
        (error: unknown) => error instanceof PoolixConfigError && !error.message.includes(rpcUrl),
      );
    }
  });
});

describe("resolveContract", () => {
  it("accepts a well-formed address", () => {
    assert.deepEqual(resolveContract("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73"), {
      status: "configured",
      address: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
      source: "env",
    });
  });

  it("flags malformed and zero addresses as invalid", () => {
    assert.equal(resolveContract("0x1234").status, "invalid");
    assert.equal(resolveContract("0x0000000000000000000000000000000000000000").status, "invalid");
  });

  it("falls back to the verified address only when no override is present", () => {
    const verified = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
    assert.deepEqual(resolveContract(undefined, verified), {
      status: "configured",
      address: verified,
      source: "verified",
    });
    // An invalid override must not silently fall back to the verified address.
    assert.equal(resolveContract("0xdead", verified).status, "invalid");
  });
});
