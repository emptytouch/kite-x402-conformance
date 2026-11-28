#!/usr/bin/env node
import { readFile } from "node:fs/promises";

import { Command } from "commander";
import pc from "picocolors";

import { checkAuthorization } from "./checks/c3-authorization.js";
import { parseManifest } from "./manifest.js";
import { runManifestProbes } from "./probes/manifest.js";
import { checkChallenge } from "./checks/c2-challenge.js";
import type { CheckResult } from "./checks/types.js";
import { ConfigError, loadConfig, type Config } from "./config.js";
import { KITE_NETWORKS, networkByName, type KiteNetworkName } from "./networks.js";
import { runReplayProbes } from "./probes/replay.js";
import { runSandboxSettlementProbes } from "./probes/settlement-order.js";
import { C5_DEFECTS, isC5Defect, type C5Defect } from "./sandbox/replay-seller.js";
import { SANDBOX_DEFECTS, isSandboxDefect, type SandboxDefect } from "./sandbox/seller.js";
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

/**
 * All-skip results carry no verified assertions. Never let them exit 0 —
 * that would tell CI "conformant" when nothing was actually checked.
 */
function exitCodeForManifest(summary: Summary, source: string): number {
  if (source === "unknown")
    return EXIT.runtimeError; // independence could not be established
  if (summary.pass === 0 && summary.skip > 0) return EXIT.runtimeError;
  return exitCodeFor(summary);
}

function label(result: CheckResult): string {
  if (result.status === "pass") return pc.green("PASS");
  if (result.status === "fail") {
    return result.level === "critical" ? pc.red("FAIL") : pc.yellow("FAIL");
  }
  return pc.dim("SKIP");
}

function printHuman(
  target: string,
  network: KiteNetworkName,
  results: readonly CheckResult[],
  notes: readonly string[] = [],
): void {
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
  for (const note of notes) console.log(pc.dim(note));
  const line = `${summary.pass} passed, ${summary.fail} failed, ${summary.skip} skipped`;
  console.log(summary.criticalFail > 0 ? pc.red(line) : summary.warningFail > 0 ? pc.yellow(line) : pc.green(line));
  if (summary.skip > 0) {
    console.log(pc.dim("skipped checks were not evaluated; they are not evidence of success"));
  }
}

function emit(
  command: "check" | "authorize" | "verify" | "verify-replay" | "verify-manifest",
  target: string,
  network: KiteNetworkName,
  results: readonly CheckResult[],
  json: boolean,
  extra: Record<string, unknown> = {},
  notes: readonly string[] = [],
  exitCodeOverride?: (summary: Summary) => number,
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
    printHuman(target, network, results, notes);
  }
  return exitCodeOverride === undefined ? exitCodeFor(summary) : exitCodeOverride(summary);
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

interface VerifyOptions {
  defect?: string;
  timeout?: string;
  json?: boolean;
}

/**
 * C4 sandbox verification. The sandbox seller is synthetic and the
 * facilitator is a local mock: a pass is evidence about settlement *order*
 * in this sandbox, never about a real chain or real funds.
 */
async function runVerify(options: VerifyOptions): Promise<number> {
  const rawDefect = options.defect ?? "none";
  if (!isSandboxDefect(rawDefect)) {
    console.error(pc.red(`unknown --defect "${rawDefect}"; expected one of: ${SANDBOX_DEFECTS.join(", ")}`));
    return EXIT.runtimeError;
  }
  const defect: SandboxDefect = rawDefect;
  const timeoutMs = parseInteger(options.timeout ?? "5000", 1);
  if (timeoutMs === undefined) {
    console.error(pc.red(`invalid --timeout "${options.timeout ?? ""}"`));
    return EXIT.runtimeError;
  }

  let run: Awaited<ReturnType<typeof runSandboxSettlementProbes>>;
  try {
    run = await runSandboxSettlementProbes({ defect, timeoutMs });
  } catch (error) {
    console.error(pc.red(`sandbox verification failed: ${error instanceof Error ? error.message : String(error)}`));
    console.error(pc.dim("this is a runner/transport failure, not a conformance verdict"));
    return EXIT.runtimeError;
  }

  const notes = [
    "sandbox only: mock upstream + mock facilitator, no real chain, no funds",
    "upstreamCalled / settled come from mock request logs, never from seller headers",
  ];
  return emit(
    "verify",
    `sandbox:${defect}`,
    "testnet",
    run.results,
    options.json === true,
    {
      sandbox: {
        defect,
        endpoints: run.endpoints,
        observations: run.observations,
        captures: run.captures,
      },
    },
    notes,
  );
}

