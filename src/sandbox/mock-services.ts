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
/** Marker signature the mock facilitator rejects. */
export const SANDBOX_INVALID_SIGNATURE = `0x${"22".repeat(65)}`;
/** Deterministic synthetic receipt hash; corresponds to no chain or transaction. */
export const SANDBOX_TX_HASH = `0x${"ab".repeat(32)}`;

export interface CapturedRequest {
  readonly method: string;
  readonly path: string;
  readonly status: number;
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
      const isValid = signature === SANDBOX_VALID_SIGNATURE;
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
