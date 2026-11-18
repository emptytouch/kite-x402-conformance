/**
 * Demo seller for trying the checker without touching a real service or funds.
 *
 *   npm run example                   # valid v2 402 challenge on :8080
 *   DEMO_MODE=broken npm run example  # 402 with no PAYMENT-REQUIRED header
 *
 * The challenge is shaped exactly as x402 v2 expects — `resource` at the top
 * level, `amount`/`maxTimeoutSeconds`/`extra` inside the option — because a demo
 * that gets the shape wrong teaches the wrong shape. The payTo and asset are
 * placeholders: they belong to nobody and nothing here moves funds. `extra.name`
 * is deliberately synthetic so no one mistakes this for a real token's domain.
 */
import { createServer } from "node:http";

import { encodeHeaderValue } from "../src/wire.js";

const port = Number.parseInt(process.env["PORT"] ?? "8080", 10);
const mode = process.env["DEMO_MODE"] ?? "valid";

const PAY_TO = "0x1234567890123456789012345678901234567890";
const ASSET = "0x0f5d2fb29fb7d3cfee444a200298f468908cc942";

const challenge = {
  x402Version: 2,
  error: "payment required",
  resource: {
    url: `http://localhost:${port}/v1/echo`,
    description: "synthetic demo quote",
    mimeType: "application/json",
  },
  accepts: [
    {
      scheme: "exact",
      network: "eip155:2368",
      asset: ASSET,
      payTo: PAY_TO,
      amount: "1000",
      maxTimeoutSeconds: 120,
      extra: { name: "Demo USD", version: "1" },
    },
  ],
};

const server = createServer((request, response) => {
  const paidPath = request.url?.startsWith("/v1/") ?? false;

  if (!paidPath) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ok" }));
    return;
  }

  if (mode === "broken") {
    response.writeHead(402, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "payment required" }));
    return;
  }

  response.writeHead(402, {
    "content-type": "application/json",
    "payment-required": encodeHeaderValue(challenge),
  });
  response.end(JSON.stringify({ error: "payment required" }));
});

server.listen(port, () => {
  console.log(`demo seller on http://localhost:${port} (mode=${mode})`);
  console.log(`try: npm run dev -- check http://localhost:${port}/v1/echo`);
  console.log(`then: npm run example:pay`);
});
