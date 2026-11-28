/**
 * C3 — the authorisation a payer builds for a given challenge.
 *
 * C2 asks "does this endpoint ask for payment correctly?". C3 asks the other
 * half of the question: "would the payment a client builds for it actually
 * settle?" Everything here is offline — no RPC, no private key, no request — so
 * the same assertions run in CI against a captured payload.
 *
 * Design rule: every assertion below maps to a rejection the reference
 * facilitator already implements, and the mapping is recorded in
 * `docs/CHECKS.md`. Nothing here is an invented opinion about how x402 should
 * work; it is a restatement of what `@x402/evm` refuses to settle.
 *
 * The interesting case is recovery: if the signature recovers to the payer, the
 * domain, the struct hash and the signature encoding were all correct
 * simultaneously. If it does not, `c3.signature-recovery` reports *which* domain
 * variant would have matched, because "recovered 0xabc instead of 0xdef" is not
 * an actionable finding.
 */

import {
  getAddress,
  isAddress,
  isAddressEqual,
  isErc6492Signature,
  isHex,
  parseErc6492Signature,
  recoverAddress,
  zeroAddress,
  type Hex,
} from "viem";

import {
  eip3009Digest,
  eip712DomainSeparator,
  parseSignature65,
  transferWithAuthorizationStructHash,
  type Eip712Domain,
  type TransferWithAuthorization,
} from "../eip712.js";
import { chainIdFromNetworkField, KITE_NETWORKS, matchNetwork, type KiteNetworkName } from "../networks.js";
import { decodeHeaderValue } from "../wire.js";
import {
  AMOUNT_ALIASES,
  asRecord,
  pickPaymentOptions,
  pickRaw,
  pickRecord,
  pickString,
  pickStringWithConflict,
  unsafeIntegerFields,
} from "./parse.js";
import { fail, pass, skip, type CheckLevel, type CheckResult } from "./types.js";

/**
 * How much validity the reference facilitator demands beyond the current second
 * (`validBefore < now + 6` → `invalid_exact_evm_payload_authorization_valid_before`).
 * A signature that expires in three seconds is invalid before it is broadcast.
 */
export const REFERENCE_MIN_VALIDITY_SECONDS = 6;

const DEFAULT_MAX_WINDOW_SECONDS = 3600;
const MAX_UINT256 = (1n << 256n) - 1n;

const ASSET_KEYS = ["asset", "token", "assetAddress"] as const;
const PAY_TO_KEYS = ["payTo", "payToAddress", "recipient", "receiver"] as const;
const AMOUNT_KEYS = AMOUNT_ALIASES;

const ID = {
  challenge: "c3.challenge",
  payment: "c3.payment",
  payloadVersion: "c3.payload-version",
  payloadShape: "c3.payload-shape",
  acceptedBinding: "c3.accepted-binding",
  bindingPayTo: "c3.binding-payto",
  bindingValue: "c3.binding-value",
  addressSanity: "c3.address-sanity",
  domainConfig: "c3.domain-config",
  window: "c3.window",
  windowSpan: "c3.window-span",
  signatureFormat: "c3.signature-format",
  signatureLowS: "c3.signature-low-s",
  signatureRecovery: "c3.signature-recovery",
} as const;

/**
 * Declaration order is the execution order. `skipRemaining` walks this list after
 * a blocking failure, so a single root cause produces one red line plus explicit
 * "not evaluated" lines — never ten reds, and never a fake green.
 */
const CHECK_ORDER: ReadonlyArray<{ readonly id: string; readonly title: string; readonly level: CheckLevel }> = [
  { id: ID.challenge, title: "challenge decodes and carries a payment option", level: "critical" },
  { id: ID.payment, title: "PAYMENT-SIGNATURE decodes to JSON", level: "critical" },
  { id: ID.payloadVersion, title: "payment payload is x402 v2", level: "critical" },
  { id: ID.payloadShape, title: "authorisation carries six well-typed EIP-3009 fields", level: "critical" },
  { id: ID.acceptedBinding, title: "payload.accepted echoes the quoted option", level: "critical" },
  { id: ID.bindingPayTo, title: "authorisation pays the advertised receiver", level: "critical" },
  { id: ID.bindingValue, title: "authorisation amount equals the quoted amount", level: "critical" },
  { id: ID.addressSanity, title: "payer and payee are usable accounts", level: "warning" },
  { id: ID.domainConfig, title: "EIP-712 domain is derivable from the challenge", level: "critical" },
  { id: ID.window, title: "authorisation window is open at evaluation time", level: "critical" },
  { id: ID.windowSpan, title: "remaining replay window is within the advertised timeout", level: "warning" },
  { id: ID.signatureFormat, title: "signature is 65-byte r‖s‖v with v in {27,28}", level: "critical" },
  { id: ID.signatureLowS, title: "signature s is in the lower half order", level: "critical" },
  { id: ID.signatureRecovery, title: "signature recovers to the authorising payer", level: "critical" },
];

