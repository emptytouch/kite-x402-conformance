/**
 * C1 manifest parser.
 *
 * Parses a service manifest (JSON or a deliberately small YAML subset) into
 * the structured entries the C1 verdict layer consumes. The parser is strict
 * about values and refuses to guess: a malformed manifest is a runner error,
 * never a "manifest inconsistency" verdict — reporting a parse failure as a
 * conformance failure would hide the real problem.
 *
 * Supported YAML is intentionally limited: a top-level `endpoints:` list of
 * mappings with scalar values. Anchors, block scalars, flow collections and
 * nested mappings are rejected rather than half-understood.
 */

import type { ManifestEntry } from "./checks/c1-manifest.js";
import { asRecord } from "./checks/parse.js";
import { chainIdFromNetworkField } from "./networks.js";

export type ManifestParseResult =
  | { readonly ok: true; readonly entries: readonly ManifestEntry[] }
  | { readonly ok: false; readonly error: string };

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const AMOUNT_RE = /^(0|[1-9][0-9]*)$/;
const FIELDS = ["path", "network", "payTo", "asset", "amount"] as const;

function validPath(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 512 &&
    value.startsWith("/") &&
    // "//host" and "/\host" are network-path references: new URL() would
    // resolve them to a different origin, escaping the service under test.
    !value.startsWith("//") &&
    !value.startsWith("/\\") &&
    // A fragment is never sent over HTTP, so the declared path would not be
    // the path actually probed.
    !value.includes("#") &&
    !/\s/.test(value)
  );
}

