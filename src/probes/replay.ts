/**
 * C5 probe runner: turns real HTTP traffic into trusted replay observations.
 *
 * Trust boundary: `settled`, `upstreamCalled` and `cacheHit` come only from
 * the request logs of three independent services (facilitator, upstream,
 * cache). A seller can write "cache: hit" into its own response; it cannot
 * insert a `hit: true` row into the cache log without doing the lookup. The
 * self-reported header is captured as evidence but is never an input.
 *
 * One normalization is deliberate: the verdict layer treats
 * `cacheHit && (settled || upstreamCalled)` as an invalid observation, so a
 * seller that hits the cache AND charges again cannot be reported as-is. This
 * runner keeps the raw conflict in `contradictions`, reports `cacheHit: false`
 * so the observation is well-typed, and lets the no-rebill / no-forward
 * assertions fail on the real side effects. Dropping the normalization makes
 * the whole scenario set invalid and hides which money-losing check failed.
 *
 * Scope: the built-in synthetic seller only. A pass says the sandbox seller
 * resists the three replay paths; it says nothing about a real Kite service,
 * chain state or funds.
 */

import { createHash } from "node:crypto";

import {
  checkReplayIdempotency,
  type ReplayAttempt,
  type ReplayScenarioName,
  type ReplayScenarioObservation,
} from "../checks/c5-replay-idempotency.js";
import type { CheckResult } from "../checks/types.js";
import {
  SANDBOX_RESIGNED_SIGNATURE,
  SANDBOX_VALID_SIGNATURE,
  startMockCache,
  startMockFacilitator,
  startMockUpstream,
  type CacheRequest,
  type CapturedRequest,
} from "../sandbox/mock-services.js";
import {
  isC5Defect,
  replayPaymentHeader,
  startReplaySeller,
  type C5Defect,
  type ReplayPaymentOptions,
} from "../sandbox/replay-seller.js";

export interface ReplayProbeOptions {
  readonly defect?: C5Defect;
  /** Per-request timeout for the seller and its calls to the mocks. */
  readonly timeoutMs?: number;
}

export interface ReplayCapture {
  readonly upstream: readonly CapturedRequest[];
  readonly facilitator: readonly CapturedRequest[];
  readonly cache: readonly CacheRequest[];
}

export interface ReplayScenarioCaptures {
  readonly first: ReplayCapture;
  readonly second: ReplayCapture;
}

/** A hit that also produced side effects, kept for independent audit. */
export interface ReplayContradiction {
  readonly scenario: ReplayScenarioName;
  readonly attempt: "first" | "second";
  readonly cacheHitRaw: boolean;
  readonly settled: boolean;
  readonly upstreamCalled: boolean;
}

export interface ReplayProbeResult {
  readonly defect: C5Defect;
  readonly observations: readonly ReplayScenarioObservation[];
  readonly results: readonly CheckResult[];
  readonly captures: Readonly<Record<ReplayScenarioName, ReplayScenarioCaptures>>;
  readonly contradictions: readonly ReplayContradiction[];
  readonly endpoints: {
    readonly seller: string;
    readonly upstream: string;
    readonly facilitator: string;
    readonly cache: string;
  };
}

interface ScenarioPlan {
  readonly scenario: ReplayScenarioName;
  readonly first: ReplayPaymentOptions & { readonly idempotencyKey: string };
  readonly second: ReplayPaymentOptions & { readonly idempotencyKey: string };
}

const NONCE_REPLAY = `0x${"11".repeat(32)}`;
const NONCE_IDEM = `0x${"22".repeat(32)}`;
const NONCE_REUSE = `0x${"33".repeat(32)}`;

/**
 * Distinct nonces per scenario, combined with per-scenario state inside the
 * seller, keep the probes independent. One injected defect must produce one
 * precise set of failed assertions regardless of the order of this plan.
 */
const SCENARIO_PLAN: readonly ScenarioPlan[] = [
  {
    scenario: "nonceReplay",
    first: { nonce: NONCE_REPLAY, signature: SANDBOX_VALID_SIGNATURE, idempotencyKey: "nr-first" },
    // Same signed bytes, new key: a service that only dedups by key charges twice.
    second: { nonce: NONCE_REPLAY, signature: SANDBOX_VALID_SIGNATURE, idempotencyKey: "nr-second" },
  },
  {
    scenario: "idempotencyKey",
    first: { nonce: NONCE_IDEM, signature: SANDBOX_VALID_SIGNATURE, idempotencyKey: "idem-shared" },
    second: { nonce: NONCE_IDEM, signature: SANDBOX_VALID_SIGNATURE, idempotencyKey: "idem-shared" },
  },
  {
    scenario: "nonceReuse",
    first: { nonce: NONCE_REUSE, signature: SANDBOX_VALID_SIGNATURE, idempotencyKey: "ru-first", value: "1000" },
    // Same nonce, different valid signature over a different amount.
    second: {
      nonce: NONCE_REUSE,
      signature: SANDBOX_RESIGNED_SIGNATURE,
      idempotencyKey: "ru-second",
      value: "2000",
    },
  },
];

function flattenHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

function bodyDigest(body: ArrayBuffer): string {
  return createHash("sha256").update(Buffer.from(body)).digest("hex");
}

function isStatus(value: number): boolean {
  return Number.isInteger(value) && value >= 100 && value <= 599;
}

function emptyCaptures(): Record<ReplayScenarioName, ReplayScenarioCaptures> {
  const one = (): ReplayScenarioCaptures => ({
    first: { upstream: [], facilitator: [], cache: [] },
    second: { upstream: [], facilitator: [], cache: [] },
  });
  return { nonceReplay: one(), idempotencyKey: one(), nonceReuse: one() };
}

