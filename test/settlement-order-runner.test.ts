import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import type { CheckResult } from "../src/checks/types.js";
import { runSandboxSettlementProbes } from "../src/probes/settlement-order.js";
import { SANDBOX_TX_HASH } from "../src/sandbox/mock-services.js";
import { SANDBOX_DEFECTS, isSandboxDefect, type SandboxDefect } from "../src/sandbox/seller.js";
import { decodeHeaderValue } from "../src/wire.js";

function statusOf(results: readonly CheckResult[], id: string): string | undefined {
  return results.find((result) => result.id === id)?.status;
}

function failedIds(results: readonly CheckResult[]): string[] {
  return results.filter((result) => result.status === "fail").map((result) => result.id);
}

const TIMEOUT = 20_000;
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

describe("C4 sandbox runner", () => {
  it("honest seller: four probes produce 12 passes from real HTTP traffic", async () => {
    const run = await runSandboxSettlementProbes({ defect: "none" });
    expect(run.results).toHaveLength(12);
    expect(run.results.every((result) => result.status === "pass")).toBe(true);
    expect(run.observations.map((observation) => observation.probe)).toEqual([
      "unsigned",
      "invalidSignature",
      "upstreamError",
      "upstreamSuccess",
    ]);
  }, TIMEOUT);

  it("observations carry statuses that only the mocks could have produced", async () => {
    const run = await runSandboxSettlementProbes({ defect: "none" });
    const [unsigned, invalid, error, success] = run.observations;
    expect(unsigned).toMatchObject({ responseStatus: 402, upstreamCalled: false, settled: false });
    expect(invalid).toMatchObject({ responseStatus: 402, upstreamCalled: false, settled: false });
    expect(error).toMatchObject({ responseStatus: 503, upstreamCalled: true, upstreamStatus: 503, settled: false });
    expect(success).toMatchObject({ responseStatus: 200, upstreamCalled: true, upstreamStatus: 200, settled: true, settlementStatus: 200 });
    expect(run.captures.upstreamError.upstream.map((call) => call.path)).toEqual(["/v1/error"]);
    expect(run.captures.upstreamSuccess.upstream.map((call) => call.path)).toEqual(["/v1/echo"]);
    expect(run.captures.upstreamSuccess.facilitator.filter((call) => call.path === "/settle")).toHaveLength(1);
  }, TIMEOUT);

  it("free-access: unsigned request is forwarded and charged", async () => {
    const run = await runSandboxSettlementProbes({ defect: "free-access" });
    expect(failedIds(run.results)).toEqual([
      "c4.unsigned.status",
      "c4.unsigned.no-forward",
      "c4.unsigned.no-settle",
    ]);
    expect(run.observations[0]?.upstreamCalled).toBe(true);
    expect(run.observations[0]?.settled).toBe(true);
  }, TIMEOUT);

  it("forged-signature: bad signature is forwarded and charged", async () => {
    const run = await runSandboxSettlementProbes({ defect: "forged-signature" });
    expect(failedIds(run.results)).toEqual([
      "c4.invalid-signature.status",
      "c4.invalid-signature.no-forward",
      "c4.invalid-signature.no-settle",
    ]);
    expect(run.captures.invalidSignature.facilitator.some((call) => call.path === "/settle")).toBe(true);
  }, TIMEOUT);

  it("charge-on-error: payer is charged when upstream returned 503", async () => {
    const run = await runSandboxSettlementProbes({ defect: "charge-on-error" });
    expect(failedIds(run.results)).toEqual(["c4.upstream-error.no-settle"]);
    expect(statusOf(run.results, "c4.upstream-error.forwarded")).toBe("pass");
    expect(run.captures.upstreamError.facilitator.some((call) => call.path === "/settle")).toBe(true);
  }, TIMEOUT);

  it("skip-settlement: successful upstream content is delivered without charging", async () => {
    const run = await runSandboxSettlementProbes({ defect: "skip-settlement" });
    expect(failedIds(run.results)).toEqual([
      "c4.upstream-success.settled",
      "c4.upstream-success.receipt",
    ]);
    expect(run.observations[3]?.responseStatus).toBe(200);
    expect(run.captures.upstreamSuccess.facilitator.some((call) => call.path === "/settle")).toBe(false);
  }, TIMEOUT);

  it("bad-receipt: settlement happened but the receipt hash is unusable", async () => {
    const run = await runSandboxSettlementProbes({ defect: "bad-receipt" });
    expect(failedIds(run.results)).toEqual(["c4.upstream-success.receipt"]);
    expect(statusOf(run.results, "c4.upstream-success.settled")).toBe("pass");
    expect(run.observations[3]?.settled).toBe(true);
  }, TIMEOUT);

  it("forged-claim: a self-reported receipt cannot substitute for a real settle call", async () => {
    const honest = await runSandboxSettlementProbes({ defect: "none" });
    const forged = await runSandboxSettlementProbes({ defect: "forged-claim" });

    // Identical-looking proof to the client in both runs.
    expect(forged.observations[3]?.responseHeaders["payment-response"]).toBe(
      honest.observations[3]?.responseHeaders["payment-response"],
    );
    const claimedReceipt = decodeHeaderValue(forged.observations[3]?.responseHeaders["payment-response"] ?? "");
    expect(claimedReceipt.ok && (claimedReceipt.value as { settlement?: { txHash?: string } }).settlement?.txHash).toBe(
      SANDBOX_TX_HASH,
    );
    // Only the mock log distinguishes them — this is the trust boundary C4 relies on.
    expect(forged.captures.upstreamSuccess.facilitator.filter((call) => call.path === "/settle")).toHaveLength(0);
    expect(statusOf(forged.results, "c4.upstream-success.receipt")).toBe("pass");
    expect(statusOf(forged.results, "c4.upstream-success.settled")).toBe("fail");
    expect(statusOf(honest.results, "c4.upstream-success.settled")).toBe("pass");
  }, TIMEOUT);

  it("forged-claim on the unsigned probe does not make the seller look charged", async () => {
    const run = await runSandboxSettlementProbes({ defect: "forged-claim" });
    expect(run.observations[0]?.responseHeaders["payment-response"]).toBeDefined();
    expect(run.observations[0]?.settled).toBe(false);
    expect(statusOf(run.results, "c4.unsigned.no-settle")).toBe("pass");
  }, TIMEOUT);

  it("captures are drained per probe, so no call is attributed twice", async () => {
    const run = await runSandboxSettlementProbes({ defect: "none" });
    const allUpstreamCalls = Object.values(run.captures).flatMap((capture) => capture.upstream);
    const allSettleCalls = Object.values(run.captures).flatMap((capture) =>
      capture.facilitator.filter((call) => call.path === "/settle"),
    );
    expect(allUpstreamCalls).toHaveLength(2);
    expect(allSettleCalls).toHaveLength(1);
    expect(statusOf(run.results, "c4.probes")).toBe("pass");
  }, TIMEOUT);

  it("rejects an unknown defect before starting any server", async () => {
    await expect(
      runSandboxSettlementProbes({ defect: "not-a-defect" as SandboxDefect }),
    ).rejects.toThrow(/unknown sandbox defect/);
  });

  it("rejects a non-positive timeout before starting any server", async () => {
    await expect(runSandboxSettlementProbes({ timeoutMs: 0 })).rejects.toThrow(/positive integer/);
  });

  it("every exported defect mode is reachable and handled", () => {
    expect(SANDBOX_DEFECTS).toHaveLength(7);
    for (const defect of SANDBOX_DEFECTS) expect(isSandboxDefect(defect)).toBe(true);
  });

  it("isSandboxDefect fails closed on inherited keys and non-strings", () => {
    expect(isSandboxDefect("toString")).toBe(false);
    expect(isSandboxDefect("constructor")).toBe(false);
    expect(isSandboxDefect(undefined)).toBe(false);
    expect(isSandboxDefect(1)).toBe(false);
    expect(isSandboxDefect({ defect: "none" })).toBe(false);
  });
});

