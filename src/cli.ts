#!/usr/bin/env node
import { readFile } from "node:fs/promises";

import { Command } from "commander";
import pc from "picocolors";

import { checkAuthorization } from "./checks/c3-authorization.js";
import { checkChallenge } from "./checks/c2-challenge.js";
import type { CheckResult } from "./checks/types.js";
import { ConfigError, loadConfig, type Config } from "./config.js";
import { KITE_NETWORKS, networkByName, type KiteNetworkName } from "./networks.js";
import { decodeHeaderValue, encodeHeaderValue } from "./wire.js";

export const VERSION = "0.2.0";

const EXIT = {
  ok: 0,
  criticalFail: 1,
  warningFail: 2,
  runtimeError: 3,
} as const;

interface Summary {
  readonly pass: number;
  readonly fail: number;
  readonly skip: number;
  readonly criticalFail: number;
  readonly warningFail: number;
}

function summarise(results: readonly CheckResult[]): Summary {
  const failed = results.filter((result) => result.status === "fail");
  return {
    pass: results.filter((result) => result.status === "pass").length,
    fail: failed.length,
    skip: results.filter((result) => result.status === "skip").length,
    criticalFail: failed.filter((result) => result.level === "critical").length,
    warningFail: failed.filter((result) => result.level === "warning").length,
  };
}

function exitCodeFor(summary: Summary): number {
  if (summary.criticalFail > 0) return EXIT.criticalFail;
  if (summary.warningFail > 0) return EXIT.warningFail;
  return EXIT.ok;
}

function label(result: CheckResult): string {
  if (result.status === "pass") return pc.green("PASS");
  if (result.status === "fail") {
    return result.level === "critical" ? pc.red("FAIL") : pc.yellow("FAIL");
  }
  return pc.dim("SKIP");
}

function printHuman(target: string, network: KiteNetworkName, results: readonly CheckResult[]): void {
  const summary = summarise(results);
  console.log(`${pc.bold("x402conf")} ${pc.dim(`v${VERSION}`)}`);
  console.log(`target  ${target}`);
  console.log(`network ${networkByName(network).caip2}${networkByName(network).verified ? "" : pc.yellow(" (unverified endpoints)")}`);
  console.log("");

  for (const result of results) {
    console.log(`${label(result)}  ${pc.dim(result.id)}  ${result.title}`);
    console.log(`      ${pc.dim(result.detail)}`);
  }

  console.log("");
  const line = `${summary.pass} passed, ${summary.fail} failed, ${summary.skip} skipped`;
  console.log(summary.criticalFail > 0 ? pc.red(line) : summary.warningFail > 0 ? pc.yellow(line) : pc.green(line));
  if (summary.skip > 0) {
    console.log(pc.dim("skipped checks were not evaluated; they are not evidence of success"));
  }
}

function emit(
  command: "check" | "authorize",
  target: string,
  network: KiteNetworkName,
  results: readonly CheckResult[],
  json: boolean,
  extra: Record<string, unknown> = {},
): number {
  const summary = summarise(results);
  if (json) {
    console.log(
      JSON.stringify(
        {
          tool: "x402conf",
          version: VERSION,
          command,
          target,
          network: networkByName(network).caip2,
          ...extra,
          summary,
          results,
        },
        null,
        2,
      ),
    );
  } else {
    printHuman(target, network, results);
  }
  return exitCodeFor(summary);
}

function resolveNetwork(raw: string | undefined, config: Config): KiteNetworkName | undefined {
  const network = (raw ?? config.network) as KiteNetworkName;
  return Object.hasOwn(KITE_NETWORKS, network) ? network : undefined;
}

/** Read `--payment-signature @path` as well as an inline value. */
async function resolveInlineOrFile(raw: string): Promise<string> {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("@")) return trimmed;
  return (await readFile(trimmed.slice(1), "utf8")).trim();
}

interface FetchedResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
}

