import { describe, expect, test } from "vitest";

import { encodeHeaderValue } from "../src/wire.js";
import {
  checkSettlementOrder,
  type ProbeName,
  type ProbeObservation,
} from "../src/checks/c4-settlement-order.js";
import type { CheckResult } from "../src/checks/types.js";

const TX = `0x${"ab".repeat(32)}`;

function receiptHeader(txHash: string | undefined = TX): string {
  return encodeHeaderValue(txHash === undefined ? {} : { x402Version: 2, receipt: { txHash, network: "eip155:2368" } });
}

/**
 * A conformant baseline. Each test perturbs one field so the failure it
 * asserts is the only difference from the passing case.
 */
function probes(): Record<ProbeName, ProbeObservation> {
  return {
    unsigned: {
      probe: "unsigned",
      responseStatus: 402,
      responseHeaders: {},
      upstreamCalled: false,
      upstreamStatus: undefined,
      settled: false,
      settlementStatus: undefined,
    },
    invalidSignature: {
      probe: "invalidSignature",
      responseStatus: 402,
      responseHeaders: {},
      upstreamCalled: false,
      upstreamStatus: undefined,
      settled: false,
      settlementStatus: undefined,
    },
    upstreamError: {
      probe: "upstreamError",
      responseStatus: 502,
      responseHeaders: {},
      upstreamCalled: true,
      upstreamStatus: 502,
      settled: false,
      settlementStatus: undefined,
    },
    upstreamSuccess: {
      probe: "upstreamSuccess",
      responseStatus: 200,
      responseHeaders: { "payment-response": receiptHeader() },
      upstreamCalled: true,
      upstreamStatus: 200,
      settled: true,
      settlementStatus: 200,
    },
  };
}

function run(overrides: Partial<Record<ProbeName, Partial<ProbeObservation>>> = {}): CheckResult[] {
  const base = probes();
  const list = Object.values(base).map((probe) => ({
    ...probe,
    ...(overrides[probe.probe] ?? {}),
  }));
  return checkSettlementOrder({ observations: list });
}

function byId(results: CheckResult[]): Map<string, CheckResult> {
  return new Map(results.map((result) => [result.id, result]));
}

function failures(results: CheckResult[]): string[] {
  return results.filter((result) => result.status === "fail").map((result) => result.id);
}

describe("C4 settlement order — positive case", () => {
  test("all four probes conform: 12 pass, zero fail or skip", () => {
    const results = run();
    expect(results).toHaveLength(12);
    expect(results.every((result) => result.status === "pass")).toBe(true);
    expect(failures(results)).toEqual([]);
  });
});

