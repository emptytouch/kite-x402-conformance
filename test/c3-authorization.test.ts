import { concat, encodeAbiParameters, numberToHex, recoverAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";

import { checkAuthorization, parseAuthorization, type AuthorizationInput } from "../src/checks/c3-authorization.js";
import type { CheckResult } from "../src/checks/types.js";
import {
  eip3009Digest,
  SECP256K1_N,
  TRANSFER_WITH_AUTHORIZATION_TYPES,
  type Eip712Domain,
} from "../src/eip712.js";
import { encodeHeaderValue } from "../src/wire.js";

const PAY_TO = "0x1234567890123456789012345678901234567890";
const ASSET = "0x0f5d2fb29fb7d3cfee444a200298f468908cc942";
const NONCE = "0x00000000000000000000000000000000000000000000000000000000deadbeef";
const ERC6492_MAGIC = "0x6492649264926492649264926492649264926492649264926492649264926492";

/** Fixed point in time so every window assertion is reproducible. */
const NOW = 1_700_000_000;

// Hardhat account #1 — public test key, no funds; used so fixtures are stable.
const account = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");

const baseDomain: Eip712Domain = {
  name: "pieUSD",
  version: "1",
  chainId: 2368,
  verifyingContract: ASSET,
};

function option(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    scheme: "exact",
    network: "eip155:2368",
    asset: ASSET,
    payTo: PAY_TO,
    amount: "1000",
    maxTimeoutSeconds: 60,
    extra: { name: baseDomain.name, version: baseDomain.version },
    ...overrides,
  };
}

function challenge(optionOverrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    x402Version: 2,
    resource: { url: "http://localhost:8080/v1/echo", description: "test" },
    accepts: [option(optionOverrides)],
  };
}

interface PaymentOptions {
  readonly auth?: Record<string, unknown>;
  readonly domain?: Partial<Eip712Domain>;
  readonly accepted?: Record<string, unknown> | null;
  readonly signatureMutator?: (signature: string) => string;
}

async function payment(options: PaymentOptions = {}): Promise<Record<string, unknown>> {
  const authorization: Record<string, unknown> = {
    from: account.address,
    to: PAY_TO,
    value: "1000",
    validAfter: "0",
    validBefore: String(NOW + 60),
    nonce: NONCE,
    ...options.auth,
  };

  const signature = await account.signTypedData({
    domain: { ...baseDomain, ...options.domain },
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from: authorization["from"] as `0x${string}`,
      to: authorization["to"] as `0x${string}`,
      value: BigInt(String(authorization["value"])),
      validAfter: BigInt(String(authorization["validAfter"])),
      validBefore: BigInt(String(authorization["validBefore"])),
      nonce: authorization["nonce"] as `0x${string}`,
    },
  });

  const payload: Record<string, unknown> = {
    x402Version: 2,
    resource: { url: "http://localhost:8080/v1/echo", description: "test" },
    accepted: options.accepted === undefined ? option() : options.accepted,
    payload: {
      authorization,
      signature: options.signatureMutator ? options.signatureMutator(signature) : signature,
    },
  };
  if (options.accepted === null) delete payload["accepted"];
  return payload;
}

function input(
  challengePayload: unknown,
  paymentPayload: unknown,
  extra: Partial<AuthorizationInput> = {},
): AuthorizationInput {
  const base: AuthorizationInput = {
    challengeHeader: encodeHeaderValue(challengePayload),
    paymentHeader: encodeHeaderValue(paymentPayload),
    expectedNetwork: "testnet",
    now: NOW,
    ...extra,
  };
  return base;
}

function byId(results: readonly CheckResult[]): Record<string, CheckResult> {
  return Object.fromEntries(results.map((result) => [result.id, result]));
}

const ALL_IDS = [
  "c3.challenge",
  "c3.payment",
  "c3.payload-version",
  "c3.payload-shape",
  "c3.accepted-binding",
  "c3.binding-payto",
  "c3.binding-value",
  "c3.address-sanity",
  "c3.domain-config",
  "c3.window",
  "c3.window-span",
  "c3.signature-format",
  "c3.signature-low-s",
  "c3.signature-recovery",
] as const;