const TITLES = new Map(CHECK_ORDER.map((entry) => [entry.id, entry.title] as const));
const LEVELS = new Map(CHECK_ORDER.map((entry) => [entry.id, entry.level] as const));

function titleOf(id: string): string {
  return TITLES.get(id) ?? id;
}

function skipRemaining(results: CheckResult[], afterId: string, reason: string): void {
  const order = CHECK_ORDER.map((entry) => entry.id);
  const start = order.indexOf(afterId);
  if (start < 0) return;
  const reported = new Set(results.map((result) => result.id));
  for (const id of order.slice(start + 1)) {
    if (reported.has(id)) continue;
    results.push(skip(id, titleOf(id), reason, LEVELS.get(id) ?? "critical"));
  }
}

export interface AuthorizationInput {
  /** Raw `PAYMENT-REQUIRED` header value, or a saved challenge document. */
  readonly challengeHeader: string | undefined;
  /** Raw `PAYMENT-SIGNATURE` header value. */
  readonly paymentHeader: string | undefined;
  readonly expectedNetwork: KiteNetworkName;
  /** Unix seconds used for every window comparison. Injected so runs are reproducible. */
  readonly now: number;
  /** Required remaining validity; defaults to the reference facilitator's 6 seconds. */
  readonly minValiditySeconds?: number | undefined;
  /** Advisory cap on `validBefore - validAfter`; defaults to the advertised `maxTimeoutSeconds`. */
  readonly maxWindowSeconds?: number | undefined;
}

type FieldResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string };

function readUint(
  record: Record<string, unknown>,
  keys: readonly string[],
  label: string,
  conflictLabel?: string,
): FieldResult<bigint> {
  if (unsafeIntegerFields(record, keys).length > 0) {
    return {
      ok: false,
      reason: `${label} was sent as a JSON number above 2^53 and has already been rounded; send a decimal string`,
    };
  }
  // Safety-bearing fields (the quoted amount) must not silently pick the first
  // alias when several carry different values. C2 rejects the same conflict on
  // the challenge; without this, C3 could bind to a different amount than C2
  // validated and both checks would still pass.
  if (conflictLabel !== undefined) {
    const read = pickStringWithConflict(record, keys);
    if (read.conflicting.length > 0) {
      const detail = read.conflicting
        .map((key) => `${key}=${String(record[key])}`)
        .join(", ");
      return { ok: false, reason: `${conflictLabel} has conflicting aliases: ${detail}` };
    }
  }
  const raw = pickString(record, keys);
  if (raw === undefined) return { ok: false, reason: `${label} is missing` };
  if (!/^\d+$/.test(raw)) {
    return { ok: false, reason: `${label} must be a decimal integer string, got "${raw}"` };
  }
  const value = BigInt(raw);
  if (value > MAX_UINT256) return { ok: false, reason: `${label} does not fit in uint256` };
  return { ok: true, value };
}

function readAddress(
  record: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): FieldResult<Hex> {
  const raw = pickString(record, keys);
  if (raw === undefined) return { ok: false, reason: `${label} is missing` };
  if (!isAddress(raw)) return { ok: false, reason: `${label} is not a valid EVM address: "${raw}"` };
  return { ok: true, value: getAddress(raw) };
}

function readBytes32(
  record: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): FieldResult<Hex> {
  const raw = pickString(record, keys);
  if (raw === undefined) return { ok: false, reason: `${label} is missing` };
  if (!isHex(raw) || raw.length !== 66) {
    return {
      ok: false,
      reason: `${label} must be a 32-byte 0x-prefixed hex value, got "${raw}"`,
    };
  }
  return { ok: true, value: raw as Hex };
}

export type AuthorizationParse =
  | { readonly ok: true; readonly value: TransferWithAuthorization }
  | { readonly ok: false; readonly problems: readonly string[] };

function collect<T>(field: FieldResult<T>, problems: string[]): T | undefined {
  if (field.ok) return field.value;
  problems.push(field.reason);
  return undefined;
}

/**
 * Read the six EIP-3009 fields, reporting *all* problems at once.
 *
 * Reporting every problem is the one place where the "single root cause, single
 * red line" rule bends: a payload with a truncated nonce and a decimal `value`
 * is usually a serialiser bug, and seeing both halves at once points straight at
 * it. The caller still collapses them into one assertion.
 */
