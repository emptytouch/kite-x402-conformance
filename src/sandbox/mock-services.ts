/**
 * Independent mock upstream and facilitator for the C4 probe runner.
 *
 * These are separate HTTP services, not objects inside the seller. That
 * separation is the point: the runner reads their request logs to build
 * ProbeObservation[] instead of trusting headers the seller reports about
 * itself. A seller can write "settled: true" in its own response; it cannot
 * insert a row into a facilitator log it does not own.
 *
 * The facilitator deliberately accepts every /settle call. C4 tests the
 * seller's *decision* to settle, not the facilitator's authentication.
 */

import { createServer, type IncomingMessage, type RequestListener, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** Marker signature the mock facilitator accepts. Never a real ECDSA signature. */
export const SANDBOX_VALID_SIGNATURE = `0x${"11".repeat(65)}`;
/**
 * A second, distinct marker the facilitator also accepts. C5's nonceReuse
 * probe re-signs the same nonce: without a different-but-valid signature the
 * probe would only test "invalid signature", not "valid signature over a
 * consumed nonce". C4 keeps using SANDBOX_VALID_SIGNATURE / _INVALID_.
 */
export const SANDBOX_RESIGNED_SIGNATURE = `0x${"33".repeat(65)}`;
export const SANDBOX_VALID_SIGNATURES = [SANDBOX_VALID_SIGNATURE, SANDBOX_RESIGNED_SIGNATURE] as const;
/** Marker signature the mock facilitator rejects. */
export const SANDBOX_INVALID_SIGNATURE = `0x${"22".repeat(65)}`;
/** Deterministic synthetic receipt hash; corresponds to no chain or transaction. */
export const SANDBOX_TX_HASH = `0x${"ab".repeat(32)}`;

export interface CapturedRequest {
  readonly method: string;
  readonly path: string;
  readonly status: number;
}

/** One idempotency-cache lookup, recorded by an independent cache service. */
export interface CacheRequest {
  readonly method: "get" | "put";
  readonly key: string;
  readonly hit: boolean;
}

/** A cached HTTP response. Validated on write so reads are trustworthy. */
export interface CacheValue {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: string;
}

export interface MockCache {
  readonly url: string;
  drain(): readonly CacheRequest[];
  close(): Promise<void>;
}

export interface MockService {
  /** Base URL, e.g. http://127.0.0.1:43210. */
  readonly url: string;
  /** Return and clear everything captured so far. */
  drain(): readonly CapturedRequest[];
  close(): Promise<void>;
}

async function listen(handler: RequestListener): Promise<{ server: Server; url: string }> {
  const server = createServer(handler);
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
    throw new Error("mock service did not bind to a TCP port");
  }
  return { server, url: `http://127.0.0.1:${address.port}` };
}

/** Force-close idle sockets so Node's keep-alive does not hang shutdown. */
async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeIdleConnections();
  });
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function record(captures: CapturedRequest[], request: IncomingMessage, status: number): void {
  captures.push({
    method: request.method ?? "GET",
    path: request.url ?? "/",
    status,
  });
}

async function readSignature(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string | Uint8Array);
    size += buffer.byteLength;
    if (size > 64 * 1024) return "";
    chunks.push(buffer);
  }
  if (chunks.length === 0) return "";
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { readonly signature?: unknown };
    return typeof body["signature"] === "string" ? body["signature"] : "";
  } catch {
    return "";
  }
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string | Uint8Array);
    size += buffer.byteLength;
    if (size > 256 * 1024) return {};
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return asObject(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown) ?? {};
  } catch {
    return {};
  }
}

function parseCacheValue(value: unknown): CacheValue | undefined {
  const record = asObject(value);
  if (record === undefined) return undefined;
  const status = record["status"];
  if (typeof status !== "number" || !Number.isInteger(status) || status < 100 || status > 599) return undefined;
  const headers = asObject(record["headers"]);
  if (headers === undefined) return undefined;
  if (typeof record["body"] !== "string") return undefined;
  const cleanHeaders: Record<string, string> = {};
  for (const [key, entry] of Object.entries(headers)) {
    if (typeof entry !== "string") return undefined;
    cleanHeaders[key] = entry;
  }
  return { status, headers: cleanHeaders, body: record["body"] };
}

