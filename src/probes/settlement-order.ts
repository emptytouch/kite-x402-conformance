/**
 * C4 probe runner: turns real HTTP traffic into trusted ProbeObservation[].
 *
 * Trust boundary: the only source for `upstreamCalled` and `settled` is the
 * request log of the independent mock upstream / mock facilitator. The
 * seller's own response headers are recorded as evidence but never used to
 * decide those two booleans. That is what makes C4 resistant to a seller that
 * merely *claims* it settled.
 *
 * Scope: the built-in synthetic seller only. Pointing this at an arbitrary
 * live service would require that service to call these exact mock URLs and
 * to expose equivalent telemetry; neither is available in this version.
 * A passing result is evidence about the sandbox seller, not about Kite
 * mainnet, a real facilitator, or any real funds.
 */

import { checkSettlementOrder, type ProbeName, type ProbeObservation } from "../checks/c4-settlement-order.js";
import type { CheckResult } from "../checks/types.js";
import { startMockFacilitator, startMockUpstream, type CapturedRequest } from "../sandbox/mock-services.js";
import { isSandboxDefect, sandboxPaymentSignature, startSandboxSeller, type SandboxDefect } from "../sandbox/seller.js";

export interface SandboxProbeOptions {
  readonly defect?: SandboxDefect;
  /** Per-request timeout for both the seller and its calls to the mocks. */
  readonly timeoutMs?: number;
}

export interface ProbeCapture {
  readonly upstream: readonly CapturedRequest[];
  readonly facilitator: readonly CapturedRequest[];
}

export interface SandboxProbeResult {
  readonly defect: SandboxDefect;
  readonly observations: readonly ProbeObservation[];
  readonly results: readonly CheckResult[];
  /** Raw mock logs, kept so a JSON report can be audited independently. */
  readonly captures: Readonly<Record<ProbeName, ProbeCapture>>;
  readonly endpoints: {
    readonly seller: string;
    readonly upstream: string;
    readonly facilitator: string;
  };
}

interface ProbePlan {
  readonly name: ProbeName;
  readonly path: string;
  readonly authorised: boolean;
}

const PROBE_PLAN: readonly ProbePlan[] = [
  { name: "unsigned", path: "/v1/echo", authorised: false },
  { name: "invalidSignature", path: "/v1/echo", authorised: true },
  { name: "upstreamError", path: "/v1/error", authorised: true },
  { name: "upstreamSuccess", path: "/v1/echo", authorised: true },
];

function isStatus(value: number): boolean {
  return Number.isInteger(value) && value >= 100 && value <= 599;
}

function flattenHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

function emptyCaptures(): Record<ProbeName, ProbeCapture> {
  return {
    unsigned: { upstream: [], facilitator: [] },
    invalidSignature: { upstream: [], facilitator: [] },
    upstreamError: { upstream: [], facilitator: [] },
    upstreamSuccess: { upstream: [], facilitator: [] },
  };
}

/**
 * Run the four probes against the built-in sandbox seller.
 * Always closes every HTTP service, including when a probe throws.
 */
export async function runSandboxSettlementProbes(options: SandboxProbeOptions = {}): Promise<SandboxProbeResult> {
  const defect = options.defect ?? "none";
  if (!isSandboxDefect(defect)) throw new TypeError(`unknown sandbox defect: ${String(defect)}`);
  const timeoutMs = options.timeoutMs ?? 5000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new TypeError("timeoutMs must be a positive integer");

  const upstream = await startMockUpstream();
  let facilitator: Awaited<ReturnType<typeof startMockFacilitator>> | undefined;
  let seller: Awaited<ReturnType<typeof startSandboxSeller>> | undefined;
  try {
    facilitator = await startMockFacilitator();
    seller = await startSandboxSeller({
      upstreamUrl: upstream.url,
      facilitatorUrl: facilitator.url,
      defect,
      timeoutMs,
    });

    const observations: ProbeObservation[] = [];
    const captures = emptyCaptures();

    for (const plan of PROBE_PLAN) {
      // Sequential probes + drain before each one: a log row can only belong
      // to the probe that is currently running. No cross-probe attribution
      // heuristic, and no reliance on the seller echoing a correlation id.
      upstream.drain();
      facilitator.drain();

      const headers: Record<string, string> = { accept: "application/json" };
      if (plan.authorised) {
        const isInvalidProbe = plan.name === "invalidSignature";
        headers["payment-signature"] = sandboxPaymentSignature(!isInvalidProbe);
      }

      const response = await fetch(`${seller.url}${plan.path}`, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "manual",
      });
      const responseHeaders = flattenHeaders(response.headers);
      await response.arrayBuffer();

      const upstreamCalls = upstream.drain();
      const facilitatorCalls = facilitator.drain();
      captures[plan.name] = { upstream: upstreamCalls, facilitator: facilitatorCalls };

      const settleCalls = facilitatorCalls.filter((call) => call.path === "/settle");
      const settledCall = settleCalls[0];
      const settled = settledCall !== undefined && settledCall.status >= 200 && settledCall.status < 300;
      const upstreamCall = upstreamCalls[0];
      const responseStatus = response.status;
      if (!isStatus(responseStatus)) {
        throw new Error(`probe ${plan.name} returned an out-of-range HTTP status: ${responseStatus}`);
      }

      observations.push({
        probe: plan.name,
        responseStatus,
        responseHeaders,
        upstreamCalled: upstreamCalls.length > 0,
        ...(upstreamCall === undefined ? { upstreamStatus: undefined } : { upstreamStatus: upstreamCall.status }),
        settled,
        // The verdict model only carries a settlement status when settlement
        // actually succeeded; a failed attempt stays undefined on purpose.
        ...(settled ? { settlementStatus: settledCall!.status } : { settlementStatus: undefined }),
      });
    }

    return {
      defect,
      observations,
      results: checkSettlementOrder({ observations }),
      captures,
      endpoints: {
        seller: seller.url,
        upstream: upstream.url,
        facilitator: facilitator.url,
      },
    };
  } finally {
    if (seller !== undefined) await seller.close();
    if (facilitator !== undefined) await facilitator.close();
    await upstream.close();
  }
}
