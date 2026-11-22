import { describe, expect, test } from "vitest";

import { encodeHeaderValue } from "../src/wire.js";
import {
  checkReplayIdempotency,
  type ReplayAttempt,
  type ReplayScenarioName,
  type ReplayScenarioObservation,
} from "../src/checks/c5-replay-idempotency.js";
import type { CheckResult } from "../src/checks/types.js";

const TX = `0x${"cd".repeat(32)}`;
const OTHER_TX = `0x${"ef".repeat(32)}`;
const BODY = "b".repeat(64);

function receiptHeader(txHash: string = TX): string {
  return encodeHeaderValue({ x402Version: 2, receipt: { txHash, network: "eip155:2368" } });
}

/**
 * Conformant baseline. Every negative test perturbs one field so the failure
 * it asserts is the only difference from the passing case.
 */
function attempts(): Record<ReplayScenarioName, { first: ReplayAttempt; second: ReplayAttempt }> {
  const settledFirst: ReplayAttempt = {
    responseStatus: 200,
    responseHeaders: { "payment-response": receiptHeader() },
    responseBodyHash: BODY,
    settled: true,
    settlementStatus: 200,
    upstreamCalled: true,
    upstreamStatus: 200,
    cacheHit: false,
  };
  const rejectedSecond: ReplayAttempt = {
    responseStatus: 402,
    responseHeaders: {},
    responseBodyHash: "rejected",
    settled: false,
    settlementStatus: undefined,
    upstreamCalled: false,
    upstreamStatus: undefined,
    cacheHit: false,
  };
  const cachedSecond: ReplayAttempt = {
    responseStatus: 200,
    responseHeaders: { "payment-response": receiptHeader() },
    responseBodyHash: BODY,
    settled: false,
    settlementStatus: undefined,
    upstreamCalled: false,
    upstreamStatus: undefined,
    cacheHit: true,
  };
  return {
    nonceReplay: { first: settledFirst, second: rejectedSecond },
    idempotencyKey: { first: settledFirst, second: cachedSecond },
    nonceReuse: { first: settledFirst, second: rejectedSecond },
  };
}

function run(
  overrides: Partial<Record<ReplayScenarioName, { first?: Partial<ReplayAttempt>; second?: Partial<ReplayAttempt> }>> = {},
): CheckResult[] {
  const base = attempts();
  const scenarios: ReplayScenarioObservation[] = (Object.keys(base) as ReplayScenarioName[]).map((name) => ({
    scenario: name,
    first: { ...base[name].first, ...(overrides[name]?.first ?? {}) },
    second: { ...base[name].second, ...(overrides[name]?.second ?? {}) },
  }));
  return checkReplayIdempotency({ scenarios });
}

function byId(results: CheckResult[]): Map<string, CheckResult> {
  return new Map(results.map((result) => [result.id, result]));
}

function failures(results: CheckResult[]): string[] {
  return results.filter((result) => result.status === "fail").map((result) => result.id);
}

function skips(results: CheckResult[]): string[] {
  return results.filter((result) => result.status === "skip").map((result) => result.id);
}

describe("C5 replay and idempotency — positive case", () => {
  test("all three scenarios conform: 13 pass, zero fail or skip", () => {
    const results = run();
    expect(results).toHaveLength(13);
    expect(new Set(results.map((result) => result.id)).size).toBe(13);
    expect(results.every((result) => result.status === "pass")).toBe(true);
    expect(failures(results)).toEqual([]);
    expect(skips(results)).toEqual([]);
  });
});

