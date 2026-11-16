#!/usr/bin/env node
import { Command } from "commander";
import pc from "picocolors";

import { checkChallenge } from "./checks/c2-challenge.js";
import type { CheckResult } from "./checks/types.js";
import { ConfigError, loadConfig, type Config } from "./config.js";
import { KITE_NETWORKS, networkByName, type KiteNetworkName } from "./networks.js";
import { decodeHeaderValue, encodeHeaderValue } from "./wire.js";

export const VERSION = "0.1.0";

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

function printHuman(url: string, network: KiteNetworkName, results: readonly CheckResult[]): void {
  const summary = summarise(results);
  console.log(`${pc.bold("x402conf")} ${pc.dim(`v${VERSION}`)}`);
  console.log(`target  ${url}`);
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

async function runCheck(
  url: string,
  options: { network?: string; timeout?: string; json?: boolean; expectedPayTo?: string },
  config: Config,
): Promise<number> {
  const network = (options.network ?? config.network) as KiteNetworkName;
  if (!(network in KITE_NETWORKS)) {
    console.error(pc.red(`unknown network "${network}"; expected mainnet or testnet`));
    return EXIT.runtimeError;
  }

  const timeoutMs = Number.parseInt(options.timeout ?? "10000", 10);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    console.error(pc.red(`invalid --timeout "${options.timeout ?? ""}"`));
    return EXIT.runtimeError;
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(pc.red(`request failed: ${message}`));
    console.error(pc.dim("no checks ran; this is a transport failure, not a conformance verdict"));
    return EXIT.runtimeError;
  }

  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });

  const expectedPayTo = options.expectedPayTo ?? config.expectedPayTo;
  const results = checkChallenge({
    status: response.status,
    headers,
    expectedNetwork: network,
    ...(expectedPayTo ? { expectedPayTo } : {}),
  });
  const summary = summarise(results);

  if (options.json === true) {
    console.log(
      JSON.stringify(
        {
          tool: "x402conf",
          version: VERSION,
          url,
          network: networkByName(network).caip2,
          summary,
          results,
        },
        null,
        2,
      ),
    );
  } else {
    printHuman(url, network, results);
  }

  return exitCodeFor(summary);
}

const program = new Command();
program
  .name("x402conf")
  .description("Black-box conformance checks for x402 paid HTTP APIs on the Kite chain")
  .version(VERSION);

program
  .command("check")
  .description("run conformance checks against one endpoint (C2: 402 challenge structure)")
  .argument("<url>", "endpoint URL to check, e.g. http://localhost:8080/v1/echo")
  .option("--network <network>", "expected Kite network: mainnet | testnet")
  .option("--timeout <ms>", "request timeout in milliseconds", "10000")
  .option("--expected-pay-to <address>", "fail if the challenge advertises a different receiver")
  .option("--json", "emit machine-readable JSON instead of a terminal report", false)
  .action(async (url: string, options: { network?: string; timeout?: string; json?: boolean; expectedPayTo?: string }) => {
    let config: Config;
    try {
      config = loadConfig();
    } catch (error) {
      if (error instanceof ConfigError) {
        console.error(pc.red(error.message));
        process.exitCode = EXIT.runtimeError;
        return;
      }
      throw error;
    }
    process.exitCode = await runCheck(url, options, config);
  });

program
  .command("networks")
  .description("list the Kite networks this build knows about")
  .action(() => {
    console.log(`${"name".padEnd(10)}${"chainId".padEnd(10)}${"caip2".padEnd(16)}${"verified".padEnd(10)}rpc`);
    for (const network of Object.values(KITE_NETWORKS)) {
      console.log(
        `${network.name.padEnd(10)}${String(network.chainId).padEnd(10)}${network.caip2.padEnd(16)}${String(network.verified).padEnd(10)}${network.rpcUrl ?? "(not configured)"}`,
      );
    }
  });

program
  .command("decode")
  .description("decode a PAYMENT-REQUIRED / PAYMENT-RESPONSE header value for debugging")
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
