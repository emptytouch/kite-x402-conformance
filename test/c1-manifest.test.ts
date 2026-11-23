import { describe, expect, it } from "vitest";

import {
  checkManifestConsistency,
  type ManifestConsistencyInput,
  type ManifestEntry,
  type ObservedEntry,
} from "../src/checks/c1-manifest.js";
import type { CheckResult } from "../src/checks/types.js";

const PAY_TO = "0xab12345678901234567890123456789012345678";
const PAY_TO_MIXED = "0xAB12345678901234567890123456789012345678";
const ASSET = "0xcd23456789012345678901234567890123456789";
const OTHER_ADDRESS = "0xef34567890123456789012345678901234567890";

const manifestEntry = (overrides: Partial<ManifestEntry> = {}): ManifestEntry => ({
  path: "/v1/echo",
  network: "eip155:2368",
  payTo: PAY_TO,
  asset: ASSET,
  amount: "1000",
  ...overrides,
});

const observedEntry = (overrides: Partial<ObservedEntry> = {}): ObservedEntry => ({
  path: "/v1/echo",
  responseStatus: 402,
  hasPaymentRequired: true,
  network: "eip155:2368",
  payTo: PAY_TO,
  asset: ASSET,
  amount: "1000",
  ...overrides,
});

const goodInput = (overrides: Partial<ManifestConsistencyInput> = {}): ManifestConsistencyInput => ({
  source: "static-file",
  manifest: [manifestEntry()],
  observed: [observedEntry()],
  ...overrides,
});

function verdict(input: ManifestConsistencyInput): Map<string, CheckResult> {
  const results = checkManifestConsistency(input);
  expect(results).toHaveLength(12);
  return new Map(results.map((result) => [result.id, result]));
}

function expectAllPass(input: ManifestConsistencyInput): void {
  for (const result of verdict(input).values()) {
    expect(result.status, result.id).toBe("pass");
  }
}

function expectSkippedAfter(
  input: ManifestConsistencyInput,
  afterId: string,
): void {
  const results = [...verdict(input).values()];
  const index = results.findIndex((result) => result.id === afterId);
  expect(index).toBeGreaterThanOrEqual(0);
  for (const result of results.slice(index + 1)) {
    expect(result.status, result.id).toBe("skip");
  }
}