function buildAttempt(
  scenario: ReplayScenarioName,
  phase: "first" | "second",
  response: Response,
  body: ArrayBuffer,
  capture: ReplayCapture,
  contradictions: ReplayContradiction[],
  expectedCacheKey: string,
): ReplayAttempt {
  const status = response.status;
  if (!isStatus(status)) throw new Error(`probe ${scenario}/${phase} returned an out-of-range HTTP status: ${status}`);

  const settleCall = capture.facilitator.find(
    (call) => call.path === "/settle" || call.path.startsWith("/settle?"),
  );
  const settled = settleCall !== undefined && settleCall.status >= 200 && settleCall.status < 300;
  const upstreamCall = capture.upstream[0];
  const upstreamCalled = capture.upstream.length > 0;
  // Only a hit for this attempt's own key counts. A stray hit recorded for a
  // different key must never turn a reprocessed retry into a "cached" pass.
  const cacheHitRaw = capture.cache.some(
    (call) => call.method === "get" && call.hit && call.key === expectedCacheKey,
  );

  const cacheHit = cacheHitRaw && !settled && !upstreamCalled;
  if (cacheHitRaw && (settled || upstreamCalled)) {
    contradictions.push({ scenario, attempt: phase, cacheHitRaw, settled, upstreamCalled });
  }

  return {
    responseStatus: status,
    responseHeaders: flattenHeaders(response.headers),
    responseBodyHash: bodyDigest(body),
    settled,
    settlementStatus: settled ? (settleCall?.status ?? undefined) : undefined,
    upstreamCalled,
    upstreamStatus: upstreamCalled ? (upstreamCall?.status ?? undefined) : undefined,
    cacheHit,
  };
}

/**
 * Run all three replay scenarios against the built-in synthetic seller.
 * Logs are drained before every attempt, so a row belongs to exactly one
 * attempt with no correlation heuristics and no seller-supplied request id.
 */
export async function runReplayProbes(options: ReplayProbeOptions = {}): Promise<ReplayProbeResult> {
  const defect = options.defect ?? "none";
  if (!isC5Defect(defect)) throw new TypeError(`unknown replay defect: ${String(defect)}`);
  const timeoutMs = options.timeoutMs ?? 5000;
  // Node clamps oversized AbortSignal.timeout values into the platform timer
  // range; without an upper bound a config like 2**32 silently becomes 1 ms.
  const MAX_TIMEOUT_MS = 2_147_483_647;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new TypeError("timeoutMs must be a positive integer within the timer range");
  }

  const upstream = await startMockUpstream();
  let facilitator: Awaited<ReturnType<typeof startMockFacilitator>> | undefined;
  let cache: Awaited<ReturnType<typeof startMockCache>> | undefined;
  let seller: Awaited<ReturnType<typeof startReplaySeller>> | undefined;
  try {
    facilitator = await startMockFacilitator();
    cache = await startMockCache();
    seller = await startReplaySeller({
      upstreamUrl: upstream.url,
      facilitatorUrl: facilitator.url,
      cacheUrl: cache.url,
      defect,
      timeoutMs,
    });

    const observations: ReplayScenarioObservation[] = [];
    const captures = emptyCaptures();
    const contradictions: ReplayContradiction[] = [];

    for (const plan of SCENARIO_PLAN) {
      let first: ReplayAttempt | undefined;
      let second: ReplayAttempt | undefined;
      let firstCapture: ReplayCapture | undefined;
      let secondCapture: ReplayCapture | undefined;

      for (const phase of ["first", "second"] as const) {
        upstream.drain();
        facilitator.drain();
        cache.drain();

        const attemptPlan = plan[phase];
        const response = await fetch(`${seller.url}/v1/echo`, {
          method: "GET",
          headers: {
            accept: "application/json",
            "x-c5-probe": plan.scenario,
            "idempotency-key": attemptPlan.idempotencyKey,
            "payment-signature": replayPaymentHeader(attemptPlan),
          },
          signal: AbortSignal.timeout(timeoutMs),
          redirect: "manual",
        });
        const body = await response.arrayBuffer();
        const phaseCapture: ReplayCapture = {
          upstream: upstream.drain(),
          facilitator: facilitator.drain(),
          cache: cache.drain(),
        };
        const attempt = buildAttempt(
          plan.scenario,
          phase,
          response,
          body,
          phaseCapture,
          contradictions,
          `${plan.scenario}:${attemptPlan.idempotencyKey}`,
        );
        if (phase === "first") {
          first = attempt;
          firstCapture = phaseCapture;
        } else {
          second = attempt;
          secondCapture = phaseCapture;
        }
      }

      if (
        first === undefined ||
        second === undefined ||
        firstCapture === undefined ||
        secondCapture === undefined
      ) {
        throw new Error(`probe ${plan.scenario} did not produce two attempts`);
      }
      captures[plan.scenario] = { first: firstCapture, second: secondCapture };
      observations.push({ scenario: plan.scenario, first, second });
    }

    return {
      defect,
      observations,
      results: checkReplayIdempotency({ scenarios: observations }),
      captures,
      contradictions,
      endpoints: {
        seller: seller.url,
        upstream: upstream.url,
        facilitator: facilitator.url,
        cache: cache.url,
      },
    };
  } finally {
    // Attempt every shutdown even if one fails; surface the first failure so
    // a half-closed sandbox never looks like a clean run.
    const results = await Promise.allSettled([
      ...(seller === undefined ? [] : [seller.close()]),
      ...(cache === undefined ? [] : [cache.close()]),
      ...(facilitator === undefined ? [] : [facilitator.close()]),
      upstream.close(),
    ]);
    const failure = results.find((result) => result.status === "rejected");
    if (failure !== undefined && failure.status === "rejected") throw failure.reason;
  }
}