interface ReplayVerifyOptions {
  defect?: string;
  timeout?: string;
  json?: boolean;
}

/**
 * C5 sandbox verification: three replay scenarios against a stateful
 * synthetic seller. The cache, facilitator and upstream are local mocks, so a
 * pass is evidence about replay handling in this sandbox, never about real
 * chain state or funds.
 */
async function runReplayVerify(options: ReplayVerifyOptions): Promise<number> {
  const rawDefect = options.defect ?? "none";
  if (!isC5Defect(rawDefect)) {
    console.error(pc.red(`unknown --defect "${rawDefect}"; expected one of: ${C5_DEFECTS.join(", ")}`));
    return EXIT.runtimeError;
  }
  const defect: C5Defect = rawDefect;
  const timeoutMs = parseInteger(options.timeout ?? "5000", 1);
  if (timeoutMs === undefined) {
    console.error(pc.red(`invalid --timeout "${options.timeout ?? ""}"`));
    return EXIT.runtimeError;
  }

  let run: Awaited<ReturnType<typeof runReplayProbes>>;
  try {
    run = await runReplayProbes({ defect, timeoutMs });
  } catch (error) {
    console.error(pc.red(`replay verification failed: ${error instanceof Error ? error.message : String(error)}`));
    console.error(pc.dim("this is a runner/transport failure, not a conformance verdict"));
    return EXIT.runtimeError;
  }

  const notes = [
    "sandbox only: stateful seller + independent mock cache/facilitator/upstream, no real funds",
    "settled / upstreamCalled / cacheHit come from mock logs, never from seller headers",
    "a cache hit that also settled is reported under sandbox.contradictions",
  ];
  return emit(
    "verify-replay",
    `sandbox:${defect}`,
    "testnet",
    run.results,
    options.json === true,
    {
      sandbox: {
        defect,
        endpoints: run.endpoints,
        observations: run.observations,
        captures: run.captures,
        contradictions: run.contradictions,
      },
    },
    notes,
  );
}

interface ManifestVerifyOptions {
  manifest?: string;
  manifestUrl?: string;
  baseUrl?: string;
  timeout?: string;
  source?: string;
  json?: boolean;
}

/**
 * Whether a hostname is a loopback address after normalisation.
 *
 * A service must not label its own echoed manifest as an independent
 * `well-known` source just by writing the loopback address differently. The
 * old string set missed `localhost.` (trailing dot), any `127/8` address and
 * `0.0.0.0`, all of which route to the same machine as `127.0.0.1`.
 */
