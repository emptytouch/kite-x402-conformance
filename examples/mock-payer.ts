/**
 * Demo payer: build and sign a real EIP-3009 authorisation for the demo seller.
 *
 *   npm run example            # terminal 1: the seller
 *   npm run example:pay        # terminal 2: prints one PAYMENT-SIGNATURE value
 *   npm run dev -- authorize http://localhost:8080/v1/echo --payment-signature "$(npm run example:pay --silent)"
 *
 * The key below is Hardhat account #1 — published in every copy of the Hardhat
 * docs, holds nothing, and is used here only so the signature is reproducible.
 * Nothing in this file touches a network: it reads a 402 challenge over HTTP and
 * signs locally.
 *
 * Everything this script prints to stdout is the header value; progress goes to
 * stderr, so `--silent` capture works.
 */
import { toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { chainIdFromNetworkField } from "../src/networks.js";
import { TRANSFER_WITH_AUTHORIZATION_TYPES } from "../src/eip712.js";
import { decodeHeaderValue, encodeHeaderValue } from "../src/wire.js";
import { asRecord, pickPaymentOption, pickRecord, pickString } from "../src/checks/parse.js";

const DEMO_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

const url = process.argv[2] ?? "http://localhost:8080/v1/echo";
const account = privateKeyToAccount(DEMO_KEY);

function log(message: string): void {
  process.stderr.write(`${message}\n`);
}

function randomNonce(): `0x${string}` {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

async function main(): Promise<void> {
  const response = await fetch(url);
  if (response.status !== 402) {
    log(`expected 402 from ${url}, got ${response.status}`);
    process.exitCode = 1;
    return;
  }

  const headerValue = response.headers.get("payment-required");
  if (headerValue === null) {
    log("the response has no PAYMENT-REQUIRED header; try DEMO_MODE=broken to see that case");
    process.exitCode = 1;
    return;
  }

  const decoded = decodeHeaderValue(headerValue);
  if (!decoded.ok) {
    log(`cannot decode the challenge: ${decoded.error}`);
    process.exitCode = 1;
    return;
  }

  const envelope = asRecord(decoded.value);
  const option = envelope === undefined ? undefined : pickPaymentOption(envelope);
  if (option === undefined) {
    log("the challenge carries no payment option");
    process.exitCode = 1;
    return;
  }

  const extra = pickRecord(option, ["extra", "eip712", "domain"]);
  const name = extra === undefined ? undefined : pickString(extra, ["name"]);
  const version = extra === undefined ? undefined : pickString(extra, ["version"]);
  const networkRaw = option["network"] ?? option["chainId"];
  const chainId = chainIdFromNetworkField(networkRaw);
  const asset = pickString(option, ["asset", "token"]);
  const payTo = pickString(option, ["payTo", "payToAddress", "recipient"]);
  const amount = pickString(option, ["amount", "maxAmountRequired", "maxAmount", "price"]);
  const maxTimeoutSeconds = Number.parseInt(pickString(option, ["maxTimeoutSeconds"]) ?? "60", 10);

  const missing: string[] = [];
  if (name === undefined) missing.push("extra.name");
  if (version === undefined) missing.push("extra.version");
  if (chainId === undefined) missing.push("network");
  if (asset === undefined) missing.push("asset");
  if (payTo === undefined) missing.push("payTo");
  if (amount === undefined) missing.push("amount");
  if (missing.length > 0) {
    log(`the challenge cannot be paid as advertised; missing ${missing.join(", ")}`);
    process.exitCode = 1;
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  const authorization = {
    from: account.address,
    to: payTo as `0x${string}`,
    value: BigInt(amount as string),
    validAfter: 0n,
    validBefore: BigInt(now + maxTimeoutSeconds),
    nonce: randomNonce(),
  };

  const signature = await account.signTypedData({
    domain: {
      name: name as string,
      version: version as string,
      chainId: chainId as number,
      verifyingContract: asset as `0x${string}`,
    },
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message: authorization,
  });

  const paymentPayload = {
    x402Version: 2,
    resource: envelope?.["resource"],
    accepted: option,
    payload: {
      authorization: {
        ...authorization,
        value: authorization.value.toString(),
        validAfter: authorization.validAfter.toString(),
        validBefore: authorization.validBefore.toString(),
      },
      signature,
    },
  };

  log(
    `signed ${authorization.value} atomic units for ${payTo} on chain ${chainId} ` +
      `(name="${name}" version="${version}", expires in ${maxTimeoutSeconds}s)`,
  );
  log(`payer ${account.address} — the public Hardhat test key, holds nothing`);
  log("");
  process.stdout.write(`${encodeHeaderValue(paymentPayload)}\n`);
}

main().catch((error: unknown) => {
  log(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