describe("C4 settlement order — negative cases", () => {
  test("unsigned request forwarded upstream is critical", () => {
    const results = run({ unsigned: { upstreamCalled: true, upstreamStatus: 200 } });
    const map = byId(results);
    expect(map.get("c4.unsigned.no-forward")?.status).toBe("fail");
    expect(map.get("c4.unsigned.no-forward")?.level).toBe("critical");
    // The other free-access assertions stay visible rather than being suppressed.
    expect(map.get("c4.unsigned.status")?.status).toBe("pass");
  });

  test("unsigned request settled is critical even when status is 402", () => {
    const results = run({ unsigned: { settled: true, settlementStatus: 200 } });
    expect(byId(results).get("c4.unsigned.no-settle")?.status).toBe("fail");
  });

  test("invalid signature served by upstream and settled surfaces both failures", () => {
    const results = run({
      invalidSignature: { upstreamCalled: true, upstreamStatus: 200, settled: true, settlementStatus: 200 },
    });
    const map = byId(results);
    expect(map.get("c4.invalid-signature.no-forward")?.status).toBe("fail");
    expect(map.get("c4.invalid-signature.no-settle")?.status).toBe("fail");
  });

  test("invalid signature returning 5xx fails the status assertion", () => {
    const results = run({ invalidSignature: { responseStatus: 500 } });
    expect(byId(results).get("c4.invalid-signature.status")?.status).toBe("fail");
  });

  test("upstream 4xx/5xx that settles is the core money-losing failure", () => {
    for (const status of [400, 404, 429, 500, 502, 503]) {
      const results = run({
        upstreamError: { upstreamStatus: status, responseStatus: status, settled: true, settlementStatus: 200 },
      });
      const result = byId(results).get("c4.upstream-error.no-settle");
      expect(result?.status, `status ${status}`).toBe("fail");
      expect(result?.evidence).toMatchObject({ upstreamStatus: status, settlementStatus: 200 });
    }
  });

  test("upstream-error probe returning 2xx cannot yield a vacuous no-settle pass", () => {
    // The "upstream failed" scenario was never set up. Reporting no-settle as
    // green here would be a fake success — the exact thing C4 must not do.
    for (const status of [200, 201, 302]) {
      const results = run({
        upstreamError: { upstreamStatus: status, responseStatus: status, settled: false },
      });
      const map = byId(results);
      expect(map.get("c4.upstream-error.forwarded")?.status, `status ${status}`).toBe("fail");
      expect(map.get("c4.upstream-error.no-settle")?.status, `status ${status}`).toBe("skip");
    }
  });

  test("contradictory settled/status observations are rejected, never trusted", () => {
    // A server must not be able to report "no settlement" while the facilitator
    // status shows a charge, or claim success with a failing status.
    const contradictions: Array<Partial<ProbeObservation>> = [
      { probe: "unsigned", settled: false, settlementStatus: 200 },
      { probe: "invalidSignature", settled: false, settlementStatus: 200 },
      { probe: "upstreamError", settled: false, settlementStatus: 200 },
      { probe: "upstreamSuccess", settled: true, settlementStatus: undefined },
      { probe: "upstreamSuccess", settled: true, settlementStatus: 500 },
      { probe: "unsigned", upstreamCalled: false, upstreamStatus: 200 },
    ];
    for (const patch of contradictions) {
      const probeName = patch.probe as ProbeName;
      const list = Object.values(probes()).map((probe) =>
        probe.probe === probeName ? { ...probe, ...patch } : probe,
      );
      const results = checkSettlementOrder({ observations: list });
      const map = byId(results);
      expect(map.get("c4.probes")?.status, JSON.stringify(patch)).toBe("fail");
      expect(results.some((result) => result.status === "pass"), JSON.stringify(patch)).toBe(false);
    }
  });

  test("non-string PAYMENT-RESPONSE header fails validation instead of crashing", () => {
    const list = Object.values(probes()).map((probe) =>
      probe.probe === "upstreamSuccess"
        ? { ...probe, responseHeaders: { "payment-response": 123 } }
        : probe,
    );
    // Must not throw: a malformed check input is a verdict, not a crash.
    const results = checkSettlementOrder({ observations: list as unknown as ProbeObservation[] });
    expect(byId(results).get("c4.probes")?.status).toBe("fail");
    expect(byId(results).get("c4.upstream-success.receipt")?.status).toBe("skip");
  });

  test("upstream 2xx without settlement is critical", () => {
    const results = run({ upstreamSuccess: { settled: false, settlementStatus: undefined } });
    expect(byId(results).get("c4.upstream-success.settled")?.status).toBe("fail");
  });

  test("settled success missing PAYMENT-RESPONSE is critical", () => {
    const results = run({ upstreamSuccess: { responseHeaders: {} } });
    expect(byId(results).get("c4.upstream-success.receipt")?.status).toBe("fail");
  });

  test("settled success returning non-200 is critical", () => {
    const results = run({ upstreamSuccess: { responseStatus: 201 } });
    const map = byId(results);
    expect(map.get("c4.upstream-success.settled")?.status).toBe("pass");
    expect(map.get("c4.upstream-success.receipt")?.status).toBe("fail");
  });
});

describe("C4 settlement order — receipt validation", () => {
  test("top-level txHash alias is accepted", () => {
    const header = encodeHeaderValue({ txHash: TX, x402Version: 2 });
    const results = run({ upstreamSuccess: { responseHeaders: { "PAYMENT-RESPONSE": header } } });
    expect(byId(results).get("c4.upstream-success.receipt")?.status).toBe("pass");
  });

  test("each documented alias works", () => {
    for (const key of ["txHash", "transactionHash", "tx", "hash"]) {
      const header = encodeHeaderValue({ receipt: { [key]: TX } });
      const results = run({ upstreamSuccess: { responseHeaders: { "Payment-Response": header } } });
      expect(byId(results).get("c4.upstream-success.receipt")?.status, key).toBe("pass");
    }
  });

  test("empty alias and non-object wrapper do not hide a valid hash", () => {
    for (const doc of [
      { txHash: "", transactionHash: TX },
      { receipt: "", settlement: { txHash: TX } },
      { receipt: 0, settlement: { txHash: TX } },
      { receipt: [], settlement: { txHash: TX } },
    ]) {
      const header = encodeHeaderValue(doc);
      const results = run({ upstreamSuccess: { responseHeaders: { "payment-response": header } } });
      expect(byId(results).get("c4.upstream-success.receipt")?.status, JSON.stringify(doc)).toBe("pass");
    }
  });

  test("a genuinely malformed hash still fails even when a valid alias follows", () => {
    // Empty strings are skipped; a non-empty but malformed hash is a real
    // finding and must not be papered over by another alias.
    const header = encodeHeaderValue({ txHash: "0x1234", transactionHash: TX });
    const results = run({ upstreamSuccess: { responseHeaders: { "payment-response": header } } });
    expect(byId(results).get("c4.upstream-success.receipt")?.status).toBe("fail");
  });

  test("malformed hash, placeholder and undecodable header all fail closed", () => {
    const bad = [
      encodeHeaderValue({ receipt: { txHash: "0x1234" } }),
      encodeHeaderValue({ receipt: { txHash: "not-a-hash" } }),
      encodeHeaderValue({ receipt: { txHash: "" } }),
      encodeHeaderValue({}),
      "%%%not-base64-and-not-json%%%",
    ];
    for (const header of bad) {
      const results = run({ upstreamSuccess: { responseHeaders: { "payment-response": header } } });
      expect(byId(results).get("c4.upstream-success.receipt")?.status, header.slice(0, 20)).toBe("fail");
    }
  });
});

