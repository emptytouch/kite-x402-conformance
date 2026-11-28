/**
 * C5 — replay and idempotency.
 *
 * C4 asks whether settlement happened at the right point in one request.
 * C5 asks the question that hits the payer's wallet directly: when the same
 * payment is submitted twice, is money taken twice? It covers three distinct
 * paths — a signature replay with a new idempotency key, a same-key retry,
 * and a re-signed authorization that reuses the same on-chain nonce.
 *
 * This is a pure function: no fetch, no env, no clock. The flags that matter
 * (settled, upstreamCalled, cacheHit) cannot be inferred from a client
 * response, so a runner with visibility into the facilitator, the upstream
 * and the cache supplies them. See docs/CHECKS.md for the scenario contract
 * and skip rules.
 */

import { asRecord } from "./parse.js";
import { decodeHeaderValue, findHeader } from "../wire.js";
import { fail, pass, skip, type CheckLevel, type CheckResult } from "./types.js";

export type ReplayScenarioName = "nonceReplay" | "idempotencyKey" | "nonceReuse";

export interface ReplayAttempt {
  /** Status returned to the client for this attempt. */
  readonly responseStatus: number;
  /** Headers returned to the client for this attempt, including PAYMENT-RESPONSE. */
  readonly responseHeaders: Record<string, string>;
  /** Stable digest of the response body, computed by the runner. */
  readonly responseBodyHash: string;
  /** Whether this attempt actually settled. */
  readonly settled: boolean;
  /** Facilitator settle status, or undefined when settlement never happened. */
  readonly settlementStatus: number | undefined;
  /** Whether this attempt actually reached the upstream. */
  readonly upstreamCalled: boolean;
  /** Upstream status code, or undefined when it was never called. */
  readonly upstreamStatus: number | undefined;
  /** Whether this attempt hit the server's idempotency cache. */
  readonly cacheHit: boolean;
}

export interface ReplayScenarioObservation {
  readonly scenario: ReplayScenarioName;
  readonly first: ReplayAttempt;
  readonly second: ReplayAttempt;
}

export interface ReplayIdempotencyInput {
  readonly scenarios: readonly ReplayScenarioObservation[];
}

const ALL_SCENARIOS: readonly ReplayScenarioName[] = [
  "nonceReplay",
  "idempotencyKey",
  "nonceReuse",
];

const ID = {
  scenarios: "c5.scenarios",
  nonceFirstSettled: "c5.nonce-replay.first-settled",
  nonceNoRebill: "c5.nonce-replay.no-rebill",
  nonceRejected: "c5.nonce-replay.rejected",
  nonceNoForward: "c5.nonce-replay.no-forward",
  idemFirstSettled: "c5.idempotency.first-settled",
  idemCached: "c5.idempotency.cached",
  idemNoRebill: "c5.idempotency.no-rebill",
  idemSameResult: "c5.idempotency.same-result",
  idemNoForward: "c5.idempotency.no-forward",
  reuseFirstSettled: "c5.nonce-reuse.first-settled",
  reuseNoRebill: "c5.nonce-reuse.no-rebill",
  reuseRejected: "c5.nonce-reuse.rejected",
} as const;

