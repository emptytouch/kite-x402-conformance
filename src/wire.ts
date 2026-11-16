/**
 * x402 wire helpers: the `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE` and
 * `PAYMENT-RESPONSE` headers carry a JSON document encoded as base64.
 *
 * Real services in the wild are inconsistent (base64, base64url, occasionally
 * URL-encoded JSON), so decoding is tolerant while still failing closed: a value
 * that cannot be read as JSON is an error, never an empty object.
 */

export type DecodeResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: string };

export function findHeader(
  headers: Record<string, string>,
  name: string,
): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

function tryParseJson(text: string): { ok: true; value: unknown } | undefined {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return undefined;
  }
}

export function decodeHeaderValue(raw: string): DecodeResult {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: "header value is empty" };
  }

  const candidates = new Set<string>([trimmed]);

  for (const encoding of ["base64", "base64url"] as const) {
    try {
      const decoded = Buffer.from(trimmed, encoding).toString("utf8");
      if (decoded.length > 0) candidates.add(decoded);
    } catch {
      // Not valid in this encoding; try the next one.
    }
  }

  try {
    const decoded = decodeURIComponent(trimmed);
    if (decoded !== trimmed) candidates.add(decoded);
  } catch {
    // Not percent-encoded.
  }

  for (const candidate of candidates) {
    const parsed = tryParseJson(candidate);
    if (parsed !== undefined) return parsed;
  }

  return { ok: false, error: "value is neither raw JSON nor base64/URL-encoded JSON" };
}

export function encodeHeaderValue(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}