async function fetchResponse(url: string, timeoutMs: number): Promise<FetchedResponse> {
  const response = await fetch(url, {
    method: "GET",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return { status: response.status, headers };
}

function parseInteger(raw: string, minimum: number): number | undefined {
  if (!/^\d+$/.test(raw.trim())) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) && parsed >= minimum ? parsed : undefined;
}

async function runCheck(
  url: string,
  options: { network?: string; timeout?: string; json?: boolean; expectedPayTo?: string },
  config: Config,
): Promise<number> {
  const network = resolveNetwork(options.network, config);
  if (network === undefined) {
    console.error(pc.red(`unknown network "${options.network ?? ""}"; expected mainnet or testnet`));
    return EXIT.runtimeError;
  }

  const timeoutMs = parseInteger(options.timeout ?? "10000", 1);
  if (timeoutMs === undefined) {
    console.error(pc.red(`invalid --timeout "${options.timeout ?? ""}"`));
    return EXIT.runtimeError;
  }

  let fetched: FetchedResponse;
  try {
    fetched = await fetchResponse(url, timeoutMs);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(pc.red(`request failed: ${message}`));
    console.error(pc.dim("no checks ran; this is a transport failure, not a conformance verdict"));
    return EXIT.runtimeError;
  }

  const expectedPayTo = options.expectedPayTo ?? config.expectedPayTo;
  const results = checkChallenge({
    status: fetched.status,
    headers: fetched.headers,
    expectedNetwork: network,
    ...(expectedPayTo ? { expectedPayTo } : {}),
  });

  return emit("check", url, network, results, options.json === true);
}

interface AuthorizeOptions {
  network?: string;
  timeout?: string;
  json?: boolean;
  paymentSignature?: string;
  challenge?: string;
  now?: string;
  minValidity?: string;
  maxWindow?: string;
}

async function runAuthorize(url: string | undefined, options: AuthorizeOptions, config: Config): Promise<number> {
  const network = resolveNetwork(options.network, config);
  if (network === undefined) {
    console.error(pc.red(`unknown network "${options.network ?? ""}"; expected mainnet or testnet`));
    return EXIT.runtimeError;
  }

  if (options.paymentSignature === undefined) {
    console.error(pc.red("--payment-signature is required: pass the header value, or @path to a file holding it"));
    console.error(pc.dim("capture it from a client run: examples/mock-payer.ts prints one for the demo seller"));
    return EXIT.runtimeError;
  }
  if (url !== undefined && options.challenge !== undefined) {
    console.error(pc.red("pass either a URL or --challenge <path>, not both"));
    return EXIT.runtimeError;
  }
  if (url === undefined && options.challenge === undefined) {
    console.error(pc.red("nothing to check: pass a URL to fetch the challenge from, or --challenge <path>"));
    return EXIT.runtimeError;
  }

  const timeoutMs = parseInteger(options.timeout ?? "10000", 1);
  if (timeoutMs === undefined) {
    console.error(pc.red(`invalid --timeout "${options.timeout ?? ""}"`));
    return EXIT.runtimeError;
  }

  const now = options.now === undefined ? Math.floor(Date.now() / 1000) : parseInteger(options.now, 1);
  if (now === undefined) {
    console.error(pc.red(`invalid --now "${options.now ?? ""}"; expected unix seconds`));
    return EXIT.runtimeError;
  }

  const minValidity = options.minValidity === undefined ? undefined : parseInteger(options.minValidity, 0);
  if (options.minValidity !== undefined && minValidity === undefined) {
    console.error(pc.red(`invalid --min-validity "${options.minValidity}"; expected a non-negative integer`));
    return EXIT.runtimeError;
  }
  const maxWindow = options.maxWindow === undefined ? undefined : parseInteger(options.maxWindow, 1);
  if (options.maxWindow !== undefined && maxWindow === undefined) {
    console.error(pc.red(`invalid --max-window "${options.maxWindow}"; expected a positive integer`));
    return EXIT.runtimeError;
  }

  let paymentHeader: string;
  try {
    paymentHeader = await resolveInlineOrFile(options.paymentSignature);
  } catch (error) {
    console.error(pc.red(`cannot read payment signature: ${error instanceof Error ? error.message : String(error)}`));
    return EXIT.runtimeError;
  }

  let challengeHeader: string | undefined;
  let target: string;
  if (options.challenge !== undefined) {
    try {
      challengeHeader = (await readFile(options.challenge, "utf8")).trim();
    } catch (error) {
      console.error(pc.red(`cannot read challenge file: ${error instanceof Error ? error.message : String(error)}`));
      return EXIT.runtimeError;
    }
    target = `challenge:${options.challenge}`;
  } else {
    const source = url as string;
    let fetched: FetchedResponse;
    try {
      fetched = await fetchResponse(source, timeoutMs);
    } catch (error) {
      console.error(pc.red(`request failed: ${error instanceof Error ? error.message : String(error)}`));
      console.error(pc.dim("no checks ran; this is a transport failure, not a conformance verdict"));
      return EXIT.runtimeError;
    }
    challengeHeader = fetched.headers["payment-required"];
    target = source;
  }

  const results = await checkAuthorization({
    challengeHeader,
    paymentHeader,
    expectedNetwork: network,
    now,
    ...(minValidity === undefined ? {} : { minValiditySeconds: minValidity }),
    ...(maxWindow === undefined ? {} : { maxWindowSeconds: maxWindow }),
  });

  return emit("authorize", target, network, results, options.json === true, { evaluatedAt: now });
}

const program = new Command();
program
  .name("x402conf")
  .description("Black-box conformance checks for x402 paid HTTP APIs on the Kite chain")
  .version(VERSION);

function loadConfigOrExit(): Config | undefined {
  try {
    return loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(pc.red(error.message));
      process.exitCode = EXIT.runtimeError;
      return undefined;
    }
    throw error;
  }
}