const CHECK_ORDER: ReadonlyArray<{
  readonly id: string;
  readonly title: string;
  readonly level: CheckLevel;
}> = [
  { id: ID.scenarios, title: "three replay scenarios are present and well-typed", level: "critical" },
  { id: ID.nonceFirstSettled, title: "nonce replay: first submission settled", level: "critical" },
  { id: ID.nonceNoRebill, title: "nonce replay: second submission is not settled", level: "critical" },
  { id: ID.nonceRejected, title: "nonce replay: second submission returns 402", level: "critical" },
  { id: ID.nonceNoForward, title: "nonce replay: second submission is not forwarded upstream", level: "critical" },
  { id: ID.idemFirstSettled, title: "idempotency retry: first attempt settled", level: "critical" },
  { id: ID.idemCached, title: "idempotency retry: second attempt hit the cache", level: "critical" },
  { id: ID.idemNoRebill, title: "idempotency retry: second attempt is not settled", level: "critical" },
  { id: ID.idemSameResult, title: "idempotency retry: second attempt returned the same result", level: "critical" },
  { id: ID.idemNoForward, title: "idempotency retry: second attempt was not forwarded upstream", level: "critical" },
  { id: ID.reuseFirstSettled, title: "nonce reuse: first authorization settled", level: "critical" },
  { id: ID.reuseNoRebill, title: "nonce reuse: re-signed submission is not settled", level: "critical" },
  { id: ID.reuseRejected, title: "nonce reuse: re-signed submission returns 402", level: "critical" },
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

function isStatus(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599;
}

function isOptionalStatus(value: unknown): value is number | undefined {
  return value === undefined || isStatus(value);
}

function is2xx(value: unknown): value is number {
  return isStatus(value) && value >= 200 && value < 300;
}

/**
 * Validate one attempt. Cross-field consistency is part of validation: a
 * boolean that contradicts its own status field is not a usable observation,
 * and trusting it is how a server could report "cached" while actually
 * charging the payer again.
 */
function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(record, key);
}

/**
 * Read a field once, remembering whether it was an own property. Checking
 * hasOwn and reading the value are two separate reads otherwise; an accessor
 * could show an own property with a benign value, then return a harmful one.
 */
function readOnce(
  record: Record<string, unknown>,
  key: string,
): { own: boolean; value: unknown } {
  return { own: Object.hasOwn(record, key), value: record[key] };
}

/**
 * Validate and snapshot an attempt in one pass.
 *
 * Reading a field twice is an attack surface: an accessor can return a valid
 * value during validation and a different one when the verdict is decided,
 * turning a real second charge into a green "no-rebill". Every field is read
 * exactly once and copied into a plain object; verdicts only see the snapshot.
 */
function snapshotAttempt(value: unknown): ReplayAttempt | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  // Read every field exactly once, capturing own-ness and value together.
  // Required fields must be own properties (a polluted prototype must not
  // supply the flags that decide whether money moved). Optional statuses may
  // be absent after a JSON round-trip, but an inherited non-undefined value
  // must never be accepted.
  const responseStatus = readOnce(record, "responseStatus");
  const responseHeaders = readOnce(record, "responseHeaders");
  const responseBodyHash = readOnce(record, "responseBodyHash");
  const settled = readOnce(record, "settled");
  const settlementStatus = readOnce(record, "settlementStatus");
  const upstreamCalled = readOnce(record, "upstreamCalled");
  const upstreamStatus = readOnce(record, "upstreamStatus");
  const cacheHit = readOnce(record, "cacheHit");
  for (const field of [responseStatus, responseHeaders, responseBodyHash, settled, upstreamCalled, cacheHit]) {
    if (!field.own) return undefined;
  }
  if (!settlementStatus.own && settlementStatus.value !== undefined) return undefined;
  if (!upstreamStatus.own && upstreamStatus.value !== undefined) return undefined;

  if (!isStatus(responseStatus.value)) return undefined;
  if (typeof responseBodyHash.value !== "string" || responseBodyHash.value.length === 0) return undefined;
  if (typeof settled.value !== "boolean") return undefined;
  if (typeof upstreamCalled.value !== "boolean") return undefined;
  if (typeof cacheHit.value !== "boolean") return undefined;
  if (!isOptionalStatus(settlementStatus.value)) return undefined;
  if (!isOptionalStatus(upstreamStatus.value)) return undefined;
  if (settled.value) {
    if (!is2xx(settlementStatus.value)) return undefined;
  } else if (settlementStatus.value !== undefined) {
    return undefined;
  }
  if (upstreamCalled.value && upstreamStatus.value === undefined) return undefined;
  if (!upstreamCalled.value && upstreamStatus.value !== undefined) return undefined;
  // A cache hit that also settled or reached upstream is the defect under test:
  // the observation is self-contradictory, so no verdict can be trusted.
  if (cacheHit.value && (settled.value || upstreamCalled.value)) return undefined;

  const headers = asRecord(responseHeaders.value);
  if (headers === undefined) return undefined;
  const headerSnapshot: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value !== "string") return undefined;
    headerSnapshot[name] = value;
  }

  return {
    responseStatus: responseStatus.value,
    responseHeaders: headerSnapshot,
    responseBodyHash: responseBodyHash.value,
    settled: settled.value,
    settlementStatus: settlementStatus.value,
    upstreamCalled: upstreamCalled.value,
    upstreamStatus: upstreamStatus.value,
    cacheHit: cacheHit.value,
  };
}