export async function startMockUpstream(): Promise<MockService> {
  const captures: CapturedRequest[] = [];
  const handler: RequestListener = (request, response) => {
    const path = request.url ?? "/";
    if (path === "/v1/echo") {
      sendJson(response, 200, { echo: true, source: "mock-upstream" });
      record(captures, request, 200);
    } else if (path === "/v1/error") {
      sendJson(response, 503, { error: "upstream unavailable" });
      record(captures, request, 503);
    } else {
      sendJson(response, 404, { error: "not found" });
      record(captures, request, 404);
    }
  };
  const started = await listen(handler);
  return {
    url: started.url,
    drain: () => captures.splice(0, captures.length),
    close: () => closeServer(started.server),
  };
}

export async function startMockFacilitator(): Promise<MockService> {
  const captures: CapturedRequest[] = [];
  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const path = (request.url ?? "/").split("?")[0] ?? "/";
    if (request.method === "POST" && path === "/verify") {
      const signature = await readSignature(request);
      const isValid = (SANDBOX_VALID_SIGNATURES as readonly string[]).includes(signature);
      sendJson(response, 200, { isValid });
      record(captures, request, 200);
      return;
    }
    if (request.method === "POST" && path === "/settle") {
      // Deliberately unconditional: C4 must observe whether the seller
      // called settle at all, not whether this mock approved the call.
      sendJson(response, 200, { success: true, transactionHash: SANDBOX_TX_HASH });
      record(captures, request, 200);
      return;
    }
    sendJson(response, 404, { error: "not found" });
    record(captures, request, 404);
  };
  const handler: RequestListener = (request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) sendJson(response, 500, { error: "mock facilitator failure" });
      record(captures, request, 500);
    });
  };
  const started = await listen(handler);
  return {
    url: started.url,
    drain: () => captures.splice(0, captures.length),
    close: () => closeServer(started.server),
  };
}

/**
 * Independent idempotency cache for the C5 runner.
 *
 * LIKE the facilitator, this is a separate HTTP service: the runner reads its
 * lookup log to decide `cacheHit`. A seller can write a "cache: hit" header
 * into its own response; it cannot insert a `hit: true` row into this log
 * without actually performing the lookup. That asymmetry is the C5 trust
 * boundary, and it is what makes a self-reported cache hit testable.
 */
export async function startMockCache(): Promise<MockCache> {
  const store = new Map<string, CacheValue>();
  const captures: CacheRequest[] = [];

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const path = (request.url ?? "/").split("?")[0] ?? "/";
    if (!path.startsWith("/cache/")) {
      sendJson(response, 404, { error: "not found" });
      return;
    }
    let key: string;
    try {
      key = decodeURIComponent(path.slice("/cache/".length));
    } catch {
      sendJson(response, 400, { error: "invalid key" });
      return;
    }
    if (key.length === 0) {
      sendJson(response, 400, { error: "empty key" });
      return;
    }

    if (request.method === "GET") {
      const value = store.get(key);
      captures.push({ method: "get", key, hit: value !== undefined });
      sendJson(response, 200, value === undefined ? { hit: false } : { hit: true, value });
      return;
    }
    if (request.method === "PUT") {
      const value = parseCacheValue(await readJsonBody(request));
      if (value === undefined) {
        sendJson(response, 400, { error: "invalid cache value" });
        return;
      }
      store.set(key, value);
      captures.push({ method: "put", key, hit: false });
      sendJson(response, 200, { ok: true });
      return;
    }
    sendJson(response, 405, { error: "method not allowed" });
  };

  const handler: RequestListener = (request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) sendJson(response, 500, { error: "mock cache failure" });
    });
  };
  const started = await listen(handler);
  return {
    url: started.url,
    drain: () => captures.splice(0, captures.length),
    close: () => closeServer(started.server),
  };
}
