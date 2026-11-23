/**
 * C1 — manifest consistency.
 *
 * A manifest (`service.yaml` / `.well-known/x402`) and the 402 challenge a
 * client actually receives are two independent claims. Sellers edit one and
 * forget the other; clients then pay the wrong address, the wrong chain or the
 * wrong amount. This check compares the two structured observations.
 *
 * Pure function: no YAML parsing, no fetch, no clock. The runner parses the
 * manifest, probes the endpoints and reports where the manifest came from.
 * That last part matters: a manifest rebuilt from the observed challenge must
 * not be allowed to "pass" a comparison against itself. See docs/CHECKS.md.
 */

import { chainIdFromNetworkField } from "../networks.js";
import { asRecord } from "./parse.js";
import { fail, pass, skip, type CheckLevel, type CheckResult } from "./types.js";

export type ManifestSource = "static-file" | "well-known" | "challenge-echo" | "unknown";

export interface ManifestEntry {
  /** Endpoint path, normalised by the runner. */
  readonly path: string;
  /** CAIP-2 string or numeric chain id. */
  readonly network: string | number;
  readonly payTo: string;
  readonly asset: string;
  /** Atomic units, canonical decimal string. */
  readonly amount: string;
}

export interface ObservedEntry {
  readonly path: string;
  readonly responseStatus: number;
  readonly hasPaymentRequired: boolean;
  readonly network: string | number;
  readonly payTo: string;
  readonly asset: string;
  readonly amount: string;
}

export interface ManifestConsistencyInput {
  readonly source: ManifestSource;
  readonly manifest: readonly ManifestEntry[];
  readonly observed: readonly ObservedEntry[];
}

const ID = {
  input: "c1.input",
  source: "c1.source-independent",
  manifest: "c1.manifest-present",
  observed: "c1.observed-present",
  shape: "c1.challenge-shape",
  undeclared: "c1.no-undeclared",
  ghost: "c1.no-ghost",
  network: "c1.network-match",
  payTo: "c1.pay-to-match",
  asset: "c1.asset-match",
  amount: "c1.amount-match",
  conflict: "c1.no-conflict",
} as const;

const CHECK_ORDER: ReadonlyArray<{
  readonly id: string;
  readonly title: string;
  readonly level: CheckLevel;
}> = [
  { id: ID.input, title: "input is structurally valid", level: "critical" },
  { id: ID.source, title: "manifest comes from an independent source", level: "critical" },
  { id: ID.manifest, title: "manifest declares at least one endpoint", level: "critical" },
  { id: ID.observed, title: "at least one endpoint was probed", level: "critical" },
  { id: ID.shape, title: "every probed endpoint returned a 402 challenge", level: "critical" },
  { id: ID.undeclared, title: "no probed endpoint is missing from the manifest", level: "critical" },
  { id: ID.ghost, title: "no declared endpoint is missing from the probes", level: "critical" },
  { id: ID.network, title: "declared and observed networks agree", level: "critical" },
  { id: ID.payTo, title: "declared and observed payment receivers agree", level: "critical" },
  { id: ID.asset, title: "declared and observed assets agree", level: "critical" },
  { id: ID.amount, title: "declared and observed amounts agree", level: "critical" },
  { id: ID.conflict, title: "manifest has no contradictory duplicate declarations", level: "warning" },
];

const TITLES = new Map(CHECK_ORDER.map((entry) => [entry.id, entry.title] as const));
const LEVELS = new Map(CHECK_ORDER.map((entry) => [entry.id, entry.level] as const));

function titleOf(id: string): string {
  return TITLES.get(id) ?? id;
}

function skipFrom(results: CheckResult[], afterId: string, reason: string): void {
  const order = CHECK_ORDER.map((entry) => entry.id);
  const start = order.indexOf(afterId);
  if (start < 0) return;
  const reported = new Set(results.map((result) => result.id));
  for (const id of order.slice(start + 1)) {
    if (!reported.has(id)) {
      results.push(skip(id, titleOf(id), reason, LEVELS.get(id) ?? "critical"));
    }
  }
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(record, key);
}

/**
 * A thrown value can itself throw when stringified (Symbol.toPrimitive / toString).
 * Describing it must not become a second exception leaving the public API.
 */