function snapshotScenario(value: unknown): ReplayScenarioObservation | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  if (!hasOwn(record, "scenario")) return undefined;
  const scenario = record["scenario"];
  if (!ALL_SCENARIOS.includes(scenario as ReplayScenarioName)) return undefined;
  if (!hasOwn(record, "first") || !hasOwn(record, "second")) return undefined;
  const first = snapshotAttempt(record["first"]);
  const second = snapshotAttempt(record["second"]);
  if (first === undefined || second === undefined) return undefined;
  return { scenario: scenario as ReplayScenarioName, first, second };
}

const TX_HASH_ALIASES = ["txHash", "transactionHash", "tx", "hash"] as const;
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

type ReceiptResult =
  | { readonly ok: true; readonly txHash: string }
  | { readonly ok: false; readonly reason: string };

/** Same fail-closed receipt rules as C4: aliases, own keys only, empty skipped. */
function readReceipt(headers: Record<string, string>): ReceiptResult {
  const raw = findHeader(headers, "payment-response");
  if (raw === undefined) return { ok: false, reason: "no PAYMENT-RESPONSE header" };
  if (typeof raw !== "string") {
    return { ok: false, reason: "PAYMENT-RESPONSE header is not a string" };
  }
  const decoded = decodeHeaderValue(raw);
  if (!decoded.ok) return { ok: false, reason: `PAYMENT-RESPONSE did not decode: ${decoded.error}` };
  const document = asRecord(decoded.value);
  if (document === undefined) return { ok: false, reason: "PAYMENT-RESPONSE is not a JSON object" };

  const candidates: Record<string, unknown>[] = [document];
  const receipt = asRecord(document["receipt"]);
  if (receipt !== undefined) candidates.push(receipt);
  const settlement = asRecord(document["settlement"]);
  if (settlement !== undefined) candidates.push(settlement);

  for (const candidate of candidates) {
    for (const key of TX_HASH_ALIASES) {
      if (!Object.hasOwn(candidate, key)) continue;
      const value = candidate[key];
      if (typeof value !== "string") continue;
      if (value.trim().length === 0) continue;
      if (!TX_HASH_RE.test(value)) {
        return { ok: false, reason: `${key} is not a 32-byte 0x-prefixed hash: "${value}"` };
      }
      return { ok: true, txHash: value };
    }
  }
  return { ok: false, reason: `no usable tx hash (looked for ${TX_HASH_ALIASES.join(", ")})` };
}

function rejected(responseStatus: number): boolean {
  return responseStatus === 402;
}

/**
 * Evaluate the three replay scenarios.
 *
 * Returns 13 results in a fixed order. A malformed scenario set yields one
 * critical failure plus explicit skips; skipped assertions are never passes.
 */
