/**
 * Stateful synthetic seller under test for C5.
 *
 * Unlike the C4 seller, this one keeps state across requests: consumed
 * signatures, consumed nonces and an idempotency cache. It talks to three
 * independent HTTP services (upstream, facilitator, cache) so the runner can
 * build observations from their logs instead of from what this seller says
 * about itself.
 *
 * `defect` injects one replay/idempotency bug at a time. Two controls matter:
 * `idem-cached-rebill` looks like a cache hit to the client while really
 * settling and forwarding again, and `idem-no-cache` writes a "cache: hit"
 * claim into its response although the cache log shows a miss. A checker that
 * trusts seller headers passes both; C5 must fail them.
 *
 * The `x-c5-probe` header is internal sandbox wiring that tells this synthetic
 * seller which scenario a request belongs to. It is not an x402 header and is
 * never present in a real client.
 */

import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { decodeHeaderValue, encodeHeaderValue, findHeader } from "../wire.js";
import { SANDBOX_TX_HASH } from "./mock-services.js";

export const C5_DEFECTS = [
  "none",
  "nonce-rebill",
  "idem-no-cache",
  "idem-cached-rebill",
  "nonce-reuse-bypass",
  "bad-receipt",
  "forged-claim",
  "first-not-settled",
] as const;

export type C5Defect = (typeof C5_DEFECTS)[number];

export function isC5Defect(value: unknown): value is C5Defect {
  return typeof value === "string" && (C5_DEFECTS as readonly string[]).includes(value);
}

export const REPLAY_SCENARIOS = ["nonceReplay", "idempotencyKey", "nonceReuse"] as const;
export type ReplayScenario = (typeof REPLAY_SCENARIOS)[number];

export function isReplayScenario(value: unknown): value is ReplayScenario {
  return typeof value === "string" && (REPLAY_SCENARIOS as readonly string[]).includes(value);
}

const PAY_TO = "0x1234567890123456789012345678901234567890";
const ASSET = "0x0f5d2fb29fb7d3cfee444a200298f468908cc942";

export interface ReplayPaymentOptions {
  readonly nonce: string;
  readonly signature: string;
  readonly value?: string;
}

/** Build a PAYMENT-SIGNATURE marker for one C5 attempt. */
export function replayPaymentHeader(options: ReplayPaymentOptions): string {
  return encodeHeaderValue({
    x402Version: 2,
    scheme: "exact",
    network: "eip155:2368",
    accepted: { scheme: "exact", network: "eip155:2368", asset: ASSET, payTo: PAY_TO, amount: "1000" },
    payload: {
      authorization: {
        from: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
        to: PAY_TO,
        value: options.value ?? "1000",
        validAfter: "0",
        validBefore: "4102444800",
        nonce: options.nonce,
      },
      signature: options.signature,
    },
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

interface PaymentMarker {
  readonly nonce: string;
  readonly signature: string;
}

function decodePayment(header: string): PaymentMarker | undefined {
  const decoded = decodeHeaderValue(header);
  if (!decoded.ok) return undefined;
  const document = asRecord(decoded.value);
  const payload = asRecord(document?.["payload"]);
  const authorization = asRecord(payload?.["authorization"]);
  const nonce = authorization?.["nonce"];
  const signature = payload?.["signature"];
  if (typeof nonce !== "string" || nonce.length === 0) return undefined;
  if (typeof signature !== "string" || signature.length === 0) return undefined;
  return { nonce, signature };
}

function flatten(headers: IncomingHttpHeaders): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") result[key] = value;
    else if (Array.isArray(value) && value.length > 0) result[key] = value.join(", ");
  }
  return result;
}

function challengeHeader(): string {
  return encodeHeaderValue({
    x402Version: 2,
    error: "payment required",
    resource: { url: "http://127.0.0.1/v1/echo", description: "replay sandbox seller", mimeType: "application/json" },
    accepts: [
      {
        scheme: "exact",
        network: "eip155:2368",
        asset: ASSET,
        payTo: PAY_TO,
        amount: "1000",
        maxTimeoutSeconds: 120,
        extra: { name: "Sandbox USD", version: "1" },
      },
    ],
  });
}

async function postJson(url: string, body: unknown, timeoutMs: number): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "manual",
  });
  const text = await response.text();
  if (text.length === 0) return {};
  try {
    return asRecord(JSON.parse(text) as unknown) ?? {};
  } catch {
    return {};
  }
}