export function parseAuthorization(record: Record<string, unknown>): AuthorizationParse {
  const problems: string[] = [];
  const from = collect(readAddress(record, ["from", "payer"], "authorization.from"), problems);
  const to = collect(readAddress(record, ["to", "payee", "recipient"], "authorization.to"), problems);
  const value = collect(readUint(record, ["value", "amount"], "authorization.value"), problems);
  const validAfter = collect(readUint(record, ["validAfter", "valid_after"], "authorization.validAfter"), problems);
  const validBefore = collect(readUint(record, ["validBefore", "valid_before"], "authorization.validBefore"), problems);
  const nonce = collect(readBytes32(record, ["nonce"], "authorization.nonce"), problems);

  if (problems.length > 0) return { ok: false, problems };
  if (
    from === undefined ||
    to === undefined ||
    value === undefined ||
    validAfter === undefined ||
    validBefore === undefined ||
    nonce === undefined
  ) {
    // Unreachable: every undefined above also pushed a problem. Kept so the
    // narrowing is explicit rather than a cast.
    return { ok: false, problems: ["authorisation fields could not be read"] };
  }

  return { ok: true, value: { from, to, value, validAfter, validBefore, nonce } };
}

async function tryRecover(digest: Hex, signature: string): Promise<Hex | undefined> {
  try {
    return await recoverAddress({ hash: digest, signature: signature as Hex });
  } catch {
    return undefined;
  }
}

/**
 * Explain a failed recovery by trying the domain variants that clients get wrong
 * in practice: the version string and the chain id.
 *
 * A returned hit is proof of what the client signed against; an empty result
 * means the mismatch is in the content, the token `name`, or the key — which the
 * caller states instead of guessing.
 */
async function diagnoseDomainMismatch(
  domain: Eip712Domain,
  authorization: TransferWithAuthorization,
  signature: string,
  expectedFrom: Hex,
): Promise<string[]> {
  const versions = Array.from(new Set<string>([domain.version, "1", "2"]));
  const chainIds = Array.from(
    new Set<string>([String(domain.chainId), String(KITE_NETWORKS.mainnet.chainId), String(KITE_NETWORKS.testnet.chainId)]),
  );

  const hits: string[] = [];
  for (const version of versions) {
    for (const chainId of chainIds) {
      if (version === domain.version && chainId === String(domain.chainId)) continue;
      const digest = eip3009Digest({ ...domain, version, chainId: BigInt(chainId) }, authorization);
      const recovered = await tryRecover(digest, signature);
      if (recovered !== undefined && isAddressEqual(recovered, expectedFrom)) {
        hits.push(`version="${version}" chainId=${chainId}`);
      }
    }
  }
  return hits;
}

function sameAddress(left: string | undefined, right: string | undefined): boolean {
  if (left === undefined || right === undefined) return false;
  if (!isAddress(left) || !isAddress(right)) return false;
  return isAddressEqual(left, right);
}

/**
 * Compare an `accepted` echo with one advertised option.
 *
 * A challenge may advertise several options and the client may legally pick any
 * of them. Comparing against `accepts[0]` unconditionally produced a false
 * critical failure for a client that picked option 2. The check that matters is
 * "was this payment built from an option the seller actually advertised?", not
 * "was it the first one?".
 */
function acceptanceDeviations(
  option: Record<string, unknown>,
  accepted: Record<string, unknown>,
  expectedNetwork: KiteNetworkName,
): string[] {
  const deviations: string[] = [];
  const optionScheme = pickString(option, ["scheme"]);
  const acceptedScheme = pickString(accepted, ["scheme"]);
  if (optionScheme !== acceptedScheme) {
    deviations.push(
      `scheme: option=${JSON.stringify(optionScheme ?? null)} accepted=${JSON.stringify(acceptedScheme ?? null)}`,
    );
  }

  const optionNetwork = matchNetwork(pickRaw(option, ["network", "chainId", "chain"]), expectedNetwork).normalised;
  const acceptedNetwork = matchNetwork(pickRaw(accepted, ["network", "chainId"]), expectedNetwork).normalised;
  if (optionNetwork === null || acceptedNetwork === null || optionNetwork !== acceptedNetwork) {
    deviations.push(`network: option=${String(optionNetwork)} accepted=${String(acceptedNetwork)}`);
  }

  const optionAsset = pickString(option, ASSET_KEYS);
  const acceptedAsset = pickString(accepted, ASSET_KEYS);
  if (!sameAddress(optionAsset, acceptedAsset)) {
    deviations.push(`asset: option=${optionAsset ?? "missing"} accepted=${acceptedAsset ?? "missing"}`);
  }

  const optionPayTo = pickString(option, PAY_TO_KEYS);
  const acceptedPayTo = pickString(accepted, PAY_TO_KEYS);
  if (!sameAddress(optionPayTo, acceptedPayTo)) {
    deviations.push(`payTo: option=${optionPayTo ?? "missing"} accepted=${acceptedPayTo ?? "missing"}`);
  }

  const optionAmount = readUint(option, AMOUNT_KEYS, "option amount", "option amount");
  const acceptedAmount = readUint(accepted, AMOUNT_KEYS, "accepted amount", "accepted amount");
  if (!optionAmount.ok || !acceptedAmount.ok || optionAmount.value !== acceptedAmount.value) {
    const render = (field: FieldResult<bigint>): string =>
      field.ok ? field.value.toString() : `unreadable (${field.reason})`;
    deviations.push(`amount: option=${render(optionAmount)} accepted=${render(acceptedAmount)}`);
  }

  return deviations;
}