/** Normalise a parsed scalar without ever stringifying a JSON number. */
function scalar(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function toEntry(record: Record<string, unknown>, where: string): ManifestEntry | string {
  for (const field of FIELDS) {
    if (!Object.hasOwn(record, field)) return `${where}: missing ${field}`;
  }
  const path = scalar(record["path"]);
  const networkRaw = record["network"];
  const payTo = scalar(record["payTo"]);
  const asset = scalar(record["asset"]);
  const amount = scalar(record["amount"]);

  if (path === undefined || !validPath(path)) return `${where}: invalid path`;
  // Numbers are rejected, not stringified. JSON.parse can no longer tell that
  // 9007199254740993 became 9007199254740992 once we call String() on it.
  if (typeof networkRaw !== "string" && typeof networkRaw !== "number")
    return `${where}: invalid network`;
  if (chainIdFromNetworkField(networkRaw) === undefined)
    return `${where}: unparseable network`;
  if (payTo === undefined || !ADDRESS_RE.test(payTo)) return `${where}: invalid payTo`;
  if (asset === undefined || !ADDRESS_RE.test(asset)) return `${where}: invalid asset`;
  if (amount === undefined || !AMOUNT_RE.test(amount))
    return `${where}: amount must be a canonical decimal string`;

  return { path, network: networkRaw, payTo, asset, amount };
}

function fromJson(text: string): ManifestParseResult {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    return { ok: false, error: `invalid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  const record = asRecord(value);
  const rawList: unknown = record === undefined ? value : record["endpoints"];
  if (!Array.isArray(rawList)) return { ok: false, error: "JSON manifest needs an endpoints array" };

  const entries: ManifestEntry[] = [];
  const errors: string[] = [];
  rawList.forEach((item, index) => {
    const entryRecord = asRecord(item);
    if (entryRecord === undefined) {
      errors.push(`endpoints[${index}]: expected an object`);
      return;
    }
    const converted = toEntry(entryRecord, `endpoints[${index}]`);
    if (typeof converted === "string") errors.push(converted);
    else entries.push(converted);
  });
  if (errors.length > 0) return { ok: false, error: errors.join("; ") };
  return { ok: true, entries };
}

interface Scalar {
  readonly value: string;
  /** Quoted scalars are the only way to express an exact decimal string. */
  readonly quoted: boolean;
}

/** Strip a trailing YAML comment outside quotes. */
function stripComment(raw: string): string {
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];
    if (quote === undefined && (char === '"' || char === "'")) quote = char;
    else if (quote === char) quote = undefined;
    else if (char === "#" && quote === undefined && (i === 0 || /\s/.test(raw[i - 1]!)))
      return raw.slice(0, i);
  }
  return raw;
}

/** Decode one YAML scalar; reject escapes and anchors we do not interpret. */
function scalarValue(raw: string): Scalar | undefined {
  const value = raw.trim();
  if (/^[&*!|>]/.test(value)) return undefined;
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    const inner = value.slice(1, -1);
    if (/\\/.test(inner)) return undefined;
    return { value: inner, quoted: true };
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'"))
    return { value: value.slice(1, -1).replace(/''/g, "'"), quoted: true };
  if (/['"]/.test(value)) return undefined;
  return { value, quoted: false };
}

function splitKeyValue(line: string): { key: string; value: string } | undefined {
  const index = line.indexOf(":");
  if (index <= 0) return undefined;
  return { key: line.slice(0, index).trim(), value: line.slice(index + 1).trim() };
}

function fromYaml(text: string): ManifestParseResult {
  const lines = text.split(/\r?\n/);
  let inEndpoints = false;
  let current:
    | { fields: Map<string, Scalar>; line: number }
    | undefined;
  const records: Array<{ fields: Map<string, Scalar>; line: number }> = [];
  const errors: string[] = [];

  const flush = (): void => {
    if (current === undefined) return;
    records.push(current);
    current = undefined;
  };

  const apply = (pair: { key: string; value: string }, line: number): void => {
    const scalar = scalarValue(pair.value);
    if (scalar === undefined) {
      errors.push(`line ${line}: unsupported quoting, escape or YAML tag`);
      return;
    }
    if (current === undefined) {
      errors.push(`line ${line}: field outside an endpoint item`);
      return;
    }
    if (current.fields.has(pair.key)) {
      errors.push(`line ${line}: duplicate field ${pair.key}`);
      return;
    }
    current.fields.set(pair.key, scalar);
  };

  lines.forEach((rawLine, index) => {
    const lineNumber = index + 1;
    const withoutComment = stripComment(rawLine);
    const trimmed = withoutComment.trim();
    if (trimmed.length === 0) return;

    const isItem = trimmed.startsWith("- ");
    const topLevel = !/^\s/.test(rawLine);
    if (topLevel && trimmed === "endpoints:") {
      flush();
      inEndpoints = true;
      return;
    }
    if (!inEndpoints) return;
    // A top-level "- " is a valid (if unconventional) sequence start.
    if (topLevel && !isItem) {
      errors.push(`line ${lineNumber}: unexpected content in endpoints`);
      return;
    }

    if (isItem) {
      flush();
      const pair = splitKeyValue(trimmed.slice(2));
      if (pair === undefined) {
        errors.push(`line ${lineNumber}: expected key: value`);
        return;
      }
      current = { fields: new Map(), line: lineNumber };
      apply(pair, lineNumber);
      return;
    }

    const pair = splitKeyValue(trimmed);
    if (pair === undefined) {
      errors.push(`line ${lineNumber}: expected key: value`);
      return;
    }
    apply(pair, lineNumber);
  });
  flush();

  if (errors.length > 0) return { ok: false, error: errors.join("; ") };
  if (records.length === 0) return { ok: false, error: "no endpoints declared" };

  const entries: ManifestEntry[] = [];
  records.forEach(({ fields, line }) => {
    for (const key of FIELDS) {
      if (!fields.has(key)) {
        errors.push(`line ${line}: missing ${key}`);
        return;
      }
    }
    const path = fields.get("path")!.value;
    const network = fields.get("network")!;
    const payTo = fields.get("payTo")!.value;
    const asset = fields.get("asset")!.value;
    const amount = fields.get("amount")!;
    // A bare decimal integer cannot express an exact atomic-unit string, and
    // accepting one would hide a manifest authoring mistake. CAIP-2 strings
    // such as eip155:2368 are not bare numbers and stay valid unquoted.
    if (!network.quoted && /^\d+$/.test(network.value))
      errors.push(`line ${line}: numeric network must be quoted`);
    if (!amount.quoted) errors.push(`line ${line}: amount must be quoted`);
    const converted = toEntry(
      { path, network: network.value, payTo, asset, amount: amount.value },
      `line ${line}`,
    );
    if (typeof converted === "string") errors.push(converted);
    else entries.push(converted);
  });
  if (errors.length > 0) return { ok: false, error: errors.join("; ") };
  return { ok: true, entries };
}

/** Parse a manifest from raw text. Format is detected by the first non-space byte. */
export function parseManifest(text: string): ManifestParseResult {
  // Windows editors commonly emit UTF-8 with a BOM. Strip it once so both the
  // format detection and the parsers see the same normalized text.
  const normalized = text.replace(/^\uFEFF/, "");
  const trimmed = normalized.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return fromJson(normalized);
  return fromYaml(normalized);
}