describe("C5 — nonce replay (new key, same signature)", () => {
  test("second submission that settles is the core double-charge failure", () => {
    const results = run({
      nonceReplay: {
        second: { settled: true, settlementStatus: 200, responseStatus: 402 },
      },
    });
    const map = byId(results);
    expect(map.get("c5.nonce-replay.no-rebill")?.status).toBe("fail");
    // Even though the client saw 402, the charge happened: rejection alone is
    // not reported as success and the two failures stay independent.
    expect(map.get("c5.nonce-replay.rejected")?.status).toBe("pass");
  });

  test("second submission returning 200 with no settlement still fails", () => {
    const results = run({
      nonceReplay: { second: { responseStatus: 200 } },
    });
    expect(byId(results).get("c5.nonce-replay.rejected")?.status).toBe("fail");
  });

  test("replayed signature forwarded upstream fails no-forward", () => {
    const results = run({
      nonceReplay: { second: { upstreamCalled: true, upstreamStatus: 200 } },
    });
    expect(byId(results).get("c5.nonce-replay.no-forward")?.status).toBe("fail");
  });

  test("first submission not settled fails first-settled but no-rebill stays live", () => {
    const results = run({
      nonceReplay: {
        first: { settled: false, settlementStatus: undefined, responseStatus: 402 },
      },
    });
    const map = byId(results);
    expect(map.get("c5.nonce-replay.first-settled")?.status).toBe("fail");
    expect(map.get("c5.nonce-replay.no-rebill")?.status).toBe("pass");
  });
});

describe("C5 — idempotency key retry", () => {
  test("second attempt that settles is a double charge", () => {
    const results = run({
      idempotencyKey: {
        second: { cacheHit: false, settled: true, settlementStatus: 200 },
      },
    });
    expect(byId(results).get("c5.idempotency.no-rebill")?.status).toBe("fail");
  });

  test("second attempt missing the cache fails", () => {
    const results = run({
      idempotencyKey: { second: { cacheHit: false, settled: false, upstreamCalled: false } },
    });
    expect(byId(results).get("c5.idempotency.cached")?.status).toBe("fail");
  });

  test("different body digest fails same-result", () => {
    const results = run({
      idempotencyKey: { second: { responseBodyHash: "different" } },
    });
    expect(byId(results).get("c5.idempotency.same-result")?.status).toBe("fail");
  });

  test("different tx hash fails same-result", () => {
    const results = run({
      idempotencyKey: { second: { responseHeaders: { "payment-response": receiptHeader(OTHER_TX) } } },
    });
    expect(byId(results).get("c5.idempotency.same-result")?.status).toBe("fail");
  });

  test("missing receipt on first attempt fails same-result, not skip", () => {
    const results = run({
      idempotencyKey: { first: { responseHeaders: {} } },
    });
    expect(byId(results).get("c5.idempotency.same-result")?.status).toBe("fail");
  });

  test("retry that reached upstream fails no-forward even without a cache hit", () => {
    // cacheHit=false keeps the observation self-consistent, so this reaches
    // the assertion itself rather than being rejected as input contradiction.
    const results = run({
      idempotencyKey: {
        second: {
          cacheHit: false,
          settled: false,
          upstreamCalled: true,
          upstreamStatus: 200,
        },
      },
    });
    expect(byId(results).get("c5.idempotency.no-forward")?.status).toBe("fail");
  });

  test("cache hit that also reached upstream invalidates the whole observation set", () => {
    // cacheHit=true with upstreamCalled=true is a contradictory observation,
    // so the whole scenario set is invalid rather than an assertion verdict.
    const results = run({
      idempotencyKey: { second: { upstreamCalled: true, upstreamStatus: 200 } },
    });
    expect(byId(results).get("c5.scenarios")?.status).toBe("fail");
    expect(skips(results)).toHaveLength(12);
  });
});

describe("C5 — nonce reuse with a re-signed authorization", () => {
  test("first authorization not settled is reported, never a vacuous all-green", () => {
    const results = run({
      nonceReuse: {
        first: {
          responseStatus: 402,
          settled: false,
          settlementStatus: undefined,
          upstreamCalled: false,
          upstreamStatus: undefined,
        },
      },
    });
    const map = byId(results);
    expect(map.get("c5.nonce-reuse.first-settled")?.status).toBe("fail");
    expect(failures(results)).toContain("c5.nonce-reuse.first-settled");
  });

  test("reused nonce that settles fails no-rebill", () => {
    const results = run({
      nonceReuse: {
        second: { settled: true, settlementStatus: 200, responseStatus: 402 },
      },
    });
    expect(byId(results).get("c5.nonce-reuse.no-rebill")?.status).toBe("fail");
  });

  test("re-signed authorization returning 200 fails rejected", () => {
    const results = run({
      nonceReuse: { second: { responseStatus: 200 } },
    });
    expect(byId(results).get("c5.nonce-reuse.rejected")?.status).toBe("fail");
  });
});

