/*
  Independent security check of the built application.

    npm run verify:security

  The unit tests assert that each guard behaves correctly in isolation. This asserts the
  properties that only hold across the whole repository and the whole build output: that no
  credential reached a client bundle, that the dangerous DOM and evaluation primitives are
  absent, that every network endpoint is a constant rather than something a user can steer,
  and that the write path still refuses an unlimited approval.

  It reads source and build output. It never prints a secret — only whether one was found.

  Run `npm run build` first: the bundle checks are skipped, loudly, without it.
*/

import { readdir, readFile, stat } from "node:fs/promises";
import { join, extname } from "node:path";

import { contentSecurityPolicy } from "@/config/security-headers";

const ROOT = process.cwd();
const CLIENT_BUNDLE_DIR = join(ROOT, ".next", "static");
const SERVER_DIR = join(ROOT, ".next", "server");

let failures = 0;
let skipped = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = String(actual) === String(expected);
  if (!ok) failures++;
  console.log(
    `  ${ok ? "PASS" : "FAIL"} ${label.padEnd(58)} ${String(actual)}${ok ? "" : `  != ${String(expected)}`}`,
  );
}

function note(label: string, value: unknown): void {
  console.log(`  ·    ${label.padEnd(58)} ${String(value)}`);
}

function skip(label: string, why: string): void {
  skipped++;
  console.log(`  SKIP ${label.padEnd(58)} ${why}`);
}

// ------------------------------------------------------------------ file walking

const SOURCE_DIRECTORIES = ["app", "components", "config", "hooks", "lib", "services", "types"];
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx"]);

async function walk(directory: string, extensions?: ReadonlySet<string>): Promise<string[]> {
  const found: string[] = [];
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = join(directory, entry);
    const info = await stat(full).catch(() => null);
    if (info === null) continue;
    if (info.isDirectory()) {
      found.push(...(await walk(full, extensions)));
    } else if (extensions === undefined || extensions.has(extname(entry))) {
      found.push(full);
    }
  }
  return found;
}

async function sourceFiles(): Promise<{ path: string; text: string; code: string }[]> {
  const paths = (
    await Promise.all(SOURCE_DIRECTORIES.map((dir) => walk(join(ROOT, dir), SOURCE_EXTENSIONS)))
  ).flat();
  return Promise.all(
    paths.map(async (path) => {
      const raw = await readFile(path, "utf8");
      return { path: path.slice(ROOT.length + 1), text: raw, code: stripComments(raw) };
    }),
  );
}

/** Test files legitimately contain the shapes production code must not. */
const isTest = (path: string) => path.endsWith(".test.ts") || path.endsWith(".test.tsx");

/**
 * Source with comments removed.
 *
 * Every pattern below has to match CODE, not prose. Without this the scanner flags a
 * comment that says "Poolix contains no dangerouslySetInnerHTML" as a use of
 * dangerouslySetInnerHTML — which is how a security gate ends up reporting its own
 * documentation as a finding, and how a real one later gets dismissed as noise.
 *
 * Strings are preserved, because a URL or a pattern inside one is still code.
 */