program
  .command("check")
  .description("run conformance checks against one endpoint (C2: 402 challenge structure)")
  .argument("<url>", "endpoint URL to check, e.g. http://localhost:8080/v1/echo")
  .option("--network <network>", "expected Kite network: mainnet | testnet")
  .option("--timeout <ms>", "request timeout in milliseconds", "10000")
  .option("--expected-pay-to <address>", "fail if the challenge advertises a different receiver")
  .option("--json", "emit machine-readable JSON instead of a terminal report", false)
  .action(async (url: string, options: { network?: string; timeout?: string; json?: boolean; expectedPayTo?: string }) => {
    const config = loadConfigOrExit();
    if (config === undefined) return;
    process.exitCode = await runCheck(url, options, config);
  });

program
  .command("authorize")
  .description("verify a PAYMENT-SIGNATURE payload against a challenge (C3: EIP-712 domain and EIP-3009 signature)")
  .argument("[url]", "endpoint to fetch the challenge from; omit when --challenge is given")
  .option("--payment-signature <value>", "PAYMENT-SIGNATURE header value, or @path to a file holding it")
  .option("--challenge <path>", "saved PAYMENT-REQUIRED payload (base64 header value or raw JSON) instead of fetching")
  .option("--network <network>", "expected Kite network: mainnet | testnet")
  .option("--timeout <ms>", "request timeout in milliseconds", "10000")
  .option("--now <unixSeconds>", "evaluate the validity window at this timestamp instead of the current time")
  .option("--min-validity <seconds>", "required remaining validity; defaults to 6, as the reference facilitator does")
  .option("--max-window <seconds>", "advisory cap on the remaining replay window; defaults to maxTimeoutSeconds")
  .option("--json", "emit machine-readable JSON instead of a terminal report", false)
  .action(async (url: string | undefined, options: AuthorizeOptions) => {
    const config = loadConfigOrExit();
    if (config === undefined) return;
    process.exitCode = await runAuthorize(url, options, config);
  });

program
  .command("networks")
  .description("list the Kite networks this build knows about")
  .action(() => {
    const config = loadConfigOrExit();
    if (config === undefined) return;
    console.log(`${"name".padEnd(10)}${"chainId".padEnd(10)}${"caip2".padEnd(16)}${"verified".padEnd(10)}rpc`);
    for (const network of Object.values(KITE_NETWORKS)) {
      const rpc = network.name === config.network && config.rpcUrl !== undefined ? config.rpcUrl : network.rpcUrl;
      console.log(
        `${network.name.padEnd(10)}${String(network.chainId).padEnd(10)}${network.caip2.padEnd(16)}${String(network.verified).padEnd(10)}${rpc ?? "(not configured)"}`,
      );
    }
    if (config.rpcUrl !== undefined) {
      console.log(`\nKITE_RPC_URL overrides rpc for ${config.network}; it is not used for chain calls in ${VERSION}`);
    }
  });

program
  .command("decode")
  .description("decode a PAYMENT-REQUIRED / PAYMENT-SIGNATURE / PAYMENT-RESPONSE header value for debugging")
  .argument("<value>", "raw header value")
  .action((value: string) => {
    const decoded = decodeHeaderValue(value);
    if (!decoded.ok) {
      console.error(pc.red(decoded.error));
      process.exitCode = EXIT.runtimeError;
      return;
    }
    console.log(JSON.stringify(decoded.value, null, 2));
    console.log(pc.dim(`re-encoded: ${encodeHeaderValue(decoded.value)}`));
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(pc.red(error instanceof Error ? error.message : String(error)));
  process.exitCode = EXIT.runtimeError;
});