function isLoopbackHost(rawHostname: string): boolean {
  const host = rawHostname.toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || host === "0.0.0.0" || host === "::" || host === "[::]") return true;
  // IPv6 loopback, with or without URL brackets.
  if (host === "::1" || host === "[::1]") return true;
  // IPv4-mapped IPv6 loopback. WHATWG URL rewrites [::ffff:127.0.0.1] to
  // [::ffff:7f00:1], so accept both the dotted and hexadecimal forms.
  const v4MappedDotted = /^\[?::ffff:(\d+\.\d+\.\d+\.\d+)\]?$/.exec(host);
  if (v4MappedDotted !== null) return isLoopbackHost(v4MappedDotted[1]!);
  const v4MappedHex = /^\[?::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})\]?$/.exec(host);
  if (v4MappedHex !== null) {
    // The last two 16-bit groups are the IPv4 address in hex (7f00:1 = 127.0.0.1).
    const high = Number.parseInt(v4MappedHex[1]!, 16);
    const low = Number.parseInt(v4MappedHex[2]!, 16);
    const dotted = `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
    return isLoopbackHost(dotted);
  }
  // The whole 127/8 block is loopback, not just 127.0.0.1.
  const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (octets !== null) {
    const [a, b] = [Number(octets[1]), Number(octets[2])];
    return a === 127 || (a === 0 && b === 0 && Number(octets[3]) === 0 && Number(octets[4]) === 0);
  }
  return false;
}

export function sameOrigin(a: string, b: string): boolean {
  try {
    const left = new URL(a);
    const right = new URL(b);
    if (left.origin === right.origin) return true;
    // Different spellings of the same loopback machine are not independent
    // sources, even though their origins differ as strings.
    return (
      left.protocol === right.protocol &&
      isLoopbackHost(left.hostname) &&
      isLoopbackHost(right.hostname)
    );
  } catch {
    return false;
  }
}

/**
 * C1 verification: parse a manifest from an independent source, probe each
 * declared endpoint over real HTTP and compare the two. No payment, no chain
 * state, no settlement — this is a black-box consistency check, not live
 * settlement evidence.
 */
async function runVerifyManifest(
  options: ManifestVerifyOptions,
): Promise<number> {
  if ((options.manifest === undefined) === (options.manifestUrl === undefined)) {
    console.error(pc.red("pass exactly one of --manifest <path> or --manifest-url <url>"));
    return EXIT.runtimeError;
  }
  if (options.baseUrl === undefined || options.baseUrl.length === 0) {
    console.error(pc.red("--base-url <url> is required"));
    return EXIT.runtimeError;
  }

  const timeoutMs = parseInteger(options.timeout ?? "10000", 1);
  if (timeoutMs === undefined) {
    console.error(pc.red(`invalid --timeout "${options.timeout ?? ""}"`));
    return EXIT.runtimeError;
  }

  let text: string;
  let source: "static-file" | "well-known" | "unknown";
  if (options.manifest !== undefined) {
    try {
      text = await readFile(options.manifest, "utf8");
    } catch (error) {
      console.error(pc.red(`cannot read manifest: ${error instanceof Error ? error.message : String(error)}`));
      return EXIT.runtimeError;
    }
    source = "static-file";
    const explicit = options.source;
    if (explicit !== undefined && explicit !== "static-file") {
      console.error(pc.red(`--source ${explicit} contradicts a local --manifest file`));
      return EXIT.runtimeError;
    }
  } else {
    const url = options.manifestUrl as string;
    // A manifest fetched from the same origin as the endpoints under test is
    // not independent evidence: the service could simply echo its challenge.
    // The well-known label also requires the canonical path, not just any URL.
    let isWellKnownPath = false;
    try {
      isWellKnownPath = new URL(url).pathname === "/.well-known/x402";
    } catch {
      // handled below by fetch failing on an invalid URL
    }
    source =
      sameOrigin(url, options.baseUrl) || !isWellKnownPath ? "unknown" : "well-known";
    const explicit = options.source;
    if (explicit !== undefined && explicit !== source) {
      console.error(pc.red(`--source ${explicit} contradicts manifest origin resolution (${source})`));
      return EXIT.runtimeError;
    }
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: { accept: "application/json, text/yaml, text/plain" },
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        console.error(pc.red(`manifest fetch returned HTTP ${response.status}`));
        return EXIT.runtimeError;
      }
      text = await response.text();
    } catch (error) {
      console.error(pc.red(`cannot fetch manifest: ${error instanceof Error ? error.message : String(error)}`));
      return EXIT.runtimeError;
    }
  }

  const parsed = parseManifest(text);
  if (!parsed.ok) {
    console.error(pc.red(`manifest parse failed: ${parsed.error}`));
    console.error(pc.dim("this is a parse error, not a conformance verdict; no checks ran"));
    return EXIT.runtimeError;
  }

  let run: Awaited<ReturnType<typeof runManifestProbes>>;
  try {
    run = await runManifestProbes({
      entries: parsed.entries,
      baseUrl: options.baseUrl,
      source,
      timeoutMs,
    });
  } catch (error) {
    console.error(pc.red(`manifest probe failed: ${error instanceof Error ? error.message : String(error)}`));
    console.error(pc.dim("this is a runner/transport failure, not a conformance verdict"));
    return EXIT.runtimeError;
  }

  const notes = [
    "real HTTP probes: manifest vs the 402 challenges the service actually returns",
    "no payment, no settlement, no chain state — not live settlement evidence",
  ];
  if (source === "unknown") {
    notes.push("manifest came from the same origin as the target; C1 source check is skipped, not passed");
  }
  return emit(
    "verify-manifest",
    options.baseUrl,
    "testnet",
    run.results,
    options.json === true,
    {
      manifest: {
        source: run.source,
        baseUrl: run.baseUrl,
        entries: parsed.entries,
        probes: run.probes,
      },
    },
    notes,
    (summary) => exitCodeForManifest(summary, source),
  );
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
  .command("verify")
  .description("run C4 settlement-order probes against the built-in sandbox (no real funds)")
  // Commander accepts excess positional arguments by default. Declaring a
  // variadic sink and rejecting it ourselves keeps the documented exit code
  // 3 for usage errors; otherwise `verify free-access` silently becomes
  // `verify` and prints a misleading 12/12 PASS.
  .argument("[unexpected...]", "no positional arguments; use --defect <mode>")
  .option("--defect <mode>", `inject one settlement bug: ${SANDBOX_DEFECTS.join(" | ")}`, "none")
  .option("--timeout <ms>", "per-request timeout in milliseconds", "5000")
  .option("--json", "emit machine-readable JSON with raw mock logs", false)
  .action(async (unexpected: string[], options: VerifyOptions) => {
    if (unexpected.length > 0) {
      console.error(pc.red(`verify takes no positional arguments; got: ${unexpected.join(" ")}`));
      console.error(pc.dim("use --defect <mode> to inject a settlement bug"));
      process.exitCode = EXIT.runtimeError;
      return;
    }
    process.exitCode = await runVerify(options);
  });

program
  .command("verify-replay")
  .description("run C5 replay/idempotency probes against the built-in sandbox (no real funds)")
  // Same Commander trap as `verify`: without a variadic sink, an accidental
  // positional argument is discarded and the honest sandbox runs anyway.
  .argument("[unexpected...]", "no positional arguments; use --defect <mode>")
  .option("--defect <mode>", `inject one replay bug: ${C5_DEFECTS.join(" | ")}`, "none")
  .option("--timeout <ms>", "per-request timeout in milliseconds", "5000")
  .option("--json", "emit machine-readable JSON with raw mock logs", false)
  .action(async (unexpected: string[], options: ReplayVerifyOptions) => {
    if (unexpected.length > 0) {
      console.error(pc.red(`verify-replay takes no positional arguments; got: ${unexpected.join(" ")}`));
      console.error(pc.dim("use --defect <mode> to inject a replay bug"));
      process.exitCode = EXIT.runtimeError;
      return;
    }
    process.exitCode = await runReplayVerify(options);
  });

program
  .command("verify-manifest")
  .description("run C1 manifest consistency against real HTTP 402 probes (no payment, no chain state)")
  // Same Commander trap as the other verify commands: excess positional
  // arguments must be rejected instead of silently ignored.
  .argument("[unexpected...]", "no positional arguments; use --manifest / --manifest-url")
  .option("--manifest <path>", "local manifest file (source: static-file)")
  .option("--manifest-url <url>", "manifest URL, ideally on a different origin (source: well-known)")
  .option("--base-url <url>", "base URL of the service whose endpoints are probed")
  .option("--timeout <ms>", "per-request timeout in milliseconds", "10000")
  .option("--source <source>", "assert the manifest source: static-file | well-known | unknown")
  .option("--json", "emit machine-readable JSON with manifest, probes and results", false)
  .action(async (unexpected: string[], options: ManifestVerifyOptions) => {
    if (unexpected.length > 0) {
      console.error(pc.red(`verify-manifest takes no positional arguments; got: ${unexpected.join(" ")}`));
      console.error(pc.dim("use --manifest <path> or --manifest-url <url>"));
      process.exitCode = EXIT.runtimeError;
      return;
    }
    process.exitCode = await runVerifyManifest(options);
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