describe("C1 manifest consistency", () => {
  it("returns 12 passes for a consistent static manifest", () => {
    expectAllPass(goodInput());
  });

  it("accepts a well-known manifest source too", () => {
    expectAllPass(goodInput({ source: "well-known" }));
  });

  it("rejects a challenge-echo manifest and skips every dependent assertion", () => {
    const results = verdict(goodInput({ source: "challenge-echo" }));
    expect(results.get("c1.source-independent")!.status).toBe("fail");
    expectSkippedAfter(goodInput({ source: "challenge-echo" }), "c1.source-independent");
  });

  it("does not report pass for an unknown manifest source", () => {
    const input = goodInput({ source: "unknown" });
    const results = verdict(input);
    expect(results.get("c1.source-independent")!.status).toBe("skip");
    // c1.input may pass; every assertion after the source gate must not.
    for (const [id, result] of results) {
      if (id !== "c1.input") expect(result.status, id).not.toBe("pass");
    }
    expectSkippedAfter(input, "c1.source-independent");
  });

  it("fails closed when the input is not an object", () => {
    const input = null as unknown as ManifestConsistencyInput;
    const results = verdict(input);
    expect(results.get("c1.input")!.status).toBe("fail");
    expectSkippedAfter(input, "c1.input");
  });

  it("fails closed when source is inherited rather than an own property", () => {
    const input = Object.assign(Object.create({ source: "static-file" }), {
      manifest: [manifestEntry()],
      observed: [observedEntry()],
    }) as ManifestConsistencyInput;
    expect(verdict(input).get("c1.input")!.status).toBe("fail");
  });

  it("rejects an unknown source string instead of treating it as independent", () => {
    const input = goodInput({ source: "magic" as ManifestConsistencyInput["source"] });
    expect(verdict(input).get("c1.input")!.status).toBe("fail");
  });

  it("rejects entry fields supplied by a polluted prototype", () => {
    const inherited = Object.create({ payTo: PAY_TO }) as ManifestEntry;
    Object.assign(inherited, {
      path: "/v1/echo",
      network: "eip155:2368",
      asset: ASSET,
      amount: "1000",
    });
    const input = goodInput({ manifest: [inherited] });
    expect(verdict(input).get("c1.input")!.status).toBe("fail");
  });

  it("rejects malformed addresses rather than comparing them loosely", () => {
    for (const payTo of ["0x1234", "0XAB12345678901234567890123456789012345678", ""]) {
      const input = goodInput({ manifest: [manifestEntry({ payTo })] });
      expect(verdict(input).get("c1.input")!.status).toBe("fail");
    }
  });

  it("rejects non-canonical amounts including leading zeros and JSON numbers", () => {
    for (const amount of ["00100", "100.0", "", " 100", 100]) {
      const input = goodInput({
        manifest: [manifestEntry({ amount: amount as string })],
      });
      expect(verdict(input).get("c1.input")!.status).toBe("fail");
    }
  });

  it("keeps a large amount string exact", () => {
    const amount = "9007199254740993";
    expectAllPass(
      goodInput({
        manifest: [manifestEntry({ amount })],
        observed: [observedEntry({ amount })],
      }),
    );
  });

  it("rejects unparseable networks and malformed paths", () => {
    expect(
      verdict(goodInput({ manifest: [manifestEntry({ network: "eip155:abc" })] })).get(
        "c1.input",
      )!.status,
    ).toBe("fail");
    expect(
      verdict(goodInput({ observed: [observedEntry({ path: "v1/echo" })] })).get(
        "c1.input",
      )!.status,
    ).toBe("fail");
  });

  it("fails the challenge-shape assertion for non-402 responses", () => {
    for (const responseStatus of [200, 404, 503]) {
      const input = goodInput({ observed: [observedEntry({ responseStatus })] });
      expect(verdict(input).get("c1.input")!.status).toBe("pass");
      expect(verdict(input).get("c1.challenge-shape")!.status).toBe("fail");
    }
  });

  it("rejects out-of-range and fractional response statuses as malformed input", () => {
    for (const responseStatus of [0, 600, 402.5]) {
      const input = goodInput({ observed: [observedEntry({ responseStatus })] });
      expect(verdict(input).get("c1.input")!.status).toBe("fail");
    }
  });

  it("fails an empty manifest and skips every dependent assertion", () => {
    const input = goodInput({ manifest: [] });
    expect(verdict(input).get("c1.manifest-present")!.status).toBe("fail");
    expectSkippedAfter(input, "c1.manifest-present");
  });

  it("fails an empty observation set and skips every dependent assertion", () => {
    const input = goodInput({ observed: [] });
    expect(verdict(input).get("c1.observed-present")!.status).toBe("fail");
    expectSkippedAfter(input, "c1.observed-present");
  });

  it("fails when a probed endpoint is not a 402 challenge", () => {
    const missingHeader = goodInput({
      observed: [observedEntry({ hasPaymentRequired: false })],
    });
    expect(verdict(missingHeader).get("c1.challenge-shape")!.status).toBe("fail");
    const wrongStatus = goodInput({
      observed: [observedEntry({ responseStatus: 200 })],
    });
    expect(verdict(wrongStatus).get("c1.challenge-shape")!.status).toBe("fail");
  });

  it("detects an observed endpoint missing from the manifest", () => {
    const input = goodInput({
      manifest: [manifestEntry()],
      observed: [observedEntry(), observedEntry({ path: "/v1/new" })],
    });
    const result = verdict(input).get("c1.no-undeclared")!;
    expect(result.status).toBe("fail");
    expect(result.evidence).toMatchObject({ paths: ["/v1/new (chain 2368)"] });
  });

  it("detects a declared endpoint that was never observed as a 402", () => {
    const input = goodInput({
      manifest: [manifestEntry(), manifestEntry({ path: "/v1/gone" })],
      observed: [observedEntry()],
    });
    const result = verdict(input).get("c1.no-ghost")!;
    expect(result.status).toBe("fail");
    expect(result.evidence).toMatchObject({ paths: ["/v1/gone (chain 2368)"] });
  });

  it("detects each binding mismatch without affecting the other assertions", () => {
    const cases: Array<[string, Partial<ObservedEntry>]> = [
      ["c1.network-match", { network: "eip155:2366" }],
      ["c1.pay-to-match", { payTo: OTHER_ADDRESS }],
      ["c1.asset-match", { asset: OTHER_ADDRESS }],
      ["c1.amount-match", { amount: "2000" }],
    ];
    for (const [id, override] of cases) {
      const results = verdict(goodInput({ observed: [observedEntry(override)] }));
      expect(results.get(id)!.status, id).toBe("fail");
      for (const [otherId, result] of results) {
        if (otherId !== id && otherId !== "c1.no-ghost") {
          expect(result.status, `${id} should not break ${otherId}`).toBe("pass");
        }
      }
    }
  });

  it("compares addresses case-insensitively and networks across spellings", () => {
    for (const network of ["eip155:2368", "2368", 2368, "EIP155:2368"] as const) {
      expectAllPass(
        goodInput({
          manifest: [manifestEntry({ payTo: PAY_TO, network: "eip155:2368" })],
          observed: [observedEntry({ payTo: PAY_TO_MIXED, network })],
        }),
      );
    }
  });

  it("reports contradictory duplicate declarations as a warning without failing critical checks", () => {
    const input = goodInput({
      manifest: [manifestEntry(), manifestEntry({ amount: "2000" })],
      observed: [observedEntry()],
    });
    const results = verdict(input);
    expect(results.get("c1.no-conflict")!.status).toBe("fail");
    expect(results.get("c1.no-conflict")!.level).toBe("warning");
    for (const [id, result] of results) {
      if (id !== "c1.no-conflict") expect(result.status, id).toBe("pass");
    }
  });

  it("allows the same path on two different networks", () => {
    expectAllPass(
      goodInput({
        manifest: [manifestEntry(), manifestEntry({ network: "eip155:2366" })],
        observed: [observedEntry(), observedEntry({ network: "eip155:2366" })],
      }),
    );
  });

  it("does not compare fields across different paths", () => {
    const input = goodInput({
      manifest: [manifestEntry(), manifestEntry({ path: "/v1/other", amount: "5000" })],
      observed: [observedEntry(), observedEntry({ path: "/v1/other", amount: "5000" })],
    });
    expectAllPass(input);
  });

  it("survives a JSON round-trip of the observation set", () => {
    const input = goodInput({
      manifest: [manifestEntry(), manifestEntry({ path: "/v1/other" })],
      observed: [observedEntry(), observedEntry({ path: "/v1/other" })],
    });
    expectAllPass(JSON.parse(JSON.stringify(input)) as ManifestConsistencyInput);
  });

  it("snapshots accessor-backed fields so a changing getter cannot forge a pass", () => {
    let reads = 0;
    const declared = manifestEntry();
    Object.defineProperty(declared, "amount", {
      enumerable: true,
      // Valid at validation time, different at comparison time.
      get: () => (++reads === 1 ? "1000" : "2000"),
    });
    const actual = observedEntry({ amount: "2000" });
    Object.defineProperty(actual, "amount", {
      enumerable: true,
      get: () => "2000",
    });
    const input = goodInput({ manifest: [declared], observed: [actual] });
    const results = verdict(input);
    expect(results.get("c1.amount-match")!.status).toBe("fail");
  });

  it("turns a throwing entry accessor into a fail-closed verdict", () => {
    const declared = manifestEntry();
    Object.defineProperty(declared, "payTo", {
      enumerable: true,
      get: () => {
        throw new Error("boom-from-getter");
      },
    });
    const input = goodInput({ manifest: [declared] });
    expect(verdict(input).get("c1.input")!.status).toBe("fail");
    expectSkippedAfter(input, "c1.input");
  });

  it("turns a throwing source accessor into a fail-closed verdict", () => {
    const input = goodInput();
    Object.defineProperty(input, "source", {
      enumerable: true,
      get: () => {
        throw new Error("boom-source");
      },
    });
    expect(verdict(input).get("c1.input")!.status).toBe("fail");
    expectSkippedAfter(input, "c1.input");
  });

  it("does not let a hostile thrown value escape through error description", () => {
    const hostile: Record<string, unknown> = {};
    Object.defineProperty(hostile, Symbol.toPrimitive, {
      value: () => {
        throw new Error("hostile-toPrimitive");
      },
    });
    hostile["toString"] = () => {
      throw new Error("hostile-toString");
    };
    const declared = manifestEntry();
    Object.defineProperty(declared, "payTo", {
      enumerable: true,
      get: () => {
        throw hostile;
      },
    });
    const input = goodInput({ manifest: [declared] });
    const results = verdict(input);
    expect(results.get("c1.input")!.status).toBe("fail");
    expectSkippedAfter(input, "c1.input");
  });
});