describe("C4 settlement order — boundaries and skip rules", () => {
  test("missing probe: one critical failure, all other assertions skip", () => {
    const list = Object.values(probes()).filter((probe) => probe.probe !== "upstreamSuccess");
    const results = checkSettlementOrder({ observations: list });
    const map = byId(results);
    expect(map.get("c4.probes")?.status).toBe("fail");
    expect(map.get("c4.unsigned.status")?.status).toBe("skip");
    expect(map.get("c4.upstream-success.receipt")?.status).toBe("skip");
    expect(results.filter((result) => result.status === "skip")).toHaveLength(11);
  });

  test("duplicate probe is rejected, not silently overwritten", () => {
    const list = [...Object.values(probes()), probes().unsigned];
    const results = checkSettlementOrder({ observations: list });
    expect(byId(results).get("c4.probes")?.status).toBe("fail");
    expect(byId(results).get("c4.probes")?.evidence).toMatchObject({ duplicates: ["unsigned"] });
  });

  test("malformed observation field is rejected", () => {
    const list = Object.values(probes()).map((probe) =>
      probe.probe === "unsigned" ? { ...probe, settled: "false" } : probe,
    );
    const results = checkSettlementOrder({ observations: list as unknown as ProbeObservation[] });
    expect(byId(results).get("c4.probes")?.status).toBe("fail");
  });

  test("upstream-error probe never reached upstream: forwarded fails, no-settle skips", () => {
    const results = run({
      upstreamError: { upstreamCalled: false, upstreamStatus: undefined, settled: false },
    });
    const map = byId(results);
    expect(map.get("c4.upstream-error.forwarded")?.status).toBe("fail");
    expect(map.get("c4.upstream-error.no-settle")?.status).toBe("skip");
    // Other probes are unaffected by this skip.
    expect(map.get("c4.unsigned.status")?.status).toBe("pass");
  });

  test("upstream-success probe saw 3xx: forwarded fails, settled and receipt skip", () => {
    const results = run({
      upstreamSuccess: { upstreamStatus: 302, responseStatus: 200, settled: true },
    });
    const map = byId(results);
    expect(map.get("c4.upstream-success.forwarded")?.status).toBe("fail");
    expect(map.get("c4.upstream-success.settled")?.status).toBe("skip");
    expect(map.get("c4.upstream-success.receipt")?.status).toBe("skip");
  });

  test("out-of-range response status is rejected by the input guard", () => {
    const list = Object.values(probes()).map((probe) =>
      probe.probe === "unsigned" ? { ...probe, responseStatus: 42 } : probe,
    );
    const results = checkSettlementOrder({ observations: list });
    expect(byId(results).get("c4.probes")?.status).toBe("fail");
  });

  test("skip is never reported as pass", () => {
    const list = Object.values(probes()).filter((probe) => probe.probe !== "upstreamError");
    const results = checkSettlementOrder({ observations: list });
    expect(results.some((result) => result.status === "skip")).toBe(true);
    // With a broken input set nothing is verified, so nothing may be green.
    expect(results.some((result) => result.status === "pass")).toBe(false);
  });

  test("rejects observations whose trust fields come from a prototype", () => {
    // A polluted prototype must not be able to supply `settled` /
    // `upstreamCalled`. All fields must be own properties of each observation.
    const inherited = Object.values(probes()).map((probe) => {
      const own = { ...probe };
      const asProto = Object.assign(Object.create(null), own);
      return Object.create(asProto) as ProbeObservation;
    });
    const results = checkSettlementOrder({ observations: inherited });
    expect(byId(results).get("c4.probes")?.status).toBe("fail");
    expect(results.every((r) => r.status !== "pass")).toBe(true);
  });
});