function describeThrown(error: unknown): string {
  try {
    if (typeof error === "string") return error;
    return String(error);
  } catch {
    return `<${typeof error} with throwing stringification>`;
  }
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
// No leading zeros: "00100" and "100" must not be treated as one declaration.
const AMOUNT_RE = /^(0|[1-9][0-9]*)$/;
const SOURCES: readonly ManifestSource[] = [
  "static-file",
  "well-known",
  "challenge-echo",
  "unknown",
];

function validPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    value.startsWith("/") &&
    !/\s/.test(value)
  );
}

function validAddress(value: unknown): value is string {
  return typeof value === "string" && ADDRESS_RE.test(value);
}

function validAmount(value: unknown): value is string {
  return typeof value === "string" && AMOUNT_RE.test(value);
}

function validNetwork(value: unknown): value is string | number {
  return chainIdFromNetworkField(value) !== undefined;
}

/**
 * Validate and snapshot in one pass.
 *
 * Reading a field twice is a real attack surface: an accessor that returns a
 * valid value during validation and a different value during comparison makes
 * the whole suite report green for data that never matched. Every field is
 * therefore read exactly once and copied into a plain object; comparisons only
 * ever see the snapshot. The caller keeps no reference into the comparison.
 */
function snapshotManifestEntry(value: unknown): ManifestEntry | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  for (const key of ["path", "network", "payTo", "asset", "amount"] as const) {
    if (!hasOwn(record, key)) return undefined;
  }
  const path = record["path"];
  const network = record["network"];
  const payTo = record["payTo"];
  const asset = record["asset"];
  const amount = record["amount"];
  if (
    !validPath(path) ||
    !validNetwork(network) ||
    !validAddress(payTo) ||
    !validAddress(asset) ||
    !validAmount(amount)
  )
    return undefined;
  return { path, network, payTo, asset, amount };
}

function snapshotObservedEntry(value: unknown): ObservedEntry | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  for (const key of [
    "path",
    "responseStatus",
    "hasPaymentRequired",
    "network",
    "payTo",
    "asset",
    "amount",
  ] as const) {
    if (!hasOwn(record, key)) return undefined;
  }
  const path = record["path"];
  const responseStatus = record["responseStatus"];
  const hasPaymentRequired = record["hasPaymentRequired"];
  const network = record["network"];
  const payTo = record["payTo"];
  const asset = record["asset"];
  const amount = record["amount"];
  if (
    typeof responseStatus !== "number" ||
    !Number.isInteger(responseStatus) ||
    responseStatus < 100 ||
    responseStatus > 599 ||
    !validPath(path) ||
    typeof hasPaymentRequired !== "boolean" ||
    !validNetwork(network) ||
    !validAddress(payTo) ||
    !validAddress(asset) ||
    !validAmount(amount)
  )
    return undefined;
  return { path, responseStatus, hasPaymentRequired, network, payTo, asset, amount };
}

type FieldReader = (entry: ManifestEntry | ObservedEntry) => string | number;

const READERS: ReadonlyArray<{
  readonly id: string;
  readonly reader: FieldReader;
}> = [
  {
    id: ID.network,
    reader: (entry) => chainIdFromNetworkField(entry.network)!,
  },
  { id: ID.payTo, reader: (entry) => entry.payTo.toLowerCase() },
  { id: ID.asset, reader: (entry) => entry.asset.toLowerCase() },
  { id: ID.amount, reader: (entry) => entry.amount },
];

interface Indexed {
  readonly byPath: Map<string, Array<ManifestEntry | ObservedEntry>>;
}

function index(entries: readonly (ManifestEntry | ObservedEntry)[]): Indexed {
  const byPath = new Map<string, Array<ManifestEntry | ObservedEntry>>();
  for (const entry of entries) {
    const list = byPath.get(entry.path);
    if (list === undefined) byPath.set(entry.path, [entry]);
    else list.push(entry);
  }
  return { byPath };
}

function keyOf(entry: ManifestEntry | ObservedEntry): string {
  return `${String(chainIdFromNetworkField(entry.network))}`;
}

function describe(entry: ManifestEntry | ObservedEntry, reader: FieldReader): string {
  return String(reader(entry));
}

/**
 * Compare every observed entry against the declared entry for the same
 * (path, network) pair. Returns the mismatching paths and the comparable keys.
 */
