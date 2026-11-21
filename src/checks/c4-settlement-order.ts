/**
 * C4 — settlement order.
 *
 * C2 checks the quote, C3 checks the signature. C4 is the only check that
 * touches money: did the server settle at the right point in the request?
 * It answers that from four probe observations injected by a runner, never
 * from a single client response — a server can claim "settled" in its own
 * headers while neither forwarding upstream nor calling the facilitator.
 *
 * This module is a pure function: no fetch, no env, no clock. The runner that
 * owns the mock upstream and facilitator supplies the trusted observations;
 * see docs/CHECKS.md for why the four probes and their skip rules exist.
 */

import { asRecord } from "./parse.js";
import { decodeHeaderValue, findHeader } from "../wire.js";
import { fail, pass, skip, type CheckLevel, type CheckResult } from "./types.js";

export type ProbeName =
  | "unsigned"
  | "invalidSignature"
  | "upstreamError"
  | "upstreamSuccess";

export interface ProbeObservation {
  readonly probe: ProbeName;
  /** Status the server returned to the client. */
  readonly responseStatus: number;
  /** Headers the server returned to the client, including PAYMENT-RESPONSE. */
  readonly responseHeaders: Record<string, string>;
  /** Whether the upstream actually received the request. */
  readonly upstreamCalled: boolean;
  /** Upstream status code, or undefined when it was never called. */
  readonly upstreamStatus: number | undefined;
  /** Whether settlement actually happened. */
  readonly settled: boolean;
  /** Facilitator settle status, or undefined when settlement never happened. */
  readonly settlementStatus: number | undefined;
}

export interface SettlementOrderInput {
  readonly observations: readonly ProbeObservation[];
}

const ALL_PROBES: readonly ProbeName[] = [
  "unsigned",
  "invalidSignature",
  "upstreamError",
  "upstreamSuccess",
];

const ID = {
  probes: "c4.probes",
  unsignedStatus: "c4.unsigned.status",
  unsignedNoForward: "c4.unsigned.no-forward",
  unsignedNoSettle: "c4.unsigned.no-settle",
  invalidStatus: "c4.invalid-signature.status",
  invalidNoForward: "c4.invalid-signature.no-forward",
  invalidNoSettle: "c4.invalid-signature.no-settle",
  errorForwarded: "c4.upstream-error.forwarded",
  errorNoSettle: "c4.upstream-error.no-settle",
  successForwarded: "c4.upstream-success.forwarded",
  successSettled: "c4.upstream-success.settled",
  successReceipt: "c4.upstream-success.receipt",
} as const;