describe("C3 — authorisation", () => {
  it("passes a well-formed payment and reports all 14 assertions", async () => {
    const results = await checkAuthorization(input(challenge(), await payment()));
    expect(results.map((result) => result.id)).toEqual([...ALL_IDS]);
    const failed = results.filter((result) => result.status === "fail");
    expect(failed).toEqual([]);
    expect(results.filter((result) => result.status === "skip")).toEqual([]);
  });

  it("reports the same 14 ids in the same order on every path", async () => {
    const wrapped = await payment({
      signatureMutator: (signature) =>
        concat([
          encodeAbiParameters(
            [{ type: "address" }, { type: "bytes" }, { type: "bytes" }],
            ["0xcafebabecafebabecafebabecafebabecafebabe", "0x", signature as `0x${string}`],
          ),
          ERC6492_MAGIC,
        ]),
    });

    const cases: ReadonlyArray<readonly [string, AuthorizationInput]> = [
      ["valid", input(challenge(), await payment())],
      ["no challenge", { ...input(challenge(), await payment()), challengeHeader: undefined }],
      ["undecodable challenge", { ...input(challenge(), await payment()), challengeHeader: "@@@" }],
      ["challenge without options", input({ x402Version: 2 }, await payment())],
      ["no payment", { ...input(challenge(), await payment()), paymentHeader: undefined }],
      ["undecodable payment", { ...input(challenge(), await payment()), paymentHeader: "@@@" }],
      ["v1 payload", input(challenge(), { x402Version: 1, payload: {} })],
      ["no authorization", input(challenge(), { x402Version: 2, accepted: option(), payload: { signature: "0x" } })],
      ["malformed authorization", input(challenge(), { x402Version: 2, accepted: option(), payload: { authorization: {}, signature: "0x" } })],
      ["erc-6492", input(challenge(), wrapped)],
      ["expired", input(challenge(), await payment({ auth: { validBefore: "100" } }))],
    ];

    for (const [label, caseInput] of cases) {
      const ids = (await checkAuthorization(caseInput)).map((result) => result.id);
      expect(ids, label).toEqual([...ALL_IDS]);
    }
  });

  it("exposes the digest and separator as evidence for reproduction", async () => {
    const results = byId(await checkAuthorization(input(challenge(), await payment())));
    const recovery = results["c3.signature-recovery"];
    expect(recovery?.evidence?.["digest"]).toBe(
      eip3009Digest(baseDomain, {
        from: account.address,
        to: PAY_TO as `0x${string}`,
        value: 1000n,
        validAfter: 0n,
        validBefore: BigInt(NOW + 60),
        nonce: NONCE as `0x${string}`,
      }),
    );
    expect(results["c3.domain-config"]?.evidence?.["domainSeparator"]).toBeTypeOf("string");
  });

  it("rejects a non-positive evaluation time instead of guessing", async () => {
    await expect(checkAuthorization(input(challenge(), await payment(), { now: 0 }))).rejects.toThrow(TypeError);
  });

  it("rejects invalid runner inputs at the boundary", async () => {
    const base = input(challenge(), await payment());
    await expect(checkAuthorization({ ...base, expectedNetwork: "elsewhere" as "testnet" })).rejects.toThrow(
      /expectedNetwork/,
    );
    await expect(checkAuthorization({ ...base, expectedNetwork: "toString" as "testnet" })).rejects.toThrow(
      /expectedNetwork/,
    );
    await expect(checkAuthorization({ ...base, minValiditySeconds: Number.NaN })).rejects.toThrow(
      /minValiditySeconds/,
    );
    await expect(checkAuthorization({ ...base, maxWindowSeconds: 0 })).rejects.toThrow(/maxWindowSeconds/);
  });

  describe("input preconditions", () => {
    it("fails the challenge and skips everything else when no challenge is available", async () => {
      const results = byId(
        await checkAuthorization({ ...input(challenge(), await payment()), challengeHeader: undefined }),
      );
      expect(results["c3.challenge"]?.status).toBe("fail");
      for (const id of ALL_IDS.slice(1)) expect(results[id]?.status).toBe("skip");
    });

    it("fails when the challenge header is not decodable", async () => {
      const results = byId(
        await checkAuthorization({ ...input(challenge(), await payment()), challengeHeader: "@@@" }),
      );
      expect(results["c3.challenge"]?.status).toBe("fail");
      expect(results["c3.payment"]?.status).toBe("skip");
    });

    it("fails when the challenge carries no payment option", async () => {
      const results = byId(await checkAuthorization(input({ x402Version: 2 }, await payment())));
      expect(results["c3.challenge"]?.status).toBe("fail");
      expect(results["c3.challenge"]?.detail).toMatch(/no payment option/);
    });

    it("fails and skips the rest when no payment payload is supplied", async () => {
      const results = byId(
        await checkAuthorization({ ...input(challenge(), await payment()), paymentHeader: undefined }),
      );
      expect(results["c3.challenge"]?.status).toBe("pass");
      expect(results["c3.payment"]?.status).toBe("fail");
      expect(results["c3.payload-shape"]?.status).toBe("skip");
    });

    it("fails when the payment payload is not decodable", async () => {
      const results = byId(
        await checkAuthorization({ ...input(challenge(), await payment()), paymentHeader: "@@@" }),
      );
      expect(results["c3.payment"]?.status).toBe("fail");
      expect(results["c3.signature-recovery"]?.status).toBe("skip");
    });

    it("refuses a v1 payload with an explanation instead of guessing its shape", async () => {
      const v1 = { x402Version: 1, scheme: "exact", network: "2368", payload: {} };
      const results = byId(await checkAuthorization(input(challenge(), v1)));
      expect(results["c3.payload-version"]?.status).toBe("fail");
      expect(results["c3.payload-version"]?.detail).toMatch(/out of scope/);
      expect(results["c3.payload-shape"]?.status).toBe("skip");
    });
  });

  describe("payload shape", () => {
    it("fails when the authorisation block is missing", async () => {
      const broken = { x402Version: 2, accepted: option(), payload: { signature: "0x" } };
      const results = byId(await checkAuthorization(input(challenge(), broken)));
      expect(results["c3.payload-shape"]?.status).toBe("fail");
      expect(results["c3.payload-shape"]?.detail).toMatch(/payload.authorization/);
    });

    it("reports every malformed field at once", async () => {
      const broken = {
        x402Version: 2,
        accepted: option(),
        payload: {
          authorization: {
            from: account.address,
            to: PAY_TO,
            value: "10.5",
            validAfter: "0",
            validBefore: String(NOW + 60),
            nonce: "0xdeadbeef",
          },
          signature: "0x",
        },
      };
      const results = byId(await checkAuthorization(input(challenge(), broken)));
      const evidence = results["c3.payload-shape"]?.evidence?.["problems"];
      expect(results["c3.payload-shape"]?.status).toBe("fail");
      expect(Array.isArray(evidence) ? evidence.length : 0).toBe(2);
      expect(results["c3.window"]?.status).toBe("skip");
    });

    it("refuses an authorisation amount sent as an unsafe JSON number", async () => {
      // The fixture signs 1000 but presents a value JSON cannot represent exactly.
      const payload = await payment({
        auth: { value: Number.parseInt("9007199254740993", 10) },
      });
      const results = byId(await checkAuthorization(input(challenge(), payload)));
      expect(results["c3.payload-shape"]?.status).toBe("fail");
      expect(results["c3.payload-shape"]?.detail).toMatch(/2\^53|decimal string/);
      expect(results["c3.signature-recovery"]?.status).toBe("skip");
    });

    it("parses aliases but still requires all six fields", () => {
      const parsed = parseAuthorization({
        from: account.address,
        payee: PAY_TO,
        amount: "1000",
        valid_after: "0",
        valid_before: String(NOW + 60),
        nonce: NONCE,
      });
      expect(parsed.ok).toBe(true);
      const missing = parseAuthorization({ from: account.address, to: PAY_TO, value: "1000" });
      expect(missing.ok).toBe(false);
      if (missing.ok) return;
      expect(missing.problems.length).toBe(3);
    });
  });

  describe("binding to the quote", () => {
    it("fails when payload.accepted is absent, because v2 requires it", async () => {
      const results = byId(await checkAuthorization(input(challenge(), await payment({ accepted: null }))));
      expect(results["c3.accepted-binding"]?.status).toBe("fail");
      expect(results["c3.accepted-binding"]?.detail).toMatch(/invalid_payload|accepted/);
      // The payee and amount can still be compared against the challenge itself.
      expect(results["c3.binding-payto"]?.status).toBe("pass");
    });

    it("fails when the accepted amount drifted from the challenge", async () => {
      const payload = await payment({ accepted: option({ amount: "2000" }) });
      const results = byId(await checkAuthorization(input(challenge(), payload)));
      expect(results["c3.accepted-binding"]?.status).toBe("fail");
      expect(results["c3.accepted-binding"]?.detail).toMatch(/amount/);
    });

    it("accepts a client that picked a later option from accepts[]", async () => {
      const twoOptions = {
        x402Version: 2,
        accepts: [option({ amount: "9999" }), option({ amount: "1000", payTo: PAY_TO })],
      };
      const results = byId(await checkAuthorization(input(twoOptions, await payment())));
      expect(results["c3.accepted-binding"]?.status).toBe("pass");
      expect(results["c3.binding-value"]?.status).toBe("pass");
      expect(results["c3.signature-recovery"]?.status).toBe("pass");
    });

    it("fails when payload.accepted matches no advertised option (foreign or stale quote)", async () => {
      const twoOptions = {
        x402Version: 2,
        accepts: [option({ amount: "9999" }), option({ amount: "8888" })],
      };
      const results = byId(await checkAuthorization(input(twoOptions, await payment())));
      expect(results["c3.accepted-binding"]?.status).toBe("fail");
      expect(results["c3.accepted-binding"]?.detail).toMatch(/no advertised option matches/);
    });

    it("fails when the accepted amount is an unsafe JSON number", async () => {
      const payload = await payment({
        accepted: option({ amount: Number.parseInt("9007199254740993", 10) }),
      });
      const results = byId(await checkAuthorization(input(challenge(), payload)));
      expect(results["c3.accepted-binding"]?.status).toBe("fail");
      expect(results["c3.accepted-binding"]?.detail).toMatch(/2\^53|decimal string/);
    });

    it("fails when neither side declares a network", async () => {
      const noNet = (): Record<string, unknown> => {
        const value: Record<string, unknown> = option();
        delete value["network"];
        return value;
      };
      const results = byId(await checkAuthorization(input(challenge(noNet()), await payment({ accepted: noNet() }))));
      expect(results["c3.accepted-binding"]?.status).toBe("fail");
      expect(results["c3.accepted-binding"]?.detail).toMatch(/network/);
    });

    it("fails when the accepted network drifted from the challenge", async () => {
      const payload = await payment({ accepted: option({ network: "eip155:2366" }) });
      const results = byId(await checkAuthorization(input(challenge(), payload)));
      expect(results["c3.accepted-binding"]?.status).toBe("fail");
      expect(results["c3.accepted-binding"]?.detail).toMatch(/network/);
    });

    it("fails when the authorisation pays a different receiver", async () => {
      const other = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
      const payload = await payment({ auth: { to: other } });
      const results = byId(await checkAuthorization(input(challenge(), payload)));
      expect(results["c3.binding-payto"]?.status).toBe("fail");
      expect(results["c3.binding-payto"]?.detail).toMatch(/invalid_exact_evm_recipient_mismatch/);
    });

    it("fails when the authorisation value differs from the quote", async () => {
      const payload = await payment({ auth: { value: "999" } });
      const results = byId(await checkAuthorization(input(challenge(), payload)));
      expect(results["c3.binding-value"]?.status).toBe("fail");
      expect(results["c3.binding-value"]?.detail).toMatch(/invalid_exact_evm_authorization_value/);
    });

    it("accepts the v1 alias maxAmountRequired on the quote", async () => {
      const quote = challenge({ amount: undefined, maxAmountRequired: "1000" });
      const results = byId(await checkAuthorization(input(quote, await payment())));
      expect(results["c3.binding-value"]?.status).toBe("pass");
    });
  });

  describe("address sanity", () => {
    it("fails when payer and payee are the same account", async () => {
      const results = byId(await checkAuthorization(input(challenge(), await payment({ auth: { to: account.address } }))));
      expect(results["c3.address-sanity"]?.status).toBe("fail");
      // The facilitator does not reject a self-payment; this is engineering advice.
      expect(results["c3.address-sanity"]?.level).toBe("warning");
      expect(results["c3.address-sanity"]?.detail).toMatch(/same account/);
    });

    it("fails on the zero payer", async () => {
      const zero = "0x0000000000000000000000000000000000000000";
      const results = byId(await checkAuthorization(input(challenge(), await payment({ auth: { from: zero } }))));
      expect(results["c3.address-sanity"]?.status).toBe("fail");
      expect(results["c3.address-sanity"]?.level).toBe("critical");
      expect(results["c3.address-sanity"]?.detail).toMatch(/zero address/);
    });
  });

  describe("EIP-712 domain", () => {
    it("fails when the challenge omits extra.version, and skips recovery", async () => {
      const quote = challenge({ extra: { name: "pieUSD" } });
      const results = byId(await checkAuthorization(input(quote, await payment())));
      expect(results["c3.domain-config"]?.status).toBe("fail");
      expect(results["c3.domain-config"]?.detail).toMatch(/extra\.version/);
      expect(results["c3.signature-recovery"]?.status).toBe("skip");
      // Signature encoding is still checked: it does not need the domain.
      expect(results["c3.signature-format"]?.status).toBe("pass");
    });

    it("fails when the challenge is on a different chain than the run expects", async () => {
      const quote = challenge({ network: "eip155:2366" });
      const payload = await payment({
        domain: { chainId: 2366 },
        accepted: option({ network: "eip155:2366" }),
      });
      const results = byId(await checkAuthorization(input(quote, payload)));
      expect(results["c3.accepted-binding"]?.status).toBe("pass");
      expect(results["c3.domain-config"]?.status).toBe("fail");
      expect(results["c3.domain-config"]?.detail).toMatch(/expected eip155:2368/);
      expect(results["c3.signature-recovery"]?.status).toBe("skip");
    });

    it("fails when the challenge omits extra entirely", async () => {
      const quote = challenge({ extra: undefined });
      const results = byId(await checkAuthorization(input(quote, await payment())));
      expect(results["c3.domain-config"]?.status).toBe("fail");
      expect(results["c3.domain-config"]?.evidence?.["missing"]).toEqual(["extra.name", "extra.version"]);
    });
  });

  describe("validity window", () => {
    it("fails when validAfter is in the future", async () => {
      const payload = await payment({ auth: { validAfter: String(NOW + 30) } });
      const results = byId(await checkAuthorization(input(challenge(), payload)));
      expect(results["c3.window"]?.status).toBe("fail");
      expect(results["c3.window"]?.detail).toMatch(/not valid yet/);
    });

    it("fails when less than the reference 6 seconds of validity remain", async () => {
      const payload = await payment({ auth: { validBefore: String(NOW + 5) } });
      const results = byId(await checkAuthorization(input(challenge(), payload)));
      expect(results["c3.window"]?.status).toBe("fail");
      expect(results["c3.window"]?.detail).toMatch(/expires too soon/);
    });

    it("passes at exactly 6 seconds of remaining validity", async () => {
      const payload = await payment({ auth: { validBefore: String(NOW + 6) } });
      const results = byId(await checkAuthorization(input(challenge(), payload)));
      expect(results["c3.window"]?.status).toBe("pass");
    });

    it("fails on an inverted window", async () => {
      const payload = await payment({ auth: { validAfter: "200", validBefore: "100" } });
      const results = byId(await checkAuthorization(input(challenge(), payload)));
      expect(results["c3.window"]?.status).toBe("fail");
      expect(results["c3.window"]?.detail).toMatch(/window is empty/);
    });

    it("warns when the payment stays replayable far beyond maxTimeoutSeconds", async () => {
      const payload = await payment({ auth: { validBefore: String(NOW + 86_400) } });
      const results = byId(await checkAuthorization(input(challenge(), payload)));
      expect(results["c3.window-span"]?.status).toBe("fail");
      expect(results["c3.window-span"]?.level).toBe("warning");
      expect(results["c3.window-span"]?.detail).toMatch(/maxTimeoutSeconds/);
    });

    it("honours an explicit --max-window override", async () => {
      const results = byId(
        await checkAuthorization(input(challenge(), await payment(), { maxWindowSeconds: 600 })),
      );
      expect(results["c3.window-span"]?.status).toBe("pass");
    });

    it("evaluates the window at the injected time, not at wall clock", async () => {
      const payload = await payment({ auth: { validBefore: String(NOW + 60) } });
      const later = byId(await checkAuthorization(input(challenge(), payload, { now: NOW + 120 })));
      expect(later["c3.window"]?.status).toBe("fail");
      expect(later["c3.window-span"]?.status).toBe("pass");
    });
  });

  describe("signature encoding", () => {
    it("fails a trailing 0/1 v but still recovers the payer", async () => {
      const payload = await payment({ signatureMutator: (signature) => `${signature.slice(0, -2)}00` });
      const results = byId(await checkAuthorization(input(challenge(), payload)));
      expect(results["c3.signature-format"]?.status).toBe("fail");
      expect(results["c3.signature-format"]?.detail).toMatch(/27 or 28/);
      // viem recovers through yParity, so the rest of the checks still speak.
      expect(results["c3.signature-recovery"]?.status).toBe("pass");
    });

    it("fails a high-s signature as non-canonical", async () => {
      const payload = await payment({
        signatureMutator: (signature) => {
          const r = signature.slice(2, 66);
          const s = BigInt(`0x${signature.slice(66, 130)}`);
          const v = Number.parseInt(signature.slice(130, 132), 16);
          return `0x${r}${numberToHex(SECP256K1_N - s, { size: 32 }).slice(2)}${(v === 27 ? 28 : 27).toString(16)}`;
        },
      });
      const results = byId(await checkAuthorization(input(challenge(), payload)));
      expect(results["c3.signature-low-s"]?.status).toBe("fail");
      expect(results["c3.signature-low-s"]?.detail).toMatch(/non_canonical_signature/);
      // Same payment, different encoding: recovery still lands on the payer.
      expect(results["c3.signature-recovery"]?.status).toBe("pass");
    });

    it("skips, rather than passes, an ERC-6492 wrapped signature", async () => {
      const payload = await payment({
        signatureMutator: (signature) =>
          concat([
            encodeAbiParameters(
              [{ type: "address" }, { type: "bytes" }, { type: "bytes" }],
              ["0xcafebabecafebabecafebabecafebabecafebabe", "0xdeadbeef", signature as `0x${string}`],
            ),
            ERC6492_MAGIC,
          ]),
      });
      const results = byId(await checkAuthorization(input(challenge(), payload)));
      expect(results["c3.signature-format"]?.status).toBe("skip");
      expect(results["c3.signature-low-s"]?.status).toBe("skip");
      expect(results["c3.signature-recovery"]?.status).toBe("skip");
      expect(results["c3.signature-recovery"]?.detail).toMatch(/not verified/);
    });

    it("fails a signature made over different content", async () => {
      // Same key, same domain, same nonce — only the signed value differs.
      const overDifferentValue = await account.signTypedData({
        domain: baseDomain,
        types: TRANSFER_WITH_AUTHORIZATION_TYPES,
        primaryType: "TransferWithAuthorization",
        message: {
          from: account.address,
          to: PAY_TO,
          value: 2000n,
          validAfter: 0n,
          validBefore: BigInt(NOW + 60),
          nonce: NONCE,
        },
      });
      const payload = await payment({ signatureMutator: () => overDifferentValue as `0x${string}` });
      const results = byId(await checkAuthorization(input(challenge(), payload)));
      expect(results["c3.signature-format"]?.status).toBe("pass");
      expect(results["c3.signature-low-s"]?.status).toBe("pass");
      expect(results["c3.signature-recovery"]?.status).toBe("fail");
      expect(results["c3.signature-recovery"]?.detail).toMatch(/No version\/chainId variant/);
    });

    it("fails a signature whose r is not a valid curve point", async () => {
      const payload = await payment({
        signatureMutator: (signature) => {
          const first = Number.parseInt(signature.slice(2, 4), 16) ^ 0xff;
          return `0x${first.toString(16).padStart(2, "0")}${signature.slice(4)}`;
        },
      });
      const results = byId(await checkAuthorization(input(challenge(), payload)));
      expect(results["c3.signature-format"]?.status).toBe("pass");
      expect(results["c3.signature-recovery"]?.status).toBe("fail");
      expect(results["c3.signature-recovery"]?.detail).toMatch(/cannot be turned into a public key/);
    });
  });

  describe("recovery diagnosis", () => {
    it("names the domain version the client actually signed with", async () => {
      const payload = await payment({ domain: { version: "2" } });
      const results = byId(await checkAuthorization(input(challenge(), payload)));
      const recovery = results["c3.signature-recovery"];
      expect(recovery?.status).toBe("fail");
      expect(recovery?.detail).toMatch(/version="2"/);
      expect(recovery?.evidence?.["matchesUnder"]).toContain('version="2" chainId=2368');
    });

    it("names the chain id the client actually signed for", async () => {
      const payload = await payment({ domain: { chainId: 2366 } });
      const results = byId(await checkAuthorization(input(challenge(), payload)));
      const recovery = results["c3.signature-recovery"];
      expect(recovery?.status).toBe("fail");
      expect(recovery?.detail).toMatch(/chainId=2366/);
    });

    it("states the mismatch plainly when no domain variant recovers", async () => {
      const other = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
      const signature = await other.signTypedData({
        domain: baseDomain,
        types: TRANSFER_WITH_AUTHORIZATION_TYPES,
        primaryType: "TransferWithAuthorization",
        message: {
          from: account.address,
          to: PAY_TO,
          value: 1000n,
          validAfter: 0n,
          validBefore: BigInt(NOW + 60),
          nonce: NONCE,
        },
      });
      const payload = await payment({ signatureMutator: () => signature });
      const results = byId(await checkAuthorization(input(challenge(), payload)));
      const recovery = results["c3.signature-recovery"];
      expect(recovery?.status).toBe("fail");
      expect(recovery?.detail).toMatch(/No version\/chainId variant/);
      expect(recovery?.evidence?.["matchesUnder"]).toEqual([]);
    });

    it("keeps the recovered address in evidence so the mismatch is checkable", async () => {
      const payload = await payment({ domain: { version: "2" } });
      const results = byId(await checkAuthorization(input(challenge(), payload)));
      const reported = results["c3.signature-recovery"]?.evidence?.["recovered"];
      const signature = (payload["payload"] as Record<string, unknown>)["signature"] as `0x${string}`;

      // Independent recomputation of what the checker reported: the digest built
      // from the *advertised* domain (version "1") against a signature made with
      // version "2" must land on the same unrelated address.
      const recomputed = await recoverAddress({
        hash: eip3009Digest(baseDomain, {
          from: account.address,
          to: PAY_TO as `0x${string}`,
          value: 1000n,
          validAfter: 0n,
          validBefore: BigInt(NOW + 60),
          nonce: NONCE as `0x${string}`,
        }),
        signature,
      });

      expect(reported).toBe(recomputed);
      expect(recomputed.toLowerCase()).not.toBe(account.address.toLowerCase());
    });
  });
});