describe("verify CLI contract", () => {
  it("rejects positional arguments instead of silently running the honest sandbox", async () => {
    const result = await invokeCli(["verify", "free-access", "--json"]);
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("no positional arguments");
    expect(result.stdout).not.toContain("sandbox");
    expect(result.stdout).not.toContain("12 passed");
  }, TIMEOUT);

  it("reports a real defect through the documented exit code and JSON report", async () => {
    const result = await invokeCli(["verify", "--defect", "bad-receipt", "--json"]);
    expect(result.code).toBe(1);
    const report = JSON.parse(result.stdout) as {
      sandbox: { defect: string };
      results: readonly CheckResult[];
    };
    expect(report.sandbox.defect).toBe("bad-receipt");
    expect(failedIds(report.results)).toEqual(["c4.upstream-success.receipt"]);
  }, TIMEOUT);

  it("fails closed on an unknown defect mode", async () => {
    const result = await invokeCli(["verify", "--defect", "bogus", "--json"]);
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("unknown --defect");
    expect(result.stdout).toBe("");
  }, TIMEOUT);

  it("honest sandbox exits 0 with all 12 assertions passing", async () => {
    const result = await invokeCli(["verify", "--json"]);
    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout) as { results: readonly CheckResult[] };
    expect(report.results.every((entry) => entry.status === "pass")).toBe(true);
  }, TIMEOUT);
});