function stripComments(source: string): string {
  let out = "";
  let inBlock = false;
  let quote: string | null = null;

  for (let i = 0; i < source.length; i++) {
    const char = source[i] ?? "";
    const next = source[i + 1] ?? "";

    if (inBlock) {
      if (char === "*" && next === "/") {
        inBlock = false;
        i++;
      }
      // Keep newlines so line-oriented patterns still behave.
      else if (char === "\n") out += "\n";
      continue;
    }

    if (quote !== null) {
      out += char;
      if (char === "\\") {
        out += next;
        i++;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      out += char;
      continue;
    }
    if (char === "/" && next === "*") {
      inBlock = true;
      i++;
      continue;
    }
    if (char === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    out += char;
  }
  return out;
}

// --------------------------------------------------------------------------- main

async function main(): Promise<void> {
  console.log("Poolix security verification");
  console.log("NOTE               : checks the CODE and the BUILD. Never prints a secret.");

  const sources = await sourceFiles();
  const production = sources.filter((file) => !isTest(file.path));
  note("source files scanned", `${String(sources.length)} (${String(production.length)} non-test)`);

  // =============================================== A. secrets never reach the client
  console.log("\n-- A. secrets --");

  /*
    The decisive check: the configured token's literal value, searched for in every file
    the browser is served. A token in a server module is correct; the same token in
    .next/static is a disclosure to every visitor.
  */
  const token = process.env.ENVIO_API_TOKEN?.trim() ?? "";
  const clientFiles = await walk(CLIENT_BUNDLE_DIR);
  if (clientFiles.length === 0) {
    skip("API token absent from client bundles", "no build output; run npm run build");
  } else if (token.length < 8) {
    skip("API token absent from client bundles", "no token configured in this environment");
  } else {
    let hits = 0;
    for (const file of clientFiles) {
      const text = await readFile(file, "utf8").catch(() => "");
      if (text.includes(token)) hits++;
    }
    note("client bundle files scanned", clientFiles.length);
    check("the API token appears in no client bundle", hits, 0);
  }

  // A NEXT_PUBLIC_ variable is inlined into the browser bundle by definition, so one whose
  // name suggests a credential is a disclosure waiting to happen regardless of its value.
  const publicSecretNames = Object.keys(process.env).filter(
    (name) => name.startsWith("NEXT_PUBLIC_") && /TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE|APIKEY|API_KEY/i.test(name),
  );
  check("no NEXT_PUBLIC_ variable is named like a secret", publicSecretNames.length, 0);
  for (const name of publicSecretNames) note("offending variable", name);

  // The abandoned provider must not come back, and the token must never be read from a
  // public variable.
  const forbidden: readonly { readonly label: string; readonly pattern: RegExp }[] = [
    { label: "NEXT_PUBLIC_ENVIO_API_TOKEN", pattern: /NEXT_PUBLIC_ENVIO_API_TOKEN/ },
    { label: "an Alchemy dependency", pattern: /alchemy/i },
    { label: "a hardcoded private key", pattern: /(?:private_?key|PRIVATE_KEY)\s*[:=]\s*["'`]0x[0-9a-fA-F]{64}/ },
    { label: "a mnemonic literal", pattern: /mnemonic\s*[:=]\s*["'`](?:\w+\s+){11}\w+["'`]/i },
  ];
  for (const { label, pattern } of forbidden) {
    const hits = production.filter((file) => pattern.test(file.code));
    check(`no source file references ${label}`, hits.length, 0);
    for (const hit of hits.slice(0, 3)) note("in", hit.path);
  }

  /*
    A 32-byte hex literal bound to a secret-sounding name.

    Flagging every 64-hex literal would be useless here: a Uniswap v2 codebase is full of
    them legitimately — event topic hashes and the CREATE2 init code hash are exactly that
    shape, and they are public protocol constants. What distinguishes a key is the name it
    is given, so that is what is matched.
  */
  const SECRET_NAMED_KEY =
    /\b(?:private_?key|secret|seed|mnemonic|signing_?key|api_?key)\w*\s*[:=]\s*["'`](?:0x)?[0-9a-fA-F]{64}["'`]/i;
  const keyShaped = production.filter((file) => SECRET_NAMED_KEY.test(file.code));
  check("no 32-byte hex literal is bound to a secret name", keyShaped.length, 0);
  for (const hit of keyShaped.slice(0, 5)) note("in", hit.path);

  // ================================================================ K. XSS surface
  console.log("\n-- K. injection surface --");
  const injection: readonly { readonly label: string; readonly pattern: RegExp }[] = [
    { label: "dangerouslySetInnerHTML", pattern: /dangerouslySetInnerHTML/ },
    { label: "innerHTML assignment", pattern: /\.innerHTML\s*=/ },
    { label: "outerHTML assignment", pattern: /\.outerHTML\s*=/ },
    { label: "document.write", pattern: /document\.write\s*\(/ },
    { label: "eval", pattern: /(?<![.\w])eval\s*\(/ },
    { label: "new Function", pattern: /new\s+Function\s*\(/ },
    { label: "javascript: URL", pattern: /["'`]javascript:/i },
    { label: "an iframe", pattern: /<iframe/i },
  ];
  for (const { label, pattern } of injection) {
    const hits = production.filter((file) => pattern.test(file.code));
    check(`no production source uses ${label}`, hits.length, 0);
    for (const hit of hits.slice(0, 3)) note("in", hit.path);
  }

  // Contract-supplied text must be sanitised before it is displayed.
  const metadata = production.find((file) => file.path.endsWith(join("tokens", "metadata.ts")));
  check("token metadata is sanitised at its source", metadata?.code.includes("sanitizeSymbol"), true);
  check("token decimals are bounded at their source", metadata?.code.includes("isUsableDecimals"), true);

  // ================================================== H/I. network endpoint bounds
  console.log("\n-- H/I. RPC and HyperSync bounds --");

  const rpc = production.find((file) => file.path.endsWith(join("chain", "rpc.ts")));
  const hypersync = production.find((file) => file.path.endsWith(join("analytics", "hypersync.ts")));
  check("the RPC module is server-only", rpc?.code.startsWith('import "server-only"'), true);
  check("the HyperSync module is server-only", hypersync?.code.startsWith('import "server-only"'), true);

  // A hardcoded endpoint cannot be steered by a user; an interpolated one might be.
  check("the HyperSync URL is a constant", /HYPERSYNC_URL = "https:\/\//.test(hypersync?.code ?? ""), true);
  check("no template literal builds a HyperSync URL", /fetch\(`/.test(hypersync?.code ?? ""), false);
  check("no template literal builds an RPC URL", /fetch\(`/.test(rpc?.code ?? ""), false);

  // Every outbound request must be bounded, or a stalled socket holds a tick open for ever.
  check("RPC requests carry a timeout", (rpc?.code.match(/AbortSignal\.timeout/g) ?? []).length >= 2, true);
  check("HyperSync requests carry a timeout", (hypersync?.code.match(/AbortSignal\.timeout/g) ?? []).length >= 2, true);
  check("RPC retries are bounded", /MAX_ATTEMPTS\s*=\s*\d+/.test(rpc?.code ?? ""), true);
  check("HyperSync backoff is a fixed list", /BACKOFF_MS\s*=\s*\[/.test(hypersync?.code ?? ""), true);

  /*
    The server RPC helper must only ever issue reads.

    `method:` appears both as a JSON-RPC field and as the HTTP verb in fetch options, so
    the HTTP verbs are excluded by name rather than by guessing from context — naming them
    means a new verb shows up as a finding instead of being silently tolerated.
  */
  const HTTP_VERBS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
  const methods = [...(rpc?.code.matchAll(/method:\s*"([a-zA-Z_]+)"/g) ?? [])]
    .map((match) => match[1])
    .filter((method): method is string => method !== undefined && !HTTP_VERBS.has(method));
  const allowedMethods = new Set(["eth_call", "eth_blockNumber"]);
  const unexpected = methods.filter((method) => !allowedMethods.has(method));
  note("JSON-RPC methods issued", methods.join(", ") || "none");
  check("only read-only RPC methods are issued", unexpected.length, 0);
  for (const method of unexpected) note("unexpected method", method);

  // No proxy or forwarding primitive: there is no SSRF surface to reason about.
  const routeHandlers = await walk(join(ROOT, "app"), new Set([".ts"]));
  const apiRoutes = routeHandlers.filter((path) => path.endsWith(`${"route"}.ts`));
  note("API route handlers", apiRoutes.length === 0 ? "none (no CORS/method surface)" : apiRoutes.length);
  check("no API route handler exists to be abused", apiRoutes.length, 0);

  // ================================================ D. the write path still refuses
  console.log("\n-- D. transaction safety --");

  const flow = production.find((file) => file.path.endsWith(join("hooks", "use-transaction-flow.ts")));
  check("the flow checks the deadline", flow?.code.includes("checkDeadline"), true);
  check("the flow checks the destination", flow?.code.includes("checkTransactionIntent"), true);
  check("the flow checks every approval", flow?.code.includes("checkApproval"), true);
  check("the flow pins the chain on every send", (flow?.code.match(/chainId: poolixChain\.id/g) ?? []).length >= 2, true);
  check("simulation precedes the wallet prompt", (flow?.code.indexOf("publicClient.call") ?? -1) < (flow?.code.indexOf("REQUEST_CONFIRMATION") ?? 0), true);

  // An unlimited allowance is the single most common way funds are lost long after a
  // transaction the user has forgotten.
  const unlimited = production.filter(
    (file) => /maxUint256/.test(file.code) && !file.path.includes(join("transactions", "guards")),
  );
  check("no source requests an unlimited allowance", unlimited.length, 0);
  for (const hit of unlimited.slice(0, 3)) note("in", hit.path);

  // Calldata is built from typed ABIs, never assembled from strings.
  const handRolled = production.filter((file) => /data:\s*`0x\$\{/.test(file.code));
  check("no calldata is built by string concatenation", handRolled.length, 0);

  // =============================================================== L. HTTP headers
  console.log("\n-- L. HTTP headers --");

  const config = await readFile(join(ROOT, "next.config.ts"), "utf8").catch(() => "");
  check("next.config declares headers", /async headers\(/.test(config), true);
  check("the powered-by header is disabled", /poweredByHeader:\s*false/.test(config), true);
  check("remote images are not allowlisted", /remotePatterns:\s*\[\]/.test(config), true);

  const headersRaw = await readFile(join(ROOT, "config", "security-headers.ts"), "utf8").catch(() => "");
  // Directive names are asserted against the raw file, since they appear in strings and
  // prose alike. The behavioural checks further down call the policy builder instead.
  const headersModule = headersRaw;
  for (const directive of [
    "Content-Security-Policy",
    "X-Content-Type-Options",
    "Referrer-Policy",
    "Permissions-Policy",
    "Strict-Transport-Security",
    "frame-ancestors",
  ]) {
    check(`${directive} is configured`, headersModule.includes(directive), true);
  }
  /*
    Asserted against the GENERATED policy, not against the source text.

    Grepping for the string was wrong once the development build legitimately needed
    'unsafe-eval' — the source now contains it, and a text search reported that as a
    finding. What has to be true is narrower and more useful: the policy actually served in
    production does not grant it. So the function is called and its output inspected.
  */
  const productionCsp = contentSecurityPolicy({ connectOrigins: [], production: true });
  const developmentCsp = contentSecurityPolicy({ connectOrigins: [], production: false });
  check("the production CSP never grants unsafe-eval", productionCsp.includes("unsafe-eval"), false);
  check("the production CSP forbids framing", productionCsp.includes("frame-ancestors 'none'"), true);
  check("the production CSP pins base-uri", productionCsp.includes("base-uri 'self'"), true);
  check("the production CSP upgrades insecure requests", productionCsp.includes("upgrade-insecure-requests"), true);
  // localhost and ws:// are development affordances and must not reach a deployed origin.
  check("the production CSP allows no localhost origin", productionCsp.includes("localhost"), false);
  check("the production CSP allows no websocket origin", productionCsp.includes("ws://"), false);
  // Development needs eval for React's dev build; that grant must stay on that side.
  check("the development CSP does grant unsafe-eval", developmentCsp.includes("'unsafe-eval'"), true);
  note("production script-src", productionCsp.split(";").find((part) => part.trim().startsWith("script-src"))?.trim());

  // ================================================================ M. error hygiene
  console.log("\n-- M. error and log hygiene --");

  const errorBoundary = await readFile(join(ROOT, "app", "error.tsx"), "utf8").catch(() => "");
  check("the error boundary maps through the classifier", errorBoundary.includes("classifyError"), true);
  check("the error boundary prints no stack", /error\.stack/.test(errorBoundary), false);
  check("the error boundary prints no raw message", /\{error\.message\}/.test(errorBoundary), false);

  const logModule = await readFile(join(ROOT, "services", "storage", "log.ts"), "utf8").catch(() => "");
  check("every logged value is redacted", logModule.includes("redact(String(rendered))"), true);

  const keysModule = stripComments(
    await readFile(join(ROOT, "services", "storage", "keys.ts"), "utf8").catch(() => ""),
  );
  // The replace-loop form of this does not terminate when a value is a substring of its
  // own label. See services/storage/storage.test.ts.
  check("redaction does not use a replace loop", /while\s*\(\s*output\.includes/.test(keysModule), false);

  // =========================================================== J. filesystem safety
  console.log("\n-- J. filesystem --");

  const storage = production.find((file) => file.path.endsWith(join("storage", "storage.ts")));
  check("storage keys are asserted before use", storage?.text.includes("assertKey(key)"), true);
  check("storage paths are proven inside the cache root", storage?.text.includes("Refusing a storage path outside"), true);
  check("writes are atomic (temp then rename)", storage?.text.includes("rename(temporary, target)"), true);

  // Only the storage module may touch the filesystem at runtime.
  const runtimeFsUsers = production.filter(
    (file) =>
      /from "node:fs/.test(file.code) &&
      !file.path.startsWith("scripts") &&
      !file.path.endsWith(join("storage", "storage.ts")),
  );
  check("only the storage module performs filesystem I/O", runtimeFsUsers.length, 0);
  for (const hit of runtimeFsUsers.slice(0, 5)) note("in", hit.path);

  // A filesystem path in server-rendered output would disclose the deployment layout.
  const serverFiles = await walk(SERVER_DIR, new Set([".html"]));
  if (serverFiles.length === 0) {
    skip("no filesystem path in rendered HTML", "no build output; run npm run build");
  } else {
    let leaks = 0;
    for (const file of serverFiles) {
      const text = await readFile(file, "utf8").catch(() => "");
      if (text.includes(ROOT) || /[A-Z]:\\\\Users\\\\/.test(text)) leaks++;
    }
    note("rendered pages scanned", serverFiles.length);
    check("no rendered page contains a filesystem path", leaks, 0);
  }

  // ------------------------------------------------------------------- verdict
  const verdict = failures === 0 ? "PASS" : "FAIL";
  console.log(`\n=== verify:security : ${verdict} ===`);
  if (skipped > 0) {
    console.log(`  ${String(skipped)} check(s) skipped — run npm run build for full coverage.`);
  }
  console.log(failures === 0 ? "  All checks passed." : `  ${String(failures)} CHECK(S) FAILED`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