function compareValues(
  manifest: Indexed,
  observed: Indexed,
  reader: FieldReader,
  id: string,
): { readonly mismatches: string[]; readonly compared: number } {
  const mismatches: string[] = [];
  let compared = 0;
  for (const [path, observedList] of observed.byPath) {
    const declaredList = manifest.byPath.get(path) ?? [];
    for (const actual of observedList) {
      const declared = declaredList.find((entry) => keyOf(entry) === keyOf(actual));
      if (declared === undefined) {
        // A path declared only on another chain is a network mismatch, not
        // merely a missing declaration. Without this, c1.network-match reports
        // green while the client pays on the wrong chain.
        if (id === ID.network && declaredList.length > 0) {
          const declaredChains = [...new Set(declaredList.map(keyOf))].join(", ");
          mismatches.push(
            `${path}: observed chain ${keyOf(actual)}, declared on chain/chains ${declaredChains}`,
          );
        }
        continue; // a truly absent path is reported by c1.no-undeclared
      }
      compared++;
      if (describe(declared, reader) !== describe(actual, reader)) {
        mismatches.push(
          `${path} (chain ${keyOf(actual)}): declared ${describe(declared, reader)}, observed ${describe(actual, reader)}`,
        );
      }
    }
  }
  return { mismatches, compared };
}

/**
 * Evaluate manifest consistency. Always returns 12 results in a fixed order.
 * Invalid input and untrustworthy sources yield one failure/skip plus explicit
 * skips for every dependent assertion.
 */
