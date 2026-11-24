/**
 * Synthetic seller under test. It is the *subject* of C4, not part of the
 * checker: the runner points it at independent mock upstream/facilitator
 * services and reads those services' logs for its observations.
 *
 * `defect` injects one settlement-order bug at a time so a test can prove the
 * checker actually catches it. `forged-claim` is the important control: the
 * seller writes a valid-looking PAYMENT-RESPONSE header without ever calling
 * the facilitator. A checker that trusts seller headers would pass it; C4
 * must fail it on `c4.upstream-success.settled`.
 *
 * Nothing here signs anything. The "signature" is a marker the mock
 * facilitator recognises; real signature validity is C3's job.
 */

import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { decodeHeaderValue, encodeHeaderValue, findHeader } from "../wire.js";
import { SANDBOX_INVALID_SIGNATURE, SANDBOX_TX_HASH, SANDBOX_VALID_SIGNATURE } from "./mock-services.js";

export const SANDBOX_DEFECTS = [
  "none",
  "free-access",
  "forged-signature",
  "charge-on-error",
  "skip-settlement",
  "bad-receipt",
  "forged-claim",
] as const;

export type SandboxDefect = (typeof SANDBOX_DEFECTS)[number];

export function isSandboxDefect(value: unknown): value is SandboxDefect {
  return typeof value === "string" && SANDBOX_DEFECTS.includes(value as SandboxDefect);
}

export interface SandboxSeller {
  readonly url: string;
  close(): Promise<void>;
}

const PAY_TO = "0x1234567890123456789012345678901234567890";
const ASSET = "0x0f5d2fb29fb7d3cfee444a200298f468908cc942";

/** Header value used by the runner for authorised probes. */
export function sandboxPaymentSignature(valid: boolean): string {
  return encodeHeaderValue({
    x402Version: 2,
    scheme: "exact",
    network: "eip155:2368",
    accepted: { scheme: "exact", network: "eip155:2368", asset: ASSET, payTo: PAY_TO, amount: "1000" },
    payload: {
      authorization: {
        from: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
        to: PAY_TO,
        value: "1000",
        validAfter: "0",
        validBefore: "4102444800",
        nonce: `0x${"01".repeat(32)}`,
      },
      signature: valid ? SANDBOX_VALID_SIGNATURE : SANDBOX_INVALID_SIGNATURE,
    },
  });
}

function challengeHeader(): string {
  return encodeHeaderValue({
    x402Version: 2,
    error: "payment required",
    resource: { url: "http://127.0.0.1/v1/echo", description: "sandbox seller", mimeType: "application/json" },
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

function flatten(headers: IncomingHttpHeaders): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") result[key] = value;
    else if (Array.isArray(value) && value.length > 0) result[key] = value.join(", ");
  }
  return result;
}

function extractSignature(header: string): string {
  const decoded = decodeHeaderValue(header);
  if (!decoded.ok) return "";
  if (typeof decoded.value !== "object" || decoded.value === null) return "";
  const payload = (decoded.value as { readonly payload?: unknown }).payload;
  if (typeof payload !== "object" || payload === null) return "";
  const signature = (payload as { readonly signature?: unknown }).signature;
  return typeof signature === "string" ? signature : "";
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
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export async function startSandboxSeller(options: {
  readonly upstreamUrl: string;
  readonly facilitatorUrl: string;
  readonly defect: SandboxDefect;
  readonly timeoutMs?: number;
}): Promise<SandboxSeller> {
  const timeoutMs = options.timeoutMs ?? 2000;
  const { defect } = options;

  const handle = async (request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse): Promise<void> => {
    const path = (request.url ?? "/").split("?")[0] ?? "/";
    const headerValues = flatten(request.headers);

    const finish = (status: number, body: unknown, headers: Record<string, string> = {}): void => {
      const outbound = { ...headers };
      // The adversarial control: claim a receipt that was never earned.
      if (defect === "forged-claim") {
        outbound["payment-response"] = encodeHeaderValue({ settlement: { txHash: SANDBOX_TX_HASH } });
      }
      response.writeHead(status, { "content-type": "application/json", ...outbound });
      response.end(JSON.stringify(body));
    };

    if (path !== "/v1/echo" && path !== "/v1/error") {
      finish(200, { status: "ok" });
      return;
    }

    let authorised = false;
    const paymentHeader = findHeader(headerValues, "payment-signature");
    if (paymentHeader === undefined) {
      authorised = defect === "free-access";
    } else {
      const verdict = await postJson(`${options.facilitatorUrl}/verify`, {
        signature: extractSignature(paymentHeader),
      }, timeoutMs);
      authorised = verdict["isValid"] === true || defect === "forged-signature";
    }

    if (!authorised) {
      finish(402, { error: "payment required" }, { "payment-required": challengeHeader() });
      return;
    }

    const upstream = await fetch(`${options.upstreamUrl}${path}`, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "manual",
    });
    const upstreamStatus = upstream.status;
    await upstream.arrayBuffer();

    if (upstreamStatus >= 400) {
      if (defect === "charge-on-error") await postJson(`${options.facilitatorUrl}/settle`, { path }, timeoutMs);
      finish(upstreamStatus, { error: "upstream failed" });
      return;
    }
    if (upstreamStatus < 200 || upstreamStatus >= 300) {
      finish(502, { error: "unexpected upstream status" });
      return;
    }

    let receipt: Record<string, string> = {};
    if (defect !== "skip-settlement" && defect !== "forged-claim") {
      const settlement = await postJson(`${options.facilitatorUrl}/settle`, { path }, timeoutMs);
      const txHash = typeof settlement["transactionHash"] === "string" ? settlement["transactionHash"] : SANDBOX_TX_HASH;
      const value = defect === "bad-receipt" ? "not-a-transaction-hash" : txHash;
      receipt = { "payment-response": encodeHeaderValue({ settlement: { txHash: value } }) };
    }
    finish(200, { ok: true, source: "sandbox-seller" }, receipt);
  };

  const server: Server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "sandbox seller failure" }));
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo | null;
  if (address === null || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("sandbox seller did not bind to a TCP port");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeIdleConnections();
      });
    },
  };
}