describe("C5 — input validation and skip semantics", () => {
  test("missing scenario fails c5.scenarios and skips the other 12", () => {
    const results = checkReplayIdempotency({
      scenarios: [nonceReplayScenario(), idempotencyScenario()],
    });
    expect(byId(results).get("c5.scenarios")?.status).toBe("fail");
    expect(skips(results)).toHaveLength(12);
    expect(failures(results)).toEqual(["c5.scenarios"]);
  });

  test("duplicate scenarios fail validation", () => {
    const results = checkReplayIdempotency({
      scenarios: [nonceReplayScenario(), nonceReplayScenario(), idempotencyScenario(), nonceReuseScenario()],
    });
    expect(byId(results).get("c5.scenarios")?.status).toBe("fail");
    expect(skips(results)).toHaveLength(12);
  });

  test("non-array scenarios fail cleanly", () => {
    const results = checkReplayIdempotency({ scenarios: undefined as never });
    expect(byId(results).get("c5.scenarios")?.status).toBe("fail");
    expect(skips(results)).toHaveLength(12);
  });

  test("settled true with non-2xx status is an invalid observation", () => {
    const results = run({
      nonceReplay: { first: { settled: true, settlementStatus: 500 } },
    });
    expect(byId(results).get("c5.scenarios")?.status).toBe("fail");
  });

  test("settled false with a settlement status is an invalid observation", () => {
    const results = run({
      nonceReplay: { first: { settled: false, settlementStatus: 200 } },
    });
    expect(byId(results).get("c5.scenarios")?.status).toBe("fail");
  });

  test("upstreamCalled true without a status is an invalid observation", () => {
    const results = run({
      nonceReplay: { second: { upstreamCalled: true, upstreamStatus: undefined } },
    });
    expect(byId(results).get("c5.scenarios")?.status).toBe("fail");
  });

  test("cache hit that also settled is rejected as self-contradictory", () => {
    const results = run({
      idempotencyKey: { second: { cacheHit: true, settled: true, settlementStatus: 200 } },
    });
    expect(byId(results).get("c5.scenarios")?.status).toBe("fail");
    expect(skips(results)).toHaveLength(12);
  });

  test("non-string responseBodyHash fails validation rather than throwing", () => {
    const results = run({
      nonceReplay: { second: { responseBodyHash: 123 as never } },
    });
    expect(byId(results).get("c5.scenarios")?.status).toBe("fail");
  });

  test("empty responseBodyHash fails validation", () => {
    const results = run({
      nonceReplay: { second: { responseBodyHash: "" } },
    });
    expect(byId(results).get("c5.scenarios")?.status).toBe("fail");
  });

  test("non-string header value fails validation rather than throwing", () => {
    const results = run({
      nonceReplay: { second: { responseHeaders: { "x-value": 1 as never } } },
    });
    expect(byId(results).get("c5.scenarios")?.status).toBe("fail");
  });

  test("out-of-range response status fails validation", () => {
    const results = run({
      nonceReplay: { second: { responseStatus: 99 } },
    });
    expect(byId(results).get("c5.scenarios")?.status).toBe("fail");
  });

  test("inherited txHash from a polluted prototype cannot supply a receipt", () => {
    // The header itself is a normal object; the pollution lives on the
    // prototype, which is exactly what Object.hasOwn must reject.
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, "txHash");
    Object.defineProperty(Object.prototype, "txHash", {
      value: TX,
      configurable: true,
      writable: true,
      enumerable: false,
    });
    try {
      const results = run({
        idempotencyKey: { first: { responseHeaders: { "payment-response": receiptHeader() } } },
      });
      // A valid header exists, so a naive `candidate[key]` read would find the
      // prototype's hash and pass even if the header carried no real hash.
      // Keep this a regression check on the real payload instead: a header
      // with no own txHash must fail.
      const withoutHash = run({
        idempotencyKey: {
          first: { responseHeaders: { "payment-response": encodeHeaderValue({ receipt: {} }) } },
        },
      });
      expect(byId(withoutHash).get("c5.idempotency.same-result")?.status).toBe("fail");
      expect(byId(results).get("c5.idempotency.same-result")?.status).toBe("pass");
    } finally {
      if (previous === undefined) delete (Object.prototype as Record<string, unknown>)["txHash"];
      else Object.defineProperty(Object.prototype, "txHash", previous);
    }
  });

  test("inherited required fields on an attempt cannot satisfy validation", () => {
    const base = attempts();
    const poisonedSecond = Object.create({
      settled: false,
      settlementStatus: undefined,
      cacheHit: false,
      responseBodyHash: "x",
    }) as ReplayAttempt;
    Object.defineProperties(poisonedSecond, {
      responseStatus: { value: 402, enumerable: true },
      responseHeaders: { value: {}, enumerable: true },
      upstreamCalled: { value: false, enumerable: true },
      upstreamStatus: { value: undefined, enumerable: true },
    });
    const results = checkReplayIdempotency({
      scenarios: [
        { scenario: "nonceReplay", first: base.nonceReplay.first, second: poisonedSecond },
        {
          scenario: "idempotencyKey",
          first: base.idempotencyKey.first,
          second: base.idempotencyKey.second,
        },
        { scenario: "nonceReuse", first: base.nonceReuse.first, second: base.nonceReuse.second },
      ],
    });
    expect(byId(results).get("c5.scenarios")?.status).toBe("fail");
    expect(skips(results)).toHaveLength(12);
  });

  test("observations survive a JSON round-trip that drops undefined status keys", () => {
    const base = attempts();
    const scenarios = (Object.keys(base) as ReplayScenarioName[]).map((name) => ({
      scenario: name,
      first: base[name].first,
      second: base[name].second,
    }));
    const roundTripped = JSON.parse(JSON.stringify(scenarios)) as ReplayScenarioObservation[];
    const results = checkReplayIdempotency({ scenarios: roundTripped });
    expect(failures(results)).toEqual([]);
    expect(skips(results)).toEqual([]);
    expect(results).toHaveLength(13);
  });

  test("inherited non-undefined status cannot supply a settlement result", () => {
    const base = attempts();
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, "settlementStatus");
    Object.defineProperty(Object.prototype, "settlementStatus", {
      value: 200,
      configurable: true,
      writable: true,
      enumerable: false,
    });
    try {
      const base = attempts();
      const settledWithInheritedStatus = Object.create({
        settlementStatus: 200,
      }) as ReplayAttempt;
      Object.assign(settledWithInheritedStatus, {
        ...base.nonceReplay.first,
        settled: false,
      });
      delete (settledWithInheritedStatus as unknown as Record<string, unknown>)["settlementStatus"];
      const results = checkReplayIdempotency({
        scenarios: [
          { scenario: "nonceReplay", first: settledWithInheritedStatus, second: base.nonceReplay.second },
          {
            scenario: "idempotencyKey",
            first: base.idempotencyKey.first,
            second: base.idempotencyKey.second,
          },
          { scenario: "nonceReuse", first: base.nonceReuse.first, second: base.nonceReuse.second },
        ],
      });
      // The attempt has no own settlementStatus; a polluted prototype's 200
      // must not turn "not settled" into a legitimate 2xx settlement status.
      expect(byId(results).get("c5.scenarios")?.status).toBe("fail");
      expect(skips(results)).toHaveLength(12);
    } finally {
      if (previous === undefined) delete (Object.prototype as Record<string, unknown>)["settlementStatus"];
      else Object.defineProperty(Object.prototype, "settlementStatus", previous);
    }
  });

  test("non-2xx first settlement is still reported by first-settled", () => {
    const results = run({
      idempotencyKey: {
        first: { responseStatus: 500, upstreamStatus: 500, settled: false, settlementStatus: undefined },
      },
    });
    expect(byId(results).get("c5.idempotency.first-settled")?.status).toBe("fail");
  });
});

// Scenario builders used by the raw-input tests above.
function nonceReplayScenario(): ReplayScenarioObservation {
  const base = attempts();
  return { scenario: "nonceReplay", ...base.nonceReplay };
}
function idempotencyScenario(): ReplayScenarioObservation {
  const base = attempts();
  return { scenario: "idempotencyKey", ...base.idempotencyKey };
}
function nonceReuseScenario(): ReplayScenarioObservation {
  const base = attempts();
  return { scenario: "nonceReuse", ...base.nonceReuse };
}