export function checkManifestConsistency(input: ManifestConsistencyInput): CheckResult[] {
  const results: CheckResult[] = [];
  const invalid: string[] = [];
  const declaredEntries: ManifestEntry[] = [];
  const observedEntries: ObservedEntry[] = [];
  let sourceValue: unknown;

  // Every property read happens exactly once, here, under one guard. An
  // accessor that throws is malformed input, not an exception for the caller;
  // an accessor that changes its value cannot affect the comparison because
  // only the snapshots below reach the verdict logic.
  try {
    const raw = asRecord(input);
    if (raw === undefined) {
      results.push(fail(ID.input, titleOf(ID.input), "input must be an object", "critical"));
      skipFrom(results, ID.input, "invalid C1 input");
      return results;
    }
    for (const key of ["source", "manifest", "observed"] as const) {
      if (!hasOwn(raw, key)) invalid.push(`missing ${key}`);
    }
    sourceValue = raw["source"];
    const rawManifest = raw["manifest"];
    const rawObserved = raw["observed"];
    if (!SOURCES.includes(sourceValue as ManifestSource)) {
      invalid.push(`unknown source: ${String(sourceValue)}`);
    }
    if (!Array.isArray(rawManifest)) invalid.push("manifest must be an array");
    if (!Array.isArray(rawObserved)) invalid.push("observed must be an array");
    if (Array.isArray(rawManifest)) {
      rawManifest.forEach((entry, index) => {
        const snapshot = snapshotManifestEntry(entry);
        if (snapshot !== undefined) declaredEntries.push(snapshot);
        else invalid.push(`manifest[${index}] is malformed`);
      });
    }
    if (Array.isArray(rawObserved)) {
      rawObserved.forEach((entry, index) => {
        const snapshot = snapshotObservedEntry(entry);
        if (snapshot !== undefined) observedEntries.push(snapshot);
        else invalid.push(`observed[${index}] is malformed`);
      });
    }
  } catch (error) {
    results.push(
      fail(
        ID.input,
        titleOf(ID.input),
        `input property access threw: ${describeThrown(error)}`,
        "critical",
      ),
    );
    skipFrom(results, ID.input, "C1 input access threw");
    return results;
  }

  if (invalid.length > 0) {
    results.push(
      fail(
        ID.input,
        titleOf(ID.input),
        `C1 input is not usable: ${invalid.join("; ")}`,
        "critical",
        { invalid },
      ),
    );
    skipFrom(results, ID.input, "C1 input is malformed");
    return results;
  }

  results.push(pass(ID.input, titleOf(ID.input), "manifest and probes are well-formed", "critical"));

  const source = sourceValue as ManifestSource;
  if (source === "challenge-echo") {
    results.push(
      fail(
        ID.source,
        titleOf(ID.source),
        "manifest was rebuilt from the observed challenge — comparing it with the challenge is self-evidence, not verification",
        "critical",
        { source },
      ),
    );
    skipFrom(results, ID.source, "manifest source is not independent");
    return results;
  }
  if (source === "unknown") {
    results.push(
      skip(
        ID.source,
        titleOf(ID.source),
        "runner could not establish an independent manifest source; no comparison can be trusted",
        "critical",
      ),
    );
    skipFrom(results, ID.source, "manifest source is unknown");
    return results;
  }
  results.push(
    pass(ID.source, titleOf(ID.source), `manifest source ${source} is independent`, "critical", {
      source,
    }),
  );

  if (declaredEntries.length === 0) {
    results.push(
      fail(ID.manifest, titleOf(ID.manifest), "manifest declares no endpoints", "critical"),
    );
    skipFrom(results, ID.manifest, "manifest is empty");
    return results;
  }
  results.push(
    pass(
      ID.manifest,
      titleOf(ID.manifest),
      `manifest declares ${declaredEntries.length} endpoint entry/entries`,
      "critical",
    ),
  );

  if (observedEntries.length === 0) {
    results.push(
      fail(ID.observed, titleOf(ID.observed), "no endpoint was probed", "critical"),
    );
    skipFrom(results, ID.observed, "no observed challenges");
    return results;
  }
  results.push(
    pass(
      ID.observed,
      titleOf(ID.observed),
      `${observedEntries.length} endpoint(s) were probed`,
      "critical",
    ),
  );

  const badShapes = observedEntries
    .filter((entry) => entry.responseStatus !== 402 || !entry.hasPaymentRequired)
    .map((entry) => `${entry.path}: status ${entry.responseStatus}, PAYMENT-REQUIRED ${entry.hasPaymentRequired}`);
  results.push(
    badShapes.length === 0
      ? pass(
          ID.shape,
          titleOf(ID.shape),
          "every probed endpoint returned 402 with PAYMENT-REQUIRED",
          "critical",
        )
      : fail(
          ID.shape,
          titleOf(ID.shape),
          `not a 402 challenge: ${badShapes.join("; ")}`,
          "critical",
          { paths: badShapes },
        ),
  );

  const declared = index(declaredEntries);
  const observed = index(observedEntries);

  // Path-level coverage only. A path declared on a different chain is a
  // network mismatch (c1.network-match), not an undeclared endpoint.
  const undeclared = observedEntries
    .filter((entry) => !declared.byPath.has(entry.path))
    .map((entry) => `${entry.path} (chain ${keyOf(entry)})`);
  results.push(
    undeclared.length === 0
      ? pass(ID.undeclared, titleOf(ID.undeclared), "every probed endpoint is declared", "critical")
      : fail(
          ID.undeclared,
          titleOf(ID.undeclared),
          `probed but not declared: ${undeclared.join(", ")}`,
          "critical",
          { paths: undeclared },
        ),
  );

  const ghosts = declaredEntries
    .filter((entry) => !observed.byPath.has(entry.path))
    .map((entry) => `${entry.path} (chain ${keyOf(entry)})`);
  results.push(
    ghosts.length === 0
      ? pass(ID.ghost, titleOf(ID.ghost), "every declared endpoint was probed as a 402", "critical")
      : fail(
          ID.ghost,
          titleOf(ID.ghost),
          `declared but not observed as a 402: ${ghosts.join(", ")}`,
          "critical",
          { paths: ghosts },
        ),
  );

  for (const { id, reader } of READERS) {
    const { mismatches, compared } = compareValues(declared, observed, reader, id);
    results.push(
      mismatches.length === 0
        ? pass(id, titleOf(id), `${compared} comparable endpoint(s) agree`, "critical", {
            compared,
          })
        : fail(id, titleOf(id), mismatches.join("; "), "critical", {
            compared,
            mismatches,
          }),
    );
  }

  const conflicts: string[] = [];
  for (const [path, entries] of declared.byPath) {
    const groups = new Map<string, ManifestEntry[]>();
    for (const entry of entries as ManifestEntry[]) {
      const key = keyOf(entry);
      const group = groups.get(key);
      if (group === undefined) groups.set(key, [entry]);
      else group.push(entry);
    }
    for (const [chainId, group] of groups) {
      if (group.length < 2) continue;
      const first = group[0]!;
      const rest = group.slice(1);
      for (const other of rest) {
        const differing = READERS.filter(
          ({ reader }) => describe(first, reader) !== describe(other, reader),
        ).map(({ id }) => id);
        if (differing.length > 0) {
          conflicts.push(`${path} (chain ${chainId}): ${differing.join(", ")}`);
        }
      }
    }
  }
  results.push(
    conflicts.length === 0
      ? pass(ID.conflict, titleOf(ID.conflict), "no contradictory duplicate declarations", "warning")
      : fail(
          ID.conflict,
          titleOf(ID.conflict),
          `contradictory declarations: ${conflicts.join("; ")}`,
          "warning",
          { conflicts },
        ),
  );

  return results;
}
