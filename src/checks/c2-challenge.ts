import { isAddress } from "viem";
import { z } from "zod";

import { matchNetwork, type KiteNetworkName } from "../networks.js";
import { decodeHeaderValue, findHeader } from "../wire.js";
import { fail, pass, skip, type CheckResult } from "./types.js";

/**
 * C2 — 402 challenge structure.
 *
 * Scope is deliberately narrow: C2 answers "does this endpoint advertise a
 * well-formed x402 v2 challenge on the expected Kite network?". It does not
 * verify signatures (C3) and does not settle anything (C4).
 *
 * Field names differ between SDK builds, so each field is read through an alias
 * list. When no alias is present the check fails — tolerant about naming,
 * strict about presence.
 */
export interface ChallengeInput {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly expectedNetwork: KiteNetworkName;
  /** When set, the advertised payTo must equal it. */
  readonly expectedPayTo?: string | undefined;
}

const HeaderNames = {
  required: "payment-required",
} as const;

const FIELD_ALIASES = {
  x402Version: ["x402Version", "x402_version", "version"],
  scheme: ["scheme"],
  network: ["network", "chainId", "chain"],
  asset: ["asset", "token", "assetAddress"],
  payTo: ["payTo", "payToAddress", "recipient", "receiver"],
  amount: ["maxAmountRequired", "amount", "maxAmount", "price"],
} as const;

const Envelope = z.object({ x402Version: z.number().int().positive() }).passthrough();

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function pickString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function pickAccept(decoded: Record<string, unknown>): Record<string, unknown> | undefined {
  const accepts = decoded["accepts"];
  if (Array.isArray(accepts)) return asRecord(accepts[0]);
  return asRecord(accepts);
}

function checkAmount(raw: string | undefined): { ok: boolean; reason: string } {
  if (raw === undefined) return { ok: false, reason: "no amount field found" };
  if (!/^\d+$/.test(raw)) {
    return { ok: false, reason: `amount must be a positive integer in atomic units, got "${raw}"` };
  }
  if (BigInt(raw) <= 0n) return { ok: false, reason: "amount is zero" };
  return { ok: true, reason: "amount is a positive integer" };
}

export function checkChallenge(input: ChallengeInput): CheckResult[] {
  const results: CheckResult[] = [];

  results.push(
    input.status === 402
      ? pass("c2.status", "HTTP status is 402", `received ${input.status}`)
      : fail(
          "c2.status",
          "HTTP status is 402",
          `expected 402 Payment Required, received ${input.status}`,
          "critical",
          { status: input.status },
        ),
  );

  const headerValue = findHeader(input.headers, HeaderNames.required);
  if (headerValue === undefined) {
    results.push(
      fail(
        "c2.header",
        "PAYMENT-REQUIRED header present",
        "no PAYMENT-REQUIRED header on the 402 response",
        "critical",
        { headerNames: Object.keys(input.headers) },
      ),
    );
    results.push(skip("c2.decode", "header decodes to JSON", "no header to decode"));
    return results;
  }
  results.push(
    pass("c2.header", "PAYMENT-REQUIRED header present", `${headerValue.length} characters`),
  );

  const decoded = decodeHeaderValue(headerValue);
  if (!decoded.ok) {
    results.push(
      fail("c2.decode", "header decodes to JSON", decoded.error, "critical", {
        headerSample: `${headerValue.slice(0, 24)}…`,
      }),
    );
    return results;
  }
  results.push(pass("c2.decode", "header decodes to JSON", "parsed as JSON"));

  const envelope = asRecord(decoded.value);
  if (envelope === undefined) {
    results.push(fail("c2.version", "x402 version is 2", "decoded payload is not a JSON object"));
    return results;
  }

  const version = envelope[FIELD_ALIASES.x402Version[0]] ?? envelope["x402Version"];
  const envelopeParsed = Envelope.safeParse(envelope);
  if (envelopeParsed.success && version === 2) {
    results.push(pass("c2.version", "x402 version is 2", "x402Version=2"));
  } else {
    results.push(
      fail(
        "c2.version",
        "x402 version is 2",
        `expected x402Version=2, got ${JSON.stringify(version ?? null)}`,
        "critical",
        { x402Version: version ?? null },
      ),
    );
  }

  const accept = pickAccept(envelope);
  if (accept === undefined) {
    results.push(fail("c2.scheme", "payment option found", "no `accepts` entry in the challenge"));
    results.push(skip("c2.network", "network matches", "no payment option to inspect"));
    results.push(skip("c2.asset", "asset address is valid", "no payment option to inspect"));
    results.push(skip("c2.pay-to", "payTo is a valid address", "no payment option to inspect"));
    results.push(skip("c2.amount", "amount is positive atomic integer", "no payment option to inspect"));
    return results;
  }

  const scheme = pickString(accept, FIELD_ALIASES.scheme);
  results.push(
    scheme === "exact"
      ? pass("c2.scheme", "scheme is exact", scheme)
      : fail("c2.scheme", "scheme is exact", `expected scheme=exact, got ${JSON.stringify(scheme ?? null)}`, "critical"),
  );

  const advertisedNetwork = accept["network"] ?? accept["chainId"] ?? accept["chain"];
  const networkMatch = matchNetwork(advertisedNetwork, input.expectedNetwork);
  results.push(
    networkMatch.ok
      ? pass("c2.network", "network matches expected Kite chain", networkMatch.reason, "critical", {
          normalised: networkMatch.normalised,
        })
      : fail("c2.network", "network matches expected Kite chain", networkMatch.reason, "critical", {
          normalised: networkMatch.normalised,
        }),
  );

  const asset = pickString(accept, FIELD_ALIASES.asset);
  if (asset === undefined) {
    results.push(
      skip("c2.asset", "asset address is valid", "no asset field; settle-time asset cannot be checked", "warning"),
    );
  } else if (isAddress(asset)) {
    results.push(pass("c2.asset", "asset address is valid", asset, "critical", { asset }));
  } else {
    results.push(fail("c2.asset", "asset address is valid", `not a valid EVM address: "${asset}"`, "critical", { asset }));
  }

  const payTo = pickString(accept, FIELD_ALIASES.payTo);
  if (payTo === undefined) {
    results.push(fail("c2.pay-to", "payTo is a valid address", "no payTo field in the payment option"));
  } else if (!isAddress(payTo)) {
    results.push(fail("c2.pay-to", "payTo is a valid address", `not a valid EVM address: "${payTo}"`, "critical", { payTo }));
  } else {
    results.push(pass("c2.pay-to", "payTo is a valid address", payTo, "critical", { payTo }));
  }

  const amountRaw = pickString(accept, FIELD_ALIASES.amount);
  const amount = checkAmount(amountRaw);
  results.push(
    amount.ok
      ? pass("c2.amount", "amount is positive atomic integer", `${amountRaw ?? ""} (atomic units)`)
      : fail("c2.amount", "amount is positive atomic integer", amount.reason, "critical", {
          amount: amountRaw ?? null,
        }),
  );

  if (input.expectedPayTo === undefined) {
    results.push(
      skip("c2.pay-to-match", "payTo matches the configured receiver", "KITE_EXPECTED_PAY_TO is not set"),
    );
  } else if (payTo !== undefined && payTo.toLowerCase() === input.expectedPayTo.toLowerCase()) {
    results.push(pass("c2.pay-to-match", "payTo matches the configured receiver", payTo));
  } else {
    results.push(
      fail(
        "c2.pay-to-match",
        "payTo matches the configured receiver",
        `expected ${input.expectedPayTo}, got ${payTo ?? "nothing"}`,
        "critical",
      ),
    );
  }

  return results;
}