export function checkReplayIdempotency(input: ReplayIdempotencyInput): CheckResult[] {
  const results: CheckResult[] = [];
  const scenarios = input.scenarios;

  const byScenario = new Map<ReplayScenarioName, ReplayScenarioObservation>();
  const duplicates: ReplayScenarioName[] = [];
  const invalid: string[] = [];
  if (!Array.isArray(scenarios)) {
    results.push(fail(ID.scenarios, titleOf(ID.scenarios), "scenarios must be an array", "critical"));
    skipFrom(results, ID.scenarios, "invalid replay scenarios");
    return results;
  }
  for (let index = 0; index < scenarios.length; index++) {
    const snapshot = snapshotScenario(scenarios[index]);
    if (snapshot === undefined) {
      invalid.push(`index ${index} is not a well-formed replay scenario`);
      continue;
    }
    if (byScenario.has(snapshot.scenario)) duplicates.push(snapshot.scenario);
    else byScenario.set(snapshot.scenario, snapshot);
  }
  const missing = ALL_SCENARIOS.filter((name) => !byScenario.has(name));
  const problems = [
    ...invalid,
    ...(duplicates.length > 0 ? [`duplicate scenarios: ${duplicates.join(", ")}`] : []),
    ...(missing.length > 0 ? [`missing scenarios: ${missing.join(", ")}`] : []),
  ];

  if (problems.length > 0) {
    results.push(
      fail(ID.scenarios, titleOf(ID.scenarios), problems.join("; "), "critical", {
        missing,
        duplicates,
        invalidCount: invalid.length,
      }),
    );
    skipFrom(results, ID.scenarios, "replay scenarios are incomplete or malformed");
    return results;
  }

  results.push(
    pass(ID.scenarios, titleOf(ID.scenarios), "all three scenarios present and well-typed", "critical", {
      scenarios: ALL_SCENARIOS.slice(),
    }),
  );

  const nonce = byScenario.get("nonceReplay")!;
  results.push(
    nonce.first.settled
      ? pass(ID.nonceFirstSettled, titleOf(ID.nonceFirstSettled), "first submission settled", "critical")
      : fail(
          ID.nonceFirstSettled,
          titleOf(ID.nonceFirstSettled),
          `first submission did not settle (facilitator status ${String(nonce.first.settlementStatus)}) — the replay scenario was never set up`,
          "critical",
        ),
  );
  // no-rebill and no-forward stay live even when the first submission failed
  // or the second was rejected: a server can charge before returning an error.
  results.push(
    nonce.second.settled
      ? fail(
          ID.nonceNoRebill,
          titleOf(ID.nonceNoRebill),
          `a new idempotency key let the replayed signature settle again (facilitator status ${String(nonce.second.settlementStatus)}) — the payer was charged twice`,
          "critical",
        )
      : pass(ID.nonceNoRebill, titleOf(ID.nonceNoRebill), "replayed signature was not settled again", "critical"),
  );
  results.push(
    rejected(nonce.second.responseStatus)
      ? pass(ID.nonceRejected, titleOf(ID.nonceRejected), "replayed signature returned 402", "critical")
      : fail(
          ID.nonceRejected,
          titleOf(ID.nonceRejected),
          `replayed signature returned ${nonce.second.responseStatus}, expected 402 — an already-used authorization was accepted`,
          "critical",
          { responseStatus: nonce.second.responseStatus },
        ),
  );
  results.push(
    nonce.second.upstreamCalled
      ? fail(
          ID.nonceNoForward,
          titleOf(ID.nonceNoForward),
          `replayed signature reached the upstream (status ${String(nonce.second.upstreamStatus)}) — paid content is reachable with a replayed authorization`,
          "critical",
        )
      : pass(ID.nonceNoForward, titleOf(ID.nonceNoForward), "replayed signature was not forwarded upstream", "critical"),
  );

  const idem = byScenario.get("idempotencyKey")!;
  results.push(
    idem.first.settled
      ? pass(ID.idemFirstSettled, titleOf(ID.idemFirstSettled), "first attempt settled", "critical")
      : fail(
          ID.idemFirstSettled,
          titleOf(ID.idemFirstSettled),
          `first attempt did not settle (facilitator status ${String(idem.first.settlementStatus)}) — the retry scenario was never set up`,
          "critical",
        ),
  );
  results.push(
    idem.second.cacheHit
      ? pass(ID.idemCached, titleOf(ID.idemCached), "retry hit the idempotency cache", "critical")
      : fail(
          ID.idemCached,
          titleOf(ID.idemCached),
          "retry did not hit the cache — the server reprocessed an already-paid request",
          "critical",
        ),
  );
  results.push(
    idem.second.settled
      ? fail(
          ID.idemNoRebill,
          titleOf(ID.idemNoRebill),
          `same-key retry settled again (facilitator status ${String(idem.second.settlementStatus)}) — the payer was charged twice`,
          "critical",
        )
      : pass(ID.idemNoRebill, titleOf(ID.idemNoRebill), "same-key retry was not settled again", "critical"),
  );

  // Compare both status and body digest, then require a usable receipt on both
  // attempts. A settled retry without a receipt cannot be reconciled.
  const firstReceipt = readReceipt(idem.first.responseHeaders);
  const secondReceipt = readReceipt(idem.second.responseHeaders);
  const statusMatches = idem.first.responseStatus === idem.second.responseStatus;
  const bodyMatches = idem.first.responseBodyHash === idem.second.responseBodyHash;
  const receiptMatches =
    firstReceipt.ok && secondReceipt.ok && firstReceipt.txHash === secondReceipt.txHash;
  if (statusMatches && bodyMatches && receiptMatches) {
    results.push(
      pass(
        ID.idemSameResult,
        titleOf(ID.idemSameResult),
        `retry returned the same status, body digest and tx hash ${firstReceipt.txHash}`,
        "critical",
        { txHash: firstReceipt.txHash, responseStatus: idem.second.responseStatus },
      ),
    );
  } else {
    const differences: string[] = [];
    if (!statusMatches) {
      differences.push(`status ${idem.first.responseStatus} -> ${idem.second.responseStatus}`);
    }
    if (!bodyMatches) differences.push("response body digest differs");
    if (!firstReceipt.ok) differences.push(`first receipt unusable: ${firstReceipt.reason}`);
    if (!secondReceipt.ok) differences.push(`second receipt unusable: ${secondReceipt.reason}`);
    if (firstReceipt.ok && secondReceipt.ok && !receiptMatches) {
      differences.push(`tx hash ${firstReceipt.txHash} -> ${secondReceipt.txHash}`);
    }
    results.push(
      fail(
        ID.idemSameResult,
        titleOf(ID.idemSameResult),
        `retry result is not identical to the first attempt: ${differences.join("; ")}`,
        "critical",
        { differences },
      ),
    );
  }
  results.push(
    idem.second.upstreamCalled
      ? fail(
          ID.idemNoForward,
          titleOf(ID.idemNoForward),
          `same-key retry reached the upstream (status ${String(idem.second.upstreamStatus)}) despite a cache hit — duplicate side effects are possible`,
          "critical",
        )
      : pass(ID.idemNoForward, titleOf(ID.idemNoForward), "same-key retry was not forwarded upstream", "critical"),
  );

  const reuse = byScenario.get("nonceReuse")!;
  results.push(
    reuse.first.settled
      ? pass(ID.reuseFirstSettled, titleOf(ID.reuseFirstSettled), "first authorization settled", "critical")
      : fail(
          ID.reuseFirstSettled,
          titleOf(ID.reuseFirstSettled),
          `first authorization did not settle (facilitator status ${String(reuse.first.settlementStatus)}) — the nonce-reuse scenario was never set up, so "no second charge" would be vacuous`,
          "critical",
        ),
  );
  // no-rebill and rejected stay live even when the first authorization did
  // not settle: a server can charge on the second submission regardless.
  results.push(
    reuse.second.settled
      ? fail(
          ID.reuseNoRebill,
          titleOf(ID.reuseNoRebill),
          `reused nonce settled again (facilitator status ${String(reuse.second.settlementStatus)}) — the on-chain nonce guard is not enforced`,
          "critical",
        )
      : pass(ID.reuseNoRebill, titleOf(ID.reuseNoRebill), "reused nonce did not settle again", "critical"),
  );

  results.push(
    rejected(reuse.second.responseStatus)
      ? pass(ID.reuseRejected, titleOf(ID.reuseRejected), "re-signed authorization returned 402", "critical")
      : fail(
          ID.reuseRejected,
          titleOf(ID.reuseRejected),
          `re-signed authorization returned ${reuse.second.responseStatus}, expected 402 — re-signing bypassed the replay guard`,
          "critical",
          { responseStatus: reuse.second.responseStatus },
        ),
  );

  return results;
}
