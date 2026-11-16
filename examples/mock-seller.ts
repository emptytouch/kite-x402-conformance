/**
 * Demo seller for trying the checker without touching a real service or funds.
 *
 *   npm run example                 # valid 402 challenge on :8080
 *   DEMO_MODE=broken npm run example  # 402 with no PAYMENT-REQUIRED header
 *
 * The challenge below is synthetic: it advertises a placeholder payTo and asset.
 * It is not a payment destination and nothing here moves funds.
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
  accepts: [
    {
      scheme: "exact",
      network: "eip155:2368",
      asset: ASSET,
      payTo: PAY_TO,
      maxAmountRequired: "1000",
      resource: "http://localhost:8080/v1/echo",
      description: "synthetic demo quote",
      maxTimeoutSeconds: 60,
      extra: { name: "USDT", version: "1" },
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
  console.log(`try: node dist/cli.js check http://localhost:${port}/v1/echo`);
});