const CHECK_ORDER: ReadonlyArray<{
  readonly id: string;
  readonly title: string;
  readonly level: CheckLevel;
}> = [
  { id: ID.probes, title: "four probe observations are present and well-typed", level: "critical" },
  { id: ID.unsignedStatus, title: "unsigned request returns 402", level: "critical" },
  { id: ID.unsignedNoForward, title: "unsigned request is not forwarded upstream", level: "critical" },
  { id: ID.unsignedNoSettle, title: "unsigned request is not settled", level: "critical" },
  { id: ID.invalidStatus, title: "invalid-signature request returns 402", level: "critical" },
  { id: ID.invalidNoForward, title: "invalid-signature request is not forwarded upstream", level: "critical" },
  { id: ID.invalidNoSettle, title: "invalid-signature request is not settled", level: "critical" },
  { id: ID.errorForwarded, title: "upstream-error probe reached the upstream", level: "critical" },
  { id: ID.errorNoSettle, title: "upstream 4xx/5xx is not settled", level: "critical" },
  { id: ID.successForwarded, title: "upstream-success probe reached a 2xx upstream", level: "critical" },
  { id: ID.successSettled, title: "upstream 2xx is settled", level: "critical" },
  { id: ID.successReceipt, title: "success returns 200 with a valid PAYMENT-RESPONSE receipt", level: "critical" },
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

/** Validate one observation without trusting the probe label to carry truth. */
function validObservation(value: unknown): value is ProbeObservation {
  const record = asRecord(value);
  if (record === undefined) return false;
  if (!ALL_PROBES.includes(record["probe"] as ProbeName)) return false;
  if (!isStatus(record["responseStatus"])) return false;
  if (!isOptionalStatus(record["upstreamStatus"])) return false;
  if (!isOptionalStatus(record["settlementStatus"])) return false;
  if (typeof record["upstreamCalled"] !== "boolean") return false;
  if (typeof record["settled"] !== "boolean") return false;

  // Cross-field consistency. A boolean that contradicts its own status field
  // is not a usable observation: trusting it is exactly how a server could
  // report "no settlement" while the facilitator status shows a charge.
  const upstreamCalled = record["upstreamCalled"];
  const upstreamStatus = record["upstreamStatus"];
  if (upstreamCalled && upstreamStatus === undefined) return false;
  if (!upstreamCalled && upstreamStatus !== undefined) return false;
  const settled = record["settled"];
  const settlementStatus = record["settlementStatus"];
  // "settled" means settlement really happened: the facilitator must have
  // returned a success status. Those two fields must stay in lockstep.
  if (settled) {
    if (settlementStatus === undefined) return false;
    if (settlementStatus < 200 || settlementStatus >= 300) return false;
  } else if (settlementStatus !== undefined) {
    return false;
  }

  const headers = asRecord(record["responseHeaders"]);
  if (headers === undefined) return false;
  // responseHeaders is Record<string,string>. A non-string value would make
  // header decoding throw, turning a check into a crash instead of a verdict.
  for (const value of Object.values(headers)) {
    if (typeof value !== "string") return false;
  }
  return true;
}

const TX_HASH_ALIASES = ["txHash", "transactionHash", "tx", "hash"] as const;
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

type ReceiptResult =
  | { readonly ok: true; readonly txHash: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Decode PAYMENT-RESPONSE and find a usable tx hash.
 *
 * A header that decodes to an empty object, a placeholder, or a malformed hash
 * is worse than no header: it looks like proof of payment while being useless
 * for reconciliation. Fail closed on every one of those.
 */
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

  // v2 wraps the receipt; some builds put the fields at the top level.
  // Read both wrappers independently: an empty or malformed `receipt` must not
  // hide a valid `settlement`, matching parse.ts's alias tolerance.
  const candidates: Record<string, unknown>[] = [document];
  const receipt = asRecord(document["receipt"]);
  if (receipt !== undefined) candidates.push(receipt);
  const settlement = asRecord(document["settlement"]);
  if (settlement !== undefined) candidates.push(settlement);

  for (const candidate of candidates) {
    for (const key of TX_HASH_ALIASES) {
      // Own properties only: an inherited key from a polluted prototype must
      // never stand in for a real receipt field.
      if (!Object.hasOwn(candidate, key)) continue;
      const value = candidate[key];
      if (typeof value !== "string") continue;
      // Empty strings are skipped, the same rule parse.ts uses for aliases.
      if (value.trim().length === 0) continue;
      if (!TX_HASH_RE.test(value)) {
        return { ok: false, reason: `${key} is not a 32-byte 0x-prefixed hash: "${value}"` };
      }
      return { ok: true, txHash: value };
    }
  }
  return { ok: false, reason: `no usable tx hash (looked for ${TX_HASH_ALIASES.join(", ")})` };
}

/**
 * Evaluate the four settlement-order probes.
 *
 * Returns 12 results in a fixed order. A malformed input set yields one
 * critical failure plus explicit skips; skipped assertions are never passes.
 */
export function checkSettlementOrder(input: SettlementOrderInput): CheckResult[] {
  const results: CheckResult[] = [];
  const observations = input.observations;

  const byProbe = new Map<ProbeName, ProbeObservation>();
  const duplicates: ProbeName[] = [];
  const invalid: string[] = [];
  if (!Array.isArray(observations)) {
    results.push(fail(ID.probes, titleOf(ID.probes), "observations must be an array", "critical"));
    skipFrom(results, ID.probes, "invalid probe observations");
    return results;
  }
  for (let index = 0; index < observations.length; index++) {
    const entry = observations[index];
    if (!validObservation(entry)) {
      invalid.push(`index ${index} is not a well-formed probe observation`);
      continue;
    }
    if (byProbe.has(entry.probe)) duplicates.push(entry.probe);
    else byProbe.set(entry.probe, entry);
  }
  const missing = ALL_PROBES.filter((probe) => !byProbe.has(probe));
  const problems = [
    ...invalid,
    ...(duplicates.length > 0 ? [`duplicate probes: ${duplicates.join(", ")}`] : []),
    ...(missing.length > 0 ? [`missing probes: ${missing.join(", ")}`] : []),
  ];

  if (problems.length > 0) {
    results.push(
      fail(ID.probes, titleOf(ID.probes), problems.join("; "), "critical", {
        missing,
        duplicates,
        invalidCount: invalid.length,
      }),
    );
    skipFrom(results, ID.probes, "probe observations are incomplete or malformed");
    return results;
  }

  results.push(
    pass(ID.probes, titleOf(ID.probes), "all four probes present and well-typed", "critical", {
      probes: ALL_PROBES.slice(),
    }),
  );

  const unsigned = byProbe.get("unsigned")!;
  results.push(
    unsigned.responseStatus === 402
      ? pass(ID.unsignedStatus, titleOf(ID.unsignedStatus), "unsigned request returned 402", "critical")
      : fail(
          ID.unsignedStatus,
          titleOf(ID.unsignedStatus),
          `unsigned request returned ${unsigned.responseStatus}, expected 402 — a free request was served or failed for the wrong reason`,
          "critical",
          { responseStatus: unsigned.responseStatus },
        ),
  );
  results.push(
    unsigned.upstreamCalled
      ? fail(
          ID.unsignedNoForward,
          titleOf(ID.unsignedNoForward),
          "unsigned request reached the upstream — paid content is reachable without paying",
          "critical",
        )
      : pass(ID.unsignedNoForward, titleOf(ID.unsignedNoForward), "upstream was not called", "critical"),
  );
  results.push(
    unsigned.settled
      ? fail(
          ID.unsignedNoSettle,
          titleOf(ID.unsignedNoSettle),
          `unsigned request was settled (facilitator status ${String(unsigned.settlementStatus)}) — charging without authorisation`,
          "critical",
        )
      : pass(ID.unsignedNoSettle, titleOf(ID.unsignedNoSettle), "no settlement occurred", "critical"),
  );

  const invalidSig = byProbe.get("invalidSignature")!;
  results.push(
    invalidSig.responseStatus === 402
      ? pass(ID.invalidStatus, titleOf(ID.invalidStatus), "invalid-signature request returned 402", "critical")
      : fail(
          ID.invalidStatus,
          titleOf(ID.invalidStatus),
          `invalid-signature request returned ${invalidSig.responseStatus}, expected 402`,
          "critical",
          { responseStatus: invalidSig.responseStatus },
        ),
  );
  results.push(
    invalidSig.upstreamCalled
      ? fail(
          ID.invalidNoForward,
          titleOf(ID.invalidNoForward),
          "invalid-signature request reached the upstream — forged authorisation served paid content",
          "critical",
        )
      : pass(ID.invalidNoForward, titleOf(ID.invalidNoForward), "upstream was not called", "critical"),
  );
  results.push(
    invalidSig.settled
      ? fail(
          ID.invalidNoSettle,
          titleOf(ID.invalidNoSettle),
          `invalid-signature request was settled (facilitator status ${String(invalidSig.settlementStatus)})`,
          "critical",
        )
      : pass(ID.invalidNoSettle, titleOf(ID.invalidNoSettle), "no settlement occurred", "critical"),
  );

  const upstreamError = byProbe.get("upstreamError")!;
  // The probe is only meaningful when the upstream actually failed. A 2xx or
  // 3xx here means the "upstream error" scenario was never set up, so asserting
  // "no settlement on failure" would be a vacuous pass.
  const errorStatus = upstreamError.upstreamStatus;
  const errorForwarded =
    upstreamError.upstreamCalled && errorStatus !== undefined && errorStatus >= 400;
  results.push(
    errorForwarded
      ? pass(
          ID.errorForwarded,
          titleOf(ID.errorForwarded),
          `upstream was called and returned ${String(errorStatus)}`,
          "critical",
          { upstreamStatus: errorStatus },
        )
      : fail(
          ID.errorForwarded,
          titleOf(ID.errorForwarded),
          `upstream-error probe did not reach a failing (4xx/5xx) upstream (called=${upstreamError.upstreamCalled}, status=${String(errorStatus)}) — the no-settle assertion cannot be evaluated`,
          "critical",
          { upstreamStatus: errorStatus ?? null, upstreamCalled: upstreamError.upstreamCalled },
        ),
  );
  if (!errorForwarded) {
    results.push(
      skip(
        ID.errorNoSettle,
        titleOf(ID.errorNoSettle),
        `no 4xx/5xx upstream failure to evaluate (called=${upstreamError.upstreamCalled}, status=${String(errorStatus)})`,
        "critical",
      ),
    );
  } else if (upstreamError.settled) {
    results.push(
      fail(
        ID.errorNoSettle,
        titleOf(ID.errorNoSettle),
        `upstream returned ${String(upstreamError.upstreamStatus)} but settlement happened (facilitator status ${String(upstreamError.settlementStatus)}) — the payer was charged for content that was not delivered`,
        "critical",
        { upstreamStatus: upstreamError.upstreamStatus, settlementStatus: upstreamError.settlementStatus },
      ),
    );
  } else {
    results.push(
      pass(ID.errorNoSettle, titleOf(ID.errorNoSettle), `upstream returned ${String(upstreamError.upstreamStatus)} and no settlement occurred`, "critical"),
    );
  }

  const upstreamSuccess = byProbe.get("upstreamSuccess")!;
  const successForwarded =
    upstreamSuccess.upstreamCalled &&
    upstreamSuccess.upstreamStatus !== undefined &&
    upstreamSuccess.upstreamStatus >= 200 &&
    upstreamSuccess.upstreamStatus < 300;
  results.push(
    successForwarded
      ? pass(ID.successForwarded, titleOf(ID.successForwarded), `upstream returned ${String(upstreamSuccess.upstreamStatus)}`, "critical")
      : fail(
          ID.successForwarded,
          titleOf(ID.successForwarded),
          `upstream-success probe did not reach a 2xx upstream (called=${upstreamSuccess.upstreamCalled}, status=${String(upstreamSuccess.upstreamStatus)})`,
          "critical",
        ),
  );
  if (!successForwarded) {
    results.push(
      skip(ID.successSettled, titleOf(ID.successSettled), "no successful upstream response to settle against", "critical"),
      skip(ID.successReceipt, titleOf(ID.successReceipt), "no successful upstream response to receipt", "critical"),
    );
  } else {
    results.push(
      upstreamSuccess.settled
        ? pass(ID.successSettled, titleOf(ID.successSettled), `settlement succeeded (facilitator status ${String(upstreamSuccess.settlementStatus)})`, "critical")
        : fail(
            ID.successSettled,
            titleOf(ID.successSettled),
            "upstream returned 2xx but no settlement occurred — paid content was delivered for free",
            "critical",
          ),
    );
    const receipt = readReceipt(upstreamSuccess.responseHeaders);
    if (upstreamSuccess.responseStatus !== 200) {
      results.push(
        fail(
          ID.successReceipt,
          titleOf(ID.successReceipt),
          `settled success returned ${upstreamSuccess.responseStatus}, expected 200`,
          "critical",
          { responseStatus: upstreamSuccess.responseStatus },
        ),
      );
    } else if (!receipt.ok) {
      results.push(
        fail(ID.successReceipt, titleOf(ID.successReceipt), receipt.reason, "critical", {
          responseStatus: upstreamSuccess.responseStatus,
        }),
      );
    } else {
      results.push(
        pass(ID.successReceipt, titleOf(ID.successReceipt), `200 with PAYMENT-RESPONSE txHash ${receipt.txHash}`, "critical", {
          txHash: receipt.txHash,
        }),
      );
    }
  }

  return results;
}
