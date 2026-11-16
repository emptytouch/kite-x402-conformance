import { describe, expect, it } from "vitest";

import { decodeHeaderValue, encodeHeaderValue, findHeader } from "../src/wire.js";

const sample = { x402Version: 2, accepts: [{ scheme: "exact", network: "eip155:2368" }] };

describe("wire.encodeHeaderValue / decodeHeaderValue", () => {
  it("round-trips a JSON payload", () => {
    const decoded = decodeHeaderValue(encodeHeaderValue(sample));
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.value).toEqual(sample);
  });

  it("accepts raw JSON without base64", () => {
    const decoded = decodeHeaderValue(JSON.stringify(sample));
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.value).toEqual(sample);
  });

  it("accepts base64url input", () => {
    const base64url = encodeHeaderValue(sample).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const decoded = decodeHeaderValue(base64url);
    expect(decoded.ok).toBe(true);
  });

  it("accepts percent-encoded JSON", () => {
    const decoded = decodeHeaderValue(encodeURIComponent(JSON.stringify(sample)));
    expect(decoded.ok).toBe(true);
  });

  it("fails closed on garbage instead of returning an empty object", () => {
    const decoded = decodeHeaderValue("not-a-header-value!!");
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.error).toMatch(/neither raw JSON/);
  });

  it("fails closed on an empty value", () => {
    const decoded = decodeHeaderValue("   ");
    expect(decoded.ok).toBe(false);
  });
});

describe("wire.findHeader", () => {
  it("matches header names case-insensitively", () => {
    expect(findHeader({ "Payment-Required": "abc" }, "payment-required")).toBe("abc");
    expect(findHeader({ "PAYMENT-REQUIRED": "abc" }, "payment-required")).toBe("abc");
  });

  it("returns undefined when absent", () => {
    expect(findHeader({ "content-type": "application/json" }, "payment-required")).toBeUndefined();
  });
});