interface CachedResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: string;
}

function readCachedResponse(value: unknown): CachedResponse | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const status = record["status"];
  if (typeof status !== "number" || !Number.isInteger(status) || status < 100 || status > 599) return undefined;
  const headers = asRecord(record["headers"]);
  const body = record["body"];
  if (headers === undefined || typeof body !== "string") return undefined;
  const clean: Record<string, string> = {};
  for (const [name, entry] of Object.entries(headers)) {
    if (typeof entry !== "string") return undefined;
    clean[name] = entry;
  }
  return { status, headers: clean, body };
}

async function cacheGet(cacheUrl: string, key: string, timeoutMs: number): Promise<CachedResponse | undefined> {
  const response = await fetch(`${cacheUrl}/cache/${encodeURIComponent(key)}`, {
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "manual",
  });
  const text = await response.text();
  if (text.length === 0) return undefined;
  let parsed: Record<string, unknown>;
  try {
    parsed = asRecord(JSON.parse(text) as unknown) ?? {};
  } catch {
    return undefined;
  }
  if (parsed["hit"] !== true) return undefined;
  return readCachedResponse(parsed["value"]);
}

async function cachePut(cacheUrl: string, key: string, value: CachedResponse, timeoutMs: number): Promise<void> {
  await fetch(`${cacheUrl}/cache/${encodeURIComponent(key)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "manual",
  });
}

export interface ReplaySeller {
  readonly url: string;
  close(): Promise<void>;
}

export async function startReplaySeller(options: {
  readonly upstreamUrl: string;
  readonly facilitatorUrl: string;
  readonly cacheUrl: string;
  readonly defect: C5Defect;
  readonly timeoutMs?: number;
}): Promise<ReplaySeller> {
  const timeoutMs = options.timeoutMs ?? 2000;
  const { defect } = options;
  // State is isolated per scenario. All three probes share one seller
  // instance, but they are independent tests: a signature consumed in one
  // scenario must not make another scenario's *first* attempt look like a
  // replay. A flat Set made correctness depend on SCENARIO_PLAN's order.
  const seenSignatures = new Map<ReplayScenario, Set<string>>();
  const seenNonces = new Map<ReplayScenario, Set<string>>();
  const signaturesFor = (scene: ReplayScenario): Set<string> => {
    let set = seenSignatures.get(scene);
    if (set === undefined) {
      set = new Set<string>();
      seenSignatures.set(scene, set);
    }
    return set;
  };
  const noncesFor = (scene: ReplayScenario): Set<string> => {
    let set = seenNonces.get(scene);
    if (set === undefined) {
      set = new Set<string>();
      seenNonces.set(scene, set);
    }
    return set;
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const path = (request.url ?? "/").split("?")[0] ?? "/";
    const headerValues = flatten(request.headers);

    const finish = (status: number, body: string, headers: Record<string, string> = {}): void => {
      response.writeHead(status, { "content-type": "application/json", ...headers });
      response.end(body);
    };
    const reject = (): void => {
      finish(402, JSON.stringify({ error: "payment required" }), { "payment-required": challengeHeader() });
    };

    if (path !== "/v1/echo") {
      finish(404, JSON.stringify({ error: "not found" }));
      return;
    }
    const scene = headerValues["x-c5-probe"];
    if (!isReplayScenario(scene)) {
      finish(400, JSON.stringify({ error: "missing or unknown x-c5-probe" }));
      return;
    }
    const paymentHeader = findHeader(headerValues, "payment-signature");
    if (paymentHeader === undefined) {
      reject();
      return;
    }
    const payment = decodePayment(paymentHeader);
    if (payment === undefined) {
      reject();
      return;
    }

    const idemKey = findHeader(headerValues, "idempotency-key") ?? `${scene}:default`;
    const cacheKey = `${scene}:${idemKey}`;
    // "second time this signed payload was seen" must be per signature, not a
    // global request counter: all three scenarios share one seller instance.
    const sceneSignatures = signaturesFor(scene);
    const sceneNonces = noncesFor(scene);
    const repeatRequest = sceneSignatures.has(payment.signature);
    const cacheDisabled = scene === "idempotencyKey" && defect === "idem-no-cache" && repeatRequest;
    const cached = cacheDisabled ? undefined : await cacheGet(options.cacheUrl, cacheKey, timeoutMs);

    if (cached !== undefined) {
      // Contradiction control: the client sees a cache hit while the
      // facilitator and upstream logs both show fresh side effects.
      if (scene === "idempotencyKey" && defect === "idem-cached-rebill") {
        await postJson(`${options.facilitatorUrl}/settle`, { scene }, timeoutMs);
        await fetch(`${options.upstreamUrl}/v1/echo`, {
          signal: AbortSignal.timeout(timeoutMs),
          redirect: "manual",
        });
      }
      finish(cached.status, cached.body, { ...cached.headers, "x-c5-cache-claim": "hit" });
      return;
    }

    const replayedSignature = sceneSignatures.has(payment.signature);
    const reusedNonce = sceneNonces.has(payment.nonce);
    let shouldReject = false;
    if (scene === "nonceReplay" && replayedSignature) {
      shouldReject = defect !== "nonce-rebill";
    } else if (scene === "nonceReuse" && reusedNonce) {
      shouldReject = defect !== "nonce-reuse-bypass";
    } else if (cacheDisabled) {
      // Dedup relies solely on a key that never hits, but the response still
      // claims a hit. The runner must trust the cache log instead.
      shouldReject = false;
    }
    if (shouldReject) {
      reject();
      return;
    }

    const verdict = await postJson(
      `${options.facilitatorUrl}/verify`,
      { signature: payment.signature },
      timeoutMs,
    );
    if (verdict["isValid"] !== true) {
      reject();
      return;
    }

    if (defect !== "first-not-settled" && defect !== "forged-claim") {
      await postJson(`${options.facilitatorUrl}/settle`, { scene }, timeoutMs);
    }

    sceneSignatures.add(payment.signature);
    sceneNonces.add(payment.nonce);

    const upstream = await fetch(`${options.upstreamUrl}/v1/echo`, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "manual",
    });
    await upstream.arrayBuffer();
    if (upstream.status < 200 || upstream.status >= 300) {
      finish(502, JSON.stringify({ error: "unexpected upstream status" }));
      return;
    }

    const txHash = defect === "bad-receipt" ? "not-a-transaction-hash" : SANDBOX_TX_HASH;
    const body = JSON.stringify({ ok: true, source: "replay-seller", nonce: payment.nonce });
    // A service that never settled has no receipt to echo. This keeps
    // first-not-settled distinct from forged-claim, which fabricates one.
    const headers: Record<string, string> =
      defect === "first-not-settled"
        ? {}
        : { "payment-response": encodeHeaderValue({ settlement: { txHash } }) };
    if (cacheDisabled) {
      // A false claim the runner must ignore: no cache lookup happened at all.
      headers["x-c5-cache-claim"] = "hit";
    }
    await cachePut(options.cacheUrl, cacheKey, { status: 200, headers, body }, timeoutMs);
    finish(200, body, headers);
  };

  const server: Server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "replay seller failure" }));
      }
    });
  });
  await new Promise<void>((resolve, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectPromise);
      resolve();
    });
  });
  const address = server.address() as AddressInfo | null;
  if (address === null || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("replay seller did not bind to a TCP port");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve, rejectPromise) => {
        server.close((error) => (error ? rejectPromise(error) : resolve()));
        server.closeIdleConnections();
      });
    },
  };
}
