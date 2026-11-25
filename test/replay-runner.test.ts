import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import type { CheckResult } from "../src/checks/types.js";
import { runReplayProbes } from "../src/probes/replay.js";
import {
  SANDBOX_TX_HASH,
  SANDBOX_VALID_SIGNATURE,
  startMockCache,
  startMockFacilitator,
  startMockUpstream,
} from "../src/sandbox/mock-services.js";
import {
  C5_DEFECTS,
  isC5Defect,
  replayPaymentHeader,
  startReplaySeller,
  type C5Defect,
} from "../src/sandbox/replay-seller.js";
import { decodeHeaderValue } from "../src/wire.js";

function statusOf(results: readonly CheckResult[], id: string): string | undefined {
  return results.find((result) => result.id === id)?.status;
}

function failedIds(results: readonly CheckResult[]): string[] {
  return results.filter((result) => result.status === "fail").map((result) => result.id);
}

const TIMEOUT = 30_000;
const execFileAsync = promisify(execFile);

async function invokeCli(args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", ...args],
      { cwd: process.cwd(), timeout: TIMEOUT },
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

describe("C5 replay runner", () => {
  it("honest seller: three scenarios produce 13 passes from real HTTP traffic", async () => {
    const run = await runReplayProbes({ defect: "none" });
    expect(run.results).toHaveLength(13);
    expect(run.results.every((result) => result.status === "pass")).toBe(true);
    expect(run.observations.map((observation) => observation.scenario)).toEqual([
      "nonceReplay",
      "idempotencyKey",
      "nonceReuse",
    ]);
  }, TIMEOUT);

  it("observations carry statuses only the mocks could have produced", async () => {
    const run = await runReplayProbes({ defect: "none" });
    const [nonce, idem, reuse] = run.observations;
    expect(nonce?.first).toMatchObject({
      responseStatus: 200,
      settled: true,
      settlementStatus: 200,
      upstreamCalled: true,
      upstreamStatus: 200,
      cacheHit: false,
    });
    expect(nonce?.second).toMatchObject({
      responseStatus: 402,
      settled: false,
      settlementStatus: undefined,
      upstreamCalled: false,
      upstreamStatus: undefined,
      cacheHit: false,
    });
    expect(idem?.second).toMatchObject({ responseStatus: 200, settled: false, upstreamCalled: false, cacheHit: true });
    expect(reuse?.second).toMatchObject({ responseStatus: 402, settled: false, upstreamCalled: false });
  }, TIMEOUT);

  it("logs are drained per attempt, so no call is attributed twice", async () => {
    const run = await runReplayProbes({ defect: "none" });
    for (const scenario of ["nonceReplay", "idempotencyKey", "nonceReuse"] as const) {
      const capture = run.captures[scenario];
      expect(capture.first.upstream).toHaveLength(1);
      expect(capture.first.facilitator.filter((call) => call.path === "/settle")).toHaveLength(1);
      expect(capture.second.upstream).toHaveLength(0);
      expect(capture.second.facilitator.filter((call) => call.path === "/settle")).toHaveLength(0);
    }
    expect(run.captures.idempotencyKey.second.cache.some((call) => call.method === "get" && call.hit)).toBe(true);
    expect(run.contradictions).toEqual([]);
  }, TIMEOUT);

  it("scenario state is isolated: plan order cannot turn a first attempt into a replay", async () => {
    const upstream = await startMockUpstream();
    const facilitator = await startMockFacilitator();
    const cache = await startMockCache();
    const seller = await startReplaySeller({
      upstreamUrl: upstream.url,
      facilitatorUrl: facilitator.url,
      cacheUrl: cache.url,
      defect: "none",
    });
    const send = async (scene: string, nonce: string, signature: string, key: string): Promise<number> => {
      const response = await fetch(`${seller.url}/v1/echo`, {
        headers: {
          "x-c5-probe": scene,
          "idempotency-key": key,
          "payment-signature": replayPaymentHeader({ nonce, signature }),
        },
        signal: AbortSignal.timeout(10_000),
      });
      await response.arrayBuffer();
      return response.status;
    };
    try {
      // All three first attempts share SANDBOX_VALID_SIGNATURE. Whichever
      // scenario runs first must not poison the others' replay state.
      expect(await send("idempotencyKey", `0x${"22".repeat(32)}`, SANDBOX_VALID_SIGNATURE, "idem-shared")).toBe(200);
      expect(await send("nonceReplay", `0x${"11".repeat(32)}`, SANDBOX_VALID_SIGNATURE, "nr-first")).toBe(200);
      expect(await send("nonceReuse", `0x${"33".repeat(32)}`, SANDBOX_VALID_SIGNATURE, "ru-first")).toBe(200);
    } finally {
      await Promise.allSettled([seller.close(), cache.close(), facilitator.close(), upstream.close()]);
    }
  }, TIMEOUT);

  it("nonce-rebill: a new key lets the same signed payload charge twice", async () => {
    const run = await runReplayProbes({ defect: "nonce-rebill" });
    expect(failedIds(run.results)).toEqual([
      "c5.nonce-replay.no-rebill",
      "c5.nonce-replay.rejected",
      "c5.nonce-replay.no-forward",
    ]);
    expect(run.observations[0]?.second.settled).toBe(true);
    expect(run.captures.nonceReplay.second.facilitator.filter((call) => call.path === "/settle")).toHaveLength(1);
  }, TIMEOUT);

  it("idem-no-cache: a self-reported cache hit cannot replace the cache log", async () => {
    const run = await runReplayProbes({ defect: "idem-no-cache" });
    // The defect belongs to the retry only: the first attempt is an ordinary
    // cache miss with no false claim of its own.
    expect(run.observations[1]?.first.responseHeaders["x-c5-cache-claim"]).toBeUndefined();
    expect(run.captures.idempotencyKey.first.cache.some((call) => call.method === "get")).toBe(true);
    // The seller literally claims a hit in its own response to the retry.
    expect(run.observations[1]?.second.responseHeaders["x-c5-cache-claim"]).toBe("hit");
    // The independent cache log shows no lookup at all, so the runner reports
    // a miss and the money-losing assertions fire.
    expect(run.observations[1]?.second.cacheHit).toBe(false);
    expect(run.captures.idempotencyKey.second.cache.some((call) => call.method === "get")).toBe(false);
    expect(failedIds(run.results)).toEqual([
      "c5.idempotency.cached",
      "c5.idempotency.no-rebill",
      "c5.idempotency.no-forward",
    ]);
  }, TIMEOUT);

  it("idem-cached-rebill: a hit with fresh side effects is normalized and kept as evidence", async () => {
    const run = await runReplayProbes({ defect: "idem-cached-rebill" });
    expect(run.contradictions).toEqual([
      {
        scenario: "idempotencyKey",
        attempt: "second",
        cacheHitRaw: true,
        settled: true,
        upstreamCalled: true,
      },
    ]);
    // Without normalization the whole scenario set would be rejected as
    // malformed and these three targeted failures would disappear.
    expect(run.observations[1]?.second.cacheHit).toBe(false);
    expect(run.results[0]?.status).toBe("pass");
    expect(failedIds(run.results)).toEqual([
      "c5.idempotency.cached",
      "c5.idempotency.no-rebill",
      "c5.idempotency.no-forward",
    ]);
  }, TIMEOUT);

  it("nonce-reuse-bypass: re-signing the same nonce defeats the replay guard", async () => {
    const run = await runReplayProbes({ defect: "nonce-reuse-bypass" });
    expect(failedIds(run.results)).toEqual(["c5.nonce-reuse.no-rebill", "c5.nonce-reuse.rejected"]);
    expect(statusOf(run.results, "c5.nonce-reuse.first-settled")).toBe("pass");
    expect(run.observations[2]?.second.settled).toBe(true);
    expect(run.observations[2]?.second.responseStatus).toBe(200);
  }, TIMEOUT);

  it("bad-receipt: a settled retry with an unusable tx hash cannot be reconciled", async () => {
    const run = await runReplayProbes({ defect: "bad-receipt" });
    expect(failedIds(run.results)).toEqual(["c5.idempotency.same-result"]);
    expect(run.observations[1]?.second.cacheHit).toBe(true);
    expect(statusOf(run.results, "c5.idempotency.no-rebill")).toBe("pass");
  }, TIMEOUT);

  it("forged-claim: a self-reported receipt cannot substitute for a real settle call", async () => {
    const honest = await runReplayProbes({ defect: "none" });
    const forged = await runReplayProbes({ defect: "forged-claim" });

    expect(forged.observations[0]?.first.responseHeaders["payment-response"]).toBe(
      honest.observations[0]?.first.responseHeaders["payment-response"],
    );
    const decoded = decodeHeaderValue(forged.observations[0]?.first.responseHeaders["payment-response"] ?? "");
    expect(
      decoded.ok && (decoded.value as { settlement?: { txHash?: string } }).settlement?.txHash,
    ).toBe(SANDBOX_TX_HASH);
    expect(forged.captures.nonceReplay.first.facilitator.filter((call) => call.path === "/settle")).toHaveLength(0);
    expect(failedIds(forged.results)).toEqual([
      "c5.nonce-replay.first-settled",
      "c5.idempotency.first-settled",
      "c5.nonce-reuse.first-settled",
    ]);
    // The downstream "no second charge" checks stay live instead of being
    // skipped behind the failed precondition.
    expect(statusOf(forged.results, "c5.nonce-replay.no-rebill")).toBe("pass");
    // A fabricated but consistent receipt still satisfies same-result; only
    // the mock settle log exposes that no money ever moved.
    expect(statusOf(forged.results, "c5.idempotency.same-result")).toBe("pass");
    expect(forged.results.some((result) => result.status === "skip")).toBe(false);
  }, TIMEOUT);

  it("first-not-settled: no receipt either, so the retry cannot be reconciled", async () => {
    const run = await runReplayProbes({ defect: "first-not-settled" });
    expect(failedIds(run.results)).toEqual([
      "c5.nonce-replay.first-settled",
      "c5.idempotency.first-settled",
      "c5.idempotency.same-result",
      "c5.nonce-reuse.first-settled",
    ]);
    expect(run.observations[1]?.first.responseHeaders["payment-response"]).toBeUndefined();
    expect(run.results.some((result) => result.status === "skip")).toBe(false);
  }, TIMEOUT);

  it("rejects an unknown defect before starting any server", async () => {
    await expect(runReplayProbes({ defect: "not-a-defect" as C5Defect })).rejects.toThrow(/unknown replay defect/);
  });

  it("rejects a non-positive timeout before starting any server", async () => {
    await expect(runReplayProbes({ timeoutMs: 0 })).rejects.toThrow(/positive integer/);
  });

  it("rejects an oversized timeout that Node would clamp to 1 ms", async () => {
    await expect(runReplayProbes({ timeoutMs: 2 ** 32 })).rejects.toThrow(/timer range/);
  });

  it("every exported defect mode is reachable and handled", () => {
    expect(C5_DEFECTS).toHaveLength(8);
    for (const defect of C5_DEFECTS) expect(isC5Defect(defect)).toBe(true);
  });

  it("isC5Defect fails closed on inherited keys and non-strings", () => {
    expect(isC5Defect("toString")).toBe(false);
    expect(isC5Defect("constructor")).toBe(false);
    expect(isC5Defect(undefined)).toBe(false);
    expect(isC5Defect(1)).toBe(false);
    expect(isC5Defect({ defect: "none" })).toBe(false);
  });
});

describe("verify-replay CLI contract", () => {
  it("rejects positional arguments instead of silently running the honest sandbox", async () => {
    const result = await invokeCli(["verify-replay", "idem-no-cache", "--json"]);
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("no positional arguments");
    expect(result.stdout).not.toContain("sandbox");
    expect(result.stdout).not.toContain("13 passed");
  }, TIMEOUT);

  it("reports a real defect through the documented exit code and JSON report", async () => {
    const result = await invokeCli(["verify-replay", "--defect", "nonce-rebill", "--json"]);
    expect(result.code).toBe(1);
    const report = JSON.parse(result.stdout) as {
      command: string;
      sandbox: { defect: string };
      results: readonly CheckResult[];
    };
    expect(report.command).toBe("verify-replay");
    expect(report.sandbox.defect).toBe("nonce-rebill");
    expect(failedIds(report.results)).toEqual([
      "c5.nonce-replay.no-rebill",
      "c5.nonce-replay.rejected",
      "c5.nonce-replay.no-forward",
    ]);
  }, TIMEOUT);

  it("fails closed on an unknown defect mode", async () => {
    const result = await invokeCli(["verify-replay", "--defect", "bogus", "--json"]);
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("unknown --defect");
    expect(result.stdout).toBe("");
  }, TIMEOUT);

  it("honest sandbox exits 0 with all 13 assertions passing", async () => {
    const result = await invokeCli(["verify-replay", "--json"]);
    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout) as { results: readonly CheckResult[] };
    expect(report.results).toHaveLength(13);
    expect(report.results.every((entry) => entry.status === "pass")).toBe(true);
  }, TIMEOUT);
});
