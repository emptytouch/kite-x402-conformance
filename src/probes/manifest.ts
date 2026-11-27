/**
 * C1 probe runner: turns real HTTP 402 responses into trusted ObservedEntry[].
 *
 * Trust boundary: every observed field comes from the response the runner
 * itself fetched from `--base-url` + the declared path. The manifest's own
 * "observed" claims and any self-reported fields from the service are never
 * used. A transport failure is a runner error (exit 3), not a conformance
 * verdict — "could not connect" is not "manifest disagrees".
 */

import {
  checkManifestConsistency,
  type ManifestConsistencyInput,
  type ManifestEntry,
  type ManifestSource,
  type ObservedEntry,
} from "../checks/c1-manifest.js";
import { pickPaymentOption, pickRaw, pickString, unsafeIntegerFields } from "../checks/parse.js";
import type { CheckResult } from "../checks/types.js";
import { decodeHeaderValue, findHeader } from "../wire.js";

export interface ManifestProbeOptions {
  readonly entries: readonly ManifestEntry[];
  readonly baseUrl: string;
  readonly source: ManifestSource;
  readonly timeoutMs?: number;
  /** Injected for deterministic tests; production uses the real clock. */
  readonly fetcher?: (url: string, timeoutMs: number) => Promise<{
    readonly status: number;
    readonly headers: Record<string, string>;
  }>;
}

export interface ObservedProbe {
  readonly path: string;
  readonly status: number;
  readonly hasPaymentRequired: boolean;
  readonly entry: ObservedEntry;
}

export interface ManifestProbeResult {
  readonly source: ManifestSource;
  readonly baseUrl: string;
  readonly probes: readonly ObservedProbe[];
  readonly results: readonly CheckResult[];
  readonly input: ManifestConsistencyInput;
}

function flattenHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

async function realFetch(url: string, timeoutMs: number): Promise<{
  status: number;
  headers: Record<string, string>;
}> {
  const response = await fetch(url, {
    method: "GET",
    headers: { accept: "application/json" },
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: response.status, headers: flattenHeaders(response.headers) };
}

/** Build the observed entry from a real response, never from the manifest. */
function observeResponse(
  path: string,
  status: number,
  headers: Record<string, string>,
): ObservedProbe {
  const rawHeader = findHeader(headers, "payment-required");
  // Well-formed placeholders keep c1.input usable so that c1.challenge-shape
  // — not a blanket input failure — reports the unusable challenge.
  const placeholder: ObservedEntry = {
    path,
    responseStatus: status,
    hasPaymentRequired: false,
    network: 1,
    payTo: `0x${"0".repeat(40)}`,
    asset: `0x${"0".repeat(40)}`,
    amount: "0",
  };

  if (rawHeader === undefined) {
    return { path, status, hasPaymentRequired: false, entry: placeholder };
  }
  const decoded = decodeHeaderValue(rawHeader);
  if (!decoded.ok) throw new Error(`PAYMENT-REQUIRED cannot be decoded at ${path}: ${decoded.error}`);
  const record = decoded.value as Record<string, unknown>;
  if (typeof record !== "object" || record === null || Array.isArray(record))
    throw new Error(`PAYMENT-REQUIRED at ${path} is not a JSON object`);
  const option = pickPaymentOption(record);
  if (option === undefined)
    throw new Error(`PAYMENT-REQUIRED at ${path} has no payment option`);

  // Read the same fields, in the same order, as C2. A top-level network that
  // disagrees with the option must not mask the chain the client signs for.
  // A number above 2^53 was already rounded by JSON.parse; check this before
  // the presence check so the diagnostic names the real problem rather than
  // claiming the field is missing.
  const unsafe = unsafeIntegerFields(option, [
    "maxAmountRequired", "amount", "maxAmount", "price", "network", "chainId", "chain",
  ]);
  if (unsafe.length > 0)
    throw new Error(`PAYMENT-REQUIRED at ${path} has unsafe numeric fields: ${unsafe.join(", ")}`);

  const network = pickRaw(option, ["network", "chainId", "chain"]);
  const payTo = pickString(option, ["payTo", "payToAddress", "recipient", "receiver"]);
  const asset = pickString(option, ["asset", "token", "assetAddress"]);
  const amount = pickString(option, ["maxAmountRequired", "amount", "maxAmount", "price"]);

  if (
    network === undefined ||
    payTo === undefined ||
    asset === undefined ||
    amount === undefined
  )
    throw new Error(`PAYMENT-REQUIRED at ${path} is missing a required payment field`);
  const entry: ObservedEntry = {
    path,
    responseStatus: status,
    hasPaymentRequired: true,
    network: network as string | number,
    payTo,
    asset,
    amount,
  };
  return { path, status, hasPaymentRequired: true, entry };
}

export function isManifestSource(value: unknown): value is ManifestSource {
  return (
    value === "static-file" ||
    value === "well-known" ||
    value === "challenge-echo" ||
    value === "unknown"
  );
}

/**
 * Probe every declared endpoint and evaluate C1.
 *
 * The base URL is joined with the declared path verbatim: the manifest is the
 * contract under test, so silently normalising its paths would hide drift.
 */
export async function runManifestProbes(
  options: ManifestProbeOptions,
): Promise<ManifestProbeResult> {
  const { entries, baseUrl, source } = options;
  if (!isManifestSource(source)) throw new TypeError(`unknown manifest source: ${String(source)}`);
  if (!Array.isArray(entries)) throw new TypeError("entries must be an array");
  if (typeof baseUrl !== "string" || baseUrl.length === 0)
    throw new TypeError("baseUrl must be a non-empty string");
  const timeoutMs = options.timeoutMs ?? 10000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
    throw new TypeError("timeoutMs must be a positive safe integer");

  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new TypeError(`baseUrl is not a valid URL: ${baseUrl}`);
  }
  if (base.protocol !== "http:" && base.protocol !== "https:")
    throw new TypeError(`baseUrl must be http or https: ${baseUrl}`);

  const fetcher = options.fetcher ?? realFetch;
  const probes: ObservedProbe[] = [];
  for (const entry of entries) {
    const resolved = new URL(entry.path, base);
    if (resolved.origin !== base.origin || resolved.protocol !== base.protocol)
      throw new Error(`declared path escapes the target origin: ${entry.path}`);
    const target = resolved.toString();
    let response: { status: number; headers: Record<string, string> };
    try {
      response = await fetcher(target, timeoutMs);
    } catch (error) {
      throw new Error(
        `transport failure probing ${entry.path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599)
      throw new TypeError(`invalid HTTP status probing ${entry.path}: ${String(response.status)}`);
    probes.push(observeResponse(entry.path, response.status, response.headers));
  }

  const input: ManifestConsistencyInput = {
    source,
    manifest: entries,
    observed: probes.map((probe) => probe.entry),
  };
  return {
    source,
    baseUrl,
    probes,
    results: checkManifestConsistency(input),
    input,
  };
}