/**
 * Recognise a *real* ERC-6492 wrapper, not just its trailing magic bytes.
 *
 * A plain 65-byte signature can be crafted so its last 32 bytes equal the magic
 * suffix. Checking the suffix alone then turns three signature assertions into
 * `skip`, yielding zero failures and exit code 0 for a signature nobody verified
 * — a fail-open. Decoding the wrapper and requiring a non-zero factory and
 * non-empty calldata closes it: garbage falls through to `parseSignature65`,
 * which rejects it.
 */
function isUsableErc6492(signature: string): boolean {
  if (!isHex(signature) || (signature.length - 2) / 2 < 32 || !isErc6492Signature(signature)) return false;
  try {
    const parsed = parseErc6492Signature(signature as Hex);
    return (
      parsed.address !== undefined &&
      !isAddressEqual(parsed.address, zeroAddress) &&
      parsed.data !== "0x" &&
      parsed.signature !== "0x"
    );
  } catch {
    return false;
  }
}

export async function checkAuthorization(input: AuthorizationInput): Promise<CheckResult[]> {
  // The CLI validates these, but this is also a published library entry point:
  // fail loudly at the boundary rather than halfway through an assertion.
  if (!Number.isFinite(input.now) || input.now <= 0) {
    throw new TypeError("checkAuthorization needs a positive `now` in unix seconds");
  }
  if (!Object.hasOwn(KITE_NETWORKS, input.expectedNetwork)) {
    throw new TypeError(`checkAuthorization: unknown expectedNetwork "${String(input.expectedNetwork)}"`);
  }
  if (
    input.minValiditySeconds !== undefined &&
    (!Number.isFinite(input.minValiditySeconds) || input.minValiditySeconds < 0)
  ) {
    throw new TypeError("checkAuthorization: minValiditySeconds must be a non-negative finite number");
  }
  if (
    input.maxWindowSeconds !== undefined &&
    (!Number.isFinite(input.maxWindowSeconds) || input.maxWindowSeconds <= 0)
  ) {
    throw new TypeError("checkAuthorization: maxWindowSeconds must be a positive finite number");
  }
  const minValidity = Math.max(0, Math.trunc(input.minValiditySeconds ?? REFERENCE_MIN_VALIDITY_SECONDS));
  const results: CheckResult[] = [];

  // ---------------------------------------------------------------- challenge
  if (input.challengeHeader === undefined) {
    results.push(
      fail(
        ID.challenge,
        titleOf(ID.challenge),
        "no challenge supplied: the response carried no PAYMENT-REQUIRED header and no --challenge file was given",
      ),
    );
    skipRemaining(results, ID.challenge, "no challenge to evaluate the payment against");
    return results;
  }

  const decodedChallenge = decodeHeaderValue(input.challengeHeader);
  if (!decodedChallenge.ok) {
    results.push(fail(ID.challenge, titleOf(ID.challenge), decodedChallenge.error));
    skipRemaining(results, ID.challenge, "no challenge to evaluate the payment against");
    return results;
  }

  const challengeEnvelope = asRecord(decodedChallenge.value);
  const options = challengeEnvelope === undefined ? [] : pickPaymentOptions(challengeEnvelope);
  if (options.length === 0) {
    results.push(
      fail(
        ID.challenge,
        titleOf(ID.challenge),
        "the challenge decoded but carries no payment option (`accepts`), so there is nothing a client could pay",
      ),
    );
    skipRemaining(results, ID.challenge, "no payment option to evaluate the payment against");
    return results;
  }
  results.push(pass(ID.challenge, titleOf(ID.challenge), "decoded, with at least one payment option"));

  // ------------------------------------------------------------------ payment
  if (input.paymentHeader === undefined) {
    results.push(fail(ID.payment, titleOf(ID.payment), "no PAYMENT-SIGNATURE value supplied"));
    skipRemaining(results, ID.payment, "nothing to verify without a payment payload");
    return results;
  }

  const decodedPayment = decodeHeaderValue(input.paymentHeader);
  if (!decodedPayment.ok) {
    results.push(fail(ID.payment, titleOf(ID.payment), decodedPayment.error));
    skipRemaining(results, ID.payment, "nothing to verify without a decodable payment payload");
    return results;
  }

  const paymentEnvelope = asRecord(decodedPayment.value);
  if (paymentEnvelope === undefined) {
    results.push(
      fail(ID.payment, titleOf(ID.payment), "PAYMENT-SIGNATURE decoded to something that is not a JSON object"),
    );
    skipRemaining(results, ID.payment, "nothing to verify without a decodable payment payload");
    return results;
  }
  results.push(pass(ID.payment, titleOf(ID.payment), "decoded to a JSON object"));

  // Pick the advertised option the client actually echoed. Falling back to the
  // first option keeps every downstream check meaningful when `accepted` is
  // missing — that case is reported by c3.accepted-binding.
  const accepted = pickRecord(paymentEnvelope, ["accepted", "requirements"]);
  const matchingOption =
    accepted === undefined
      ? undefined
      : options.find((candidate) => acceptanceDeviations(candidate, accepted, input.expectedNetwork).length === 0);
  const option = matchingOption ?? (options[0] as Record<string, unknown>);
  const selectedIsEcho = matchingOption !== undefined;

  const challengeScheme = pickString(option, ["scheme"]);
  const challengeNetworkRaw = pickRaw(option, ["network", "chainId", "chain"]);
  const challengeAsset = pickString(option, ASSET_KEYS);
  const challengePayTo = pickString(option, PAY_TO_KEYS);
  const challengeAmount = readUint(option, AMOUNT_KEYS, "challenge amount", "challenge amount");

  // ------------------------------------------------------------ payload version
  const payloadVersion = paymentEnvelope["x402Version"];
  if (payloadVersion !== 2) {
    results.push(
      fail(
        ID.payloadVersion,
        titleOf(ID.payloadVersion),
        `expected x402Version=2, got ${JSON.stringify(payloadVersion ?? null)}. v1 payloads carry scheme/network at the top level and are out of scope for C3 (see docs/LIMITATIONS.md)`,
        "critical",
        { x402Version: payloadVersion ?? null },
      ),
    );
    skipRemaining(results, ID.payloadVersion, "payload is not v2; its structure differs");
    return results;
  }
  results.push(pass(ID.payloadVersion, titleOf(ID.payloadVersion), "x402Version=2"));

  // -------------------------------------------------------------- payload shape
  const payload = pickRecord(paymentEnvelope, ["payload"]);
  const authorizationRecord = payload === undefined ? undefined : pickRecord(payload, ["authorization", "auth"]);
  const signatureRaw = payload === undefined ? undefined : pickString(payload, ["signature", "sig"]);

  const missingParts: string[] = [];
  if (payload === undefined) missingParts.push("payload");
  if (authorizationRecord === undefined) missingParts.push("payload.authorization");
  if (signatureRaw === undefined) missingParts.push("payload.signature");

  if (missingParts.length > 0) {
    results.push(
      fail(
        ID.payloadShape,
        titleOf(ID.payloadShape),
        `missing ${missingParts.join(", ")}. A v2 exact payload is ` +
          "{ x402Version, accepted, payload: { authorization, signature } }",
        "critical",
        { missing: missingParts },
      ),
    );
    skipRemaining(results, ID.payloadShape, "payload is malformed; later checks would restate the same defect");
    return results;
  }

  const parsedAuthorization = parseAuthorization(authorizationRecord as Record<string, unknown>);
  if (!parsedAuthorization.ok) {
    const [first, ...rest] = parsedAuthorization.problems;
    results.push(
      fail(
        ID.payloadShape,
        titleOf(ID.payloadShape),
        rest.length === 0 ? (first ?? "authorisation is malformed") : `${first ?? ""} (+${rest.length} more)`,
        "critical",
        { problems: parsedAuthorization.problems },
      ),
    );
    skipRemaining(results, ID.payloadShape, "authorisation is malformed; later checks would restate the same defect");
    return results;
  }

  const authorization = parsedAuthorization.value;
  const signature = signatureRaw as string;
  results.push(pass(ID.payloadShape, titleOf(ID.payloadShape), "all six EIP-3009 fields present and well-typed", "critical", {
    from: authorization.from,
    to: authorization.to,
    value: authorization.value.toString(),
    validAfter: authorization.validAfter.toString(),
    validBefore: authorization.validBefore.toString(),
    nonce: authorization.nonce,
  }));

  // ---------------------------------------------------------- accepted binding
  if (accepted === undefined) {
    results.push(
      fail(
        ID.acceptedBinding,
        titleOf(ID.acceptedBinding),
        "payload.accepted is missing. The v2 payload schema requires an echo of the accepted requirements, " +
          "and the reference facilitator dereferences `payload.accepted.network`, so this payload is rejected as invalid_payload",
        "critical",
        { advertisedOptions: options.length },
      ),
    );
  } else if (selectedIsEcho) {
    results.push(
      pass(
        ID.acceptedBinding,
        titleOf(ID.acceptedBinding),
        `scheme, network, asset, payTo and amount match one of ${options.length} advertised option(s)`,
        "critical",
        { advertisedOptions: options.length, selectedOption: options.indexOf(option) },
      ),
    );
  } else {
    const deviations = acceptanceDeviations(option, accepted, input.expectedNetwork);
    results.push(
      fail(
        ID.acceptedBinding,
        titleOf(ID.acceptedBinding),
        `no advertised option matches payload.accepted (the client paid a stale or foreign quote). ` +
          `Compared with the first option — ${deviations.join("; ")}`,
        "critical",
        { advertisedOptions: options.length, deviations },
      ),
    );
  }

  // ------------------------------------------------------------- payTo / value
  const expectedPayTo = accepted !== undefined ? pickString(accepted, PAY_TO_KEYS) : challengePayTo;
  if (expectedPayTo === undefined) {
    results.push(
      fail(ID.bindingPayTo, titleOf(ID.bindingPayTo), "the quote carries no payTo, so the payee cannot be compared"),
    );
  } else if (!sameAddress(authorization.to, expectedPayTo)) {
    results.push(
      fail(
        ID.bindingPayTo,
        titleOf(ID.bindingPayTo),
        `authorisation pays ${authorization.to} but the quote asks for ${expectedPayTo} ` +
          "(reference facilitator: invalid_exact_evm_recipient_mismatch)",
        "critical",
        { authorized: authorization.to, quoted: expectedPayTo },
      ),
    );
  } else {
    results.push(pass(ID.bindingPayTo, titleOf(ID.bindingPayTo), `pays ${expectedPayTo}`));
  }

  const expectedAmount =
    accepted !== undefined
      ? readUint(accepted, AMOUNT_KEYS, "accepted amount", "accepted amount")
      : challengeAmount;
  if (!expectedAmount.ok) {
    results.push(
      fail(ID.bindingValue, titleOf(ID.bindingValue), `the quote amount is unreadable: ${expectedAmount.reason}`),
    );
  } else if (authorization.value !== expectedAmount.value) {
    results.push(
      fail(
        ID.bindingValue,
        titleOf(ID.bindingValue),
        `authorisation authorises ${authorization.value} atomic units but the quote asks for ${expectedAmount.value} ` +
          "(reference facilitator: invalid_exact_evm_authorization_value)",
        "critical",
        { authorized: authorization.value.toString(), quoted: expectedAmount.value.toString() },
      ),
    );
  } else {
    results.push(pass(ID.bindingValue, titleOf(ID.bindingValue), `${expectedAmount.value} atomic units`));
  }

  // ------------------------------------------------------------ address sanity
  const zeroProblems: string[] = [];
  if (isAddressEqual(authorization.from, zeroAddress)) zeroProblems.push("from is the zero address");
  if (isAddressEqual(authorization.to, zeroAddress)) zeroProblems.push("to is the zero address");

  if (zeroProblems.length > 0) {
    results.push(
      fail(ID.addressSanity, titleOf(ID.addressSanity), zeroProblems.join("; "), "critical", {
        zeroProblems,
      }),
    );
  } else if (isAddressEqual(authorization.from, authorization.to)) {
    // Self-payment is odd but valid: the facilitator accepts it, and the chain
    // will happily execute it. Calling it critical would be our own invented
    // rule, which this checker explicitly avoids.
    results.push(
      fail(
        ID.addressSanity,
        titleOf(ID.addressSanity),
        `payer and payee are the same account (${authorization.from}); no value moves. The facilitator does not reject ` +
          "this, so this is advice rather than a settlement verdict",
        "warning",
        { selfPayment: true },
      ),
    );
  } else {
    results.push(
      pass(ID.addressSanity, titleOf(ID.addressSanity), `payer ${authorization.from} → payee ${authorization.to}`, "warning"),
    );
  }

  // -------------------------------------------------------------- domain config
  const extra = pickRecord(option, ["extra", "eip712", "domain"]);
  const domainName = extra === undefined ? undefined : pickString(extra, ["name"]);
  const domainVersion = extra === undefined ? undefined : pickString(extra, ["version"]);
  const chainId = chainIdFromNetworkField(challengeNetworkRaw);
  const verifyingContract = challengeAsset !== undefined && isAddress(challengeAsset) ? getAddress(challengeAsset) : undefined;

  const expectedNetworkMatch = matchNetwork(challengeNetworkRaw, input.expectedNetwork);
  const domainGaps: string[] = [];
  if (domainName === undefined) domainGaps.push("extra.name");
  if (domainVersion === undefined) domainGaps.push("extra.version");
  if (chainId === undefined) domainGaps.push("network→chainId");
  if (verifyingContract === undefined) domainGaps.push("asset");
  if (!expectedNetworkMatch.ok) {
    domainGaps.push(`network is ${String(expectedNetworkMatch.normalised)}, expected ${KITE_NETWORKS[input.expectedNetwork].caip2}`);
  }

  let domain: Eip712Domain | undefined;
  if (domainGaps.length > 0) {
    results.push(
      fail(
        ID.domainConfig,
        titleOf(ID.domainConfig),
        `the challenge does not describe a usable EIP-712 domain: ${domainGaps.join(", ")} missing. ` +
          "Without it the client cannot build a signature at all (reference facilitator: invalid_exact_evm_missing_eip712_domain)",
        "critical",
        { missing: domainGaps },
      ),
    );
  } else {
    domain = {
      name: domainName as string,
      version: domainVersion as string,
      chainId: chainId as number,
      verifyingContract: verifyingContract as Hex,
    };
    results.push(
      pass(ID.domainConfig, titleOf(ID.domainConfig), `name="${domain.name}" version="${domain.version}" chainId=${domain.chainId}`, "critical", {
        domainSeparator: eip712DomainSeparator(domain),
        verifyingContract: domain.verifyingContract,
      }),
    );
  }

  // -------------------------------------------------------------------- window
  const now = Math.trunc(input.now);
  const nowBig = BigInt(now);
  const minValidBefore = nowBig + BigInt(minValidity);

  if (authorization.validAfter >= authorization.validBefore) {
    results.push(
      fail(
        ID.window,
        titleOf(ID.window),
        `validAfter (${authorization.validAfter}) is not before validBefore (${authorization.validBefore}); the window is empty and no verifier can accept it`,
      ),
    );
  } else if (authorization.validAfter > nowBig) {
    results.push(
      fail(
        ID.window,
        titleOf(ID.window),
        `not valid yet: validAfter=${authorization.validAfter} is ${authorization.validAfter - nowBig}s in the future ` +
          "(reference facilitator: invalid_exact_evm_payload_authorization_valid_after)",
        "critical",
        { validAfter: authorization.validAfter.toString(), now },
      ),
    );
  } else if (authorization.validBefore < minValidBefore) {
    results.push(
      fail(
        ID.window,
        titleOf(ID.window),
        `expires too soon: validBefore=${authorization.validBefore}, needs at least now+${minValidity}=${minValidBefore} ` +
          `(${authorization.validBefore - nowBig}s left). The reference facilitator rejects this with ` +
          "invalid_exact_evm_payload_authorization_valid_before",
        "critical",
        { validBefore: authorization.validBefore.toString(), now, minValiditySeconds: minValidity },
      ),
    );
  } else {
    results.push(
      pass(
        ID.window,
        titleOf(ID.window),
        `valid from ${authorization.validAfter}, expires in ${authorization.validBefore - nowBig}s`,
        "critical",
        { now, validAfter: authorization.validAfter.toString(), validBefore: authorization.validBefore.toString() },
      ),
    );
  }

  // ------------------------------------------------------------- replay window
  /**
   * Measured from `now`, not from `validAfter`.
   *
   * The reference client always emits `validAfter: "0"`, so
   * `validBefore - validAfter` is about 1.7e9 seconds for every real payment and
   * carries no information. What matters is how long the signature stays
   * replayable from the moment it is presented.
   */
  const remaining = authorization.validBefore > nowBig ? authorization.validBefore - nowBig : 0n;
  const advertisedTimeout = (() => {
    if (unsafeIntegerFields(option, ["maxTimeoutSeconds", "max_timeout_seconds"]).length > 0) return undefined;
    const raw = pickString(option, ["maxTimeoutSeconds", "max_timeout_seconds"]);
    if (raw === undefined || !/^\d+$/.test(raw)) return undefined;
    const parsed = Number.parseInt(raw, 10);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
  })();
  const windowCap = input.maxWindowSeconds ?? advertisedTimeout ?? DEFAULT_MAX_WINDOW_SECONDS;
  const spanOk = remaining <= BigInt(windowCap);
  results.push(
    spanOk
      ? pass(
          ID.windowSpan,
          titleOf(ID.windowSpan),
          `${remaining}s of replay window remain, within the ${windowCap}s cap`,
          "warning",
          { remainingSeconds: remaining.toString(), capSeconds: windowCap },
        )
      : fail(
          ID.windowSpan,
          titleOf(ID.windowSpan),
          `${remaining}s of replay window remain, exceeding the ${windowCap}s cap` +
            (input.maxWindowSeconds === undefined && advertisedTimeout !== undefined
              ? " advertised as maxTimeoutSeconds"
              : "") +
            "; a signature that stays valid this long stays replayable this long",
          "warning",
          { remainingSeconds: remaining.toString(), capSeconds: windowCap },
        ),
  );

  // ----------------------------------------------------------------- signature
  const signatureHex = isHex(signature);
  if (isUsableErc6492(signature)) {
    const reason =
      "ERC-6492 wrapped signature (smart-contract wallet). Recovering the inner signature needs the account " +
      "implementation, which C3 does not model — not verified rather than assumed correct";
    results.push(skip(ID.signatureFormat, titleOf(ID.signatureFormat), reason, "critical"));
    results.push(skip(ID.signatureLowS, titleOf(ID.signatureLowS), reason, "critical"));
    results.push(skip(ID.signatureRecovery, titleOf(ID.signatureRecovery), reason, "critical"));
    return results;
  }

  const parsedSignature = parseSignature65(signature);
  if (!parsedSignature.ok) {
    results.push(
      fail(ID.signatureFormat, titleOf(ID.signatureFormat), parsedSignature.error, "critical", {
        signatureBytes: signatureHex ? (signature.length - 2) / 2 : null,
      }),
    );
    skipRemaining(results, ID.signatureFormat, "signature cannot be parsed, so s and recovery are not evaluated");
    return results;
  }

  const parsed = parsedSignature.value;
  results.push(
    parsed.hasCanonicalV
      ? pass(ID.signatureFormat, titleOf(ID.signatureFormat), `65 bytes, v=${parsed.trailingByte}`)
      : fail(
          ID.signatureFormat,
          titleOf(ID.signatureFormat),
          `signature ends in v=${parsed.trailingByte}. On-chain ecrecover only accepts 27 or 28 and returns the zero ` +
            "address for 0/1, after which transferWithAuthorization reverts while the payer believes they paid",
          "critical",
          { trailingByte: parsed.trailingByte },
        ),
  );

  results.push(
    parsed.hasLowS
      ? pass(ID.signatureLowS, titleOf(ID.signatureLowS), "s is in the lower half order")
      : fail(
          ID.signatureLowS,
          titleOf(ID.signatureLowS),
          "s is in the upper half of the secp256k1 order; the reference facilitator rejects this as " +
            "invalid_exact_evm_non_canonical_signature for externally-owned payers",
          "critical",
          {
            caveat:
              "the facilitator exempts a deployed contract payer (ERC-1271); distinguishing that needs an RPC call, which C3 does not make",
          },
        ),
  );

  if (domain === undefined) {
    results.push(skip(ID.signatureRecovery, titleOf(ID.signatureRecovery), "the EIP-712 domain could not be derived"));
    return results;
  }

  const domainSeparator = eip712DomainSeparator(domain);
  const structHash = transferWithAuthorizationStructHash(authorization);
  const digest = eip3009Digest(domain, authorization);
  const recovered = await tryRecover(digest, signature);

  if (recovered === undefined) {
    results.push(
      fail(
        ID.signatureRecovery,
        titleOf(ID.signatureRecovery),
        "the signature cannot be turned into a public key (malformed r/s/v for this digest)",
        "critical",
        { digest },
      ),
    );
  } else if (isAddressEqual(recovered, authorization.from)) {
    results.push(
      pass(
        ID.signatureRecovery,
        titleOf(ID.signatureRecovery),
        `recovers to ${recovered}, matching authorization.from`,
        "critical",
        { recovered, expected: authorization.from, digest, domainSeparator, structHash },
      ),
    );
  } else {
    const alternatives = await diagnoseDomainMismatch(domain, authorization, signature, authorization.from);
    const detail =
      alternatives.length > 0
        ? `signature recovers to ${recovered}, not to ${authorization.from}. It does recover under ` +
          `${alternatives.join(" / ")} — the payload was signed against a different EIP-712 domain than the challenge advertises`
        : `signature recovers to ${recovered}, not to ${authorization.from}. No version/chainId variant recovers to the ` +
          "authorising payer, so the signed content, the token name or the signing key differs from what was advertised";
    results.push(
      fail(ID.signatureRecovery, titleOf(ID.signatureRecovery), detail, "critical", {
        recovered,
        expected: authorization.from,
        digest,
        domainSeparator,
        matchesUnder: alternatives,
      }),
    );
  }

  return results;
}
