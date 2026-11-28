/**
 * Shared payload readers.
 *
 * x402 payloads in the wild disagree about field names: the same value may be
 * called `amount` or `maxAmountRequired`, `payTo` or `recipient`. Every read goes
 * through an alias list, and the rule is uniform — tolerant about naming, strict
 * about presence. When no alias is present the caller must fail or skip; it must
 * never substitute a default, because a default turns "not sent" into "sent
 * correctly".
 */

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/**
 * Read the first non-empty value among `keys` as a string.
 *
 * Numbers are stringified because some builds emit `chainId: 2368` and
 * `amount: 1000` as JSON numbers. Booleans, objects and arrays are ignored: a
 * field whose value is `true` is malformed, not a string.
 */
export function pickString(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
    // A number above 2^53 was already rounded by JSON.parse. Stringifying it
    // turns a wrong value into a plausible decimal string, so refuse it here;
    // callers that want a good diagnostic can use `unsafeIntegerFields`.
    if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  }
  return undefined;
}

/**
 * Canonical alias order for an atomic amount in an x402 v2 payment option.
 *
 * C2 (challenge structure), C3 (authorisation binding) and the C1 manifest
 * probe must read the amount in the same order; otherwise the same quote can
 * validate as "1" in one check and "1000000" in another. A single exported
 * constant keeps the three in lockstep. `maxAmountRequired` is first because
 * it is the v2 canonical field name.
 */
export const AMOUNT_ALIASES = [
  "maxAmountRequired",
  "amount",
  "maxAmount",
  "price",
] as const;

/**
 * Result of reading a field that has several accepted aliases.
 *
 * `value` is the first usable alias, matching `pickString`. `conflicting`
 * lists aliases that carried a different usable value. Callers that use an
 * alias list for a value with safety consequences (an amount) must reject the
 * read when `conflicting` is non-empty: silently taking the first alias lets
 * one check authorise "1" while another checks "1000000" on the same quote.
 */
export interface AliasRead {
  readonly value: string | undefined;
  readonly conflicting: readonly string[];
}

/**
 * Read aliases as strings while detecting disagreeing duplicates.
 *
 * Numeric safety follows `pickString`: a safe integer is stringified, an
 * unsafe number is reported through `unsafeIntegerFields` by the caller. Two
 * aliases are "conflicting" only when both produced usable, normalised
 * strings that differ. Empty / whitespace-only strings are ignored, so an
 * unused alias does not manufacture a conflict.
 */
export function pickStringWithConflict(
  record: Record<string, unknown>,
  keys: readonly string[],
): AliasRead {
  let value: string | undefined;
  const conflicting: string[] = [];
  for (const key of keys) {
    const raw = record[key];
    let candidate: string | undefined;
    if (typeof raw === "string" && raw.trim().length > 0) candidate = raw.trim();
    else if (typeof raw === "number" && Number.isSafeInteger(raw)) candidate = String(raw);
    if (candidate === undefined) continue;
    if (value === undefined) value = candidate;
    else if (value !== candidate) conflicting.push(key);
  }
  return { value, conflicting };
}

/**
 * Names of fields that arrived as JSON numbers too large to represent exactly.
 *
 * `JSON.parse("9007199254740993")` yields `9007199254740992`. Reporting that as
 * the quoted amount would be a false statement about what the server sent, so
 * callers must reject the field instead of stringifying the rounded value.
 */
export function unsafeIntegerFields(
  record: Record<string, unknown>,
  keys: readonly string[],
): readonly string[] {
  return keys.filter((key) => typeof record[key] === "number" && !Number.isSafeInteger(record[key]));
}

/**
 * Read the first usable raw value among `keys`, preserving its JSON type.
 *
 * Used for fields that may be either a number or a string (`network`,
 * `chainId`). Unlike `??`, this skips empty strings: `network: ""` must not
 * shadow a valid `chainId` that appears later in the alias list.
 */
export function pickRaw(record: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    const value = record[key];
    if (value === undefined || value === null) continue;
    if (typeof value === "string" && value.trim().length === 0) continue;
    return value;
  }
  return undefined;
}

export function pickRecord(
  record: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> | undefined {
  for (const key of keys) {
    const value = asRecord(record[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * All usable payment options in a decoded `PAYMENT-REQUIRED` document.
 *
 * v2 wraps options in `accepts: [...]`; some builds send a bare object. C2 checks
 * the first option because its contract is "does the advertised quote look
 * right". C3 needs all of them: a client is free to pick option 2, and declaring
 * that choice invalid would be a false failure.
 */
export function pickPaymentOptions(decoded: Record<string, unknown>): Record<string, unknown>[] {
  const accepts = decoded["accepts"];
  const entries = Array.isArray(accepts) ? accepts : [accepts];
  return entries.flatMap((entry) => {
    const option = asRecord(entry);
    return option === undefined ? [] : [option];
  });
}

/** The first usable option; `undefined` when the document advertises none. */
export function pickPaymentOption(
  decoded: Record<string, unknown>,
): Record<string, unknown> | undefined {
  return pickPaymentOptions(decoded)[0];
}
