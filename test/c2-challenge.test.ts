import { describe, expect, it } from "vitest";

import { checkChallenge, type ChallengeInput } from "../src/checks/c2-challenge.js";
import type { CheckResult } from "../src/checks/types.js";
import { encodeHeaderValue } from "../src/wire.js";

const PAY_TO = "0x1234567890123456789012345678901234567890";
const ASSET = "0x0f5d2fb29fb7d3cfee444a200298f468908cc942";

function challenge(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    x402Version: 2,
    accepts: [
      {
        scheme: "exact",
        network: "eip155:2368",
        asset: ASSET,
        payTo: PAY_TO,
        maxAmountRequired: "1000",
        ...overrides,
      },
    ],
  };
}

function input(decoded: unknown, extra: Partial<ChallengeInput> = {}): ChallengeInput {
  return {
    status: 402,
    headers: { "payment-required": encodeHeaderValue(decoded) },
    expectedNetwork: "testnet",
    expectedPayTo: PAY_TO,
    ...extra,
  };
}

function byId(results: readonly CheckResult[]): Record<string, CheckResult> {
  return Object.fromEntries(results.map((result) => [result.id, result]));
}

describe("C2 — 402 challenge structure", () => {
  it("passes a well-formed testnet challenge", () => {
    const results = byId(checkChallenge(input(challenge())));
    expect(results["c2.status"]?.status).toBe("pass");
    expect(results["c2.header"]?.status).toBe("pass");
    expect(results["c2.decode"]?.status).toBe("pass");
    expect(results["c2.version"]?.status).toBe("pass");
    expect(results["c2.scheme"]?.status).toBe("pass");
    expect(results["c2.network"]?.status).toBe("pass");
    expect(results["c2.asset"]?.status).toBe("pass");
    expect(results["c2.pay-to"]?.status).toBe("pass");
    expect(results["c2.amount"]?.status).toBe("pass");
    expect(results["c2.pay-to-match"]?.status).toBe("pass");
  });

  it("fails when the response is not 402", () => {
    const results = byId(checkChallenge(input(challenge(), { status: 200 })));
    expect(results["c2.status"]?.status).toBe("fail");
    expect(results["c2.status"]?.level).toBe("critical");
  });

  it("fails and skips decode when PAYMENT-REQUIRED is missing", () => {
    const results = byId(checkChallenge({ status: 402, headers: {}, expectedNetwork: "testnet" }));
    expect(results["c2.header"]?.status).toBe("fail");
    expect(results["c2.decode"]?.status).toBe("skip");
  });

  it("fails when the header is not decodable", () => {
    const results = byId(
      checkChallenge({ status: 402, headers: { "payment-required": "@@@" }, expectedNetwork: "testnet" }),
    );
    expect(results["c2.decode"]?.status).toBe("fail");
  });

  it("fails on a non-v2 payload", () => {
    const results = byId(checkChallenge(input({ x402Version: 1, accepts: [{ scheme: "exact" }] })));
    expect(results["c2.version"]?.status).toBe("fail");
  });

  it("fails when the advertised network is wrong", () => {
    const results = byId(checkChallenge(input(challenge({ network: "eip155:2366" }))));
    expect(results["c2.network"]?.status).toBe("fail");
    expect(results["c2.network"]?.detail).toMatch(/expected eip155:2368/);
  });

  it("accepts a numeric chain id instead of CAIP-2", () => {
    const results = byId(checkChallenge(input(challenge({ network: 2368 }))));
    expect(results["c2.network"]?.status).toBe("pass");
  });

  it("fails on a malformed payTo", () => {
    const results = byId(checkChallenge(input(challenge({ payTo: "0xnotanaddress" }))));
    expect(results["c2.pay-to"]?.status).toBe("fail");
  });

  it("fails when payTo differs from the configured receiver", () => {
    const results = byId(
      checkChallenge(input(challenge({ payTo: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd" }))),
    );
    expect(results["c2.pay-to-match"]?.status).toBe("fail");
  });

  it("skips payTo matching when no receiver is configured", () => {
    const results = byId(checkChallenge(input(challenge(), { expectedPayTo: undefined })));
    expect(results["c2.pay-to-match"]?.status).toBe("skip");
  });

  it.each(["0", "12.5", "-5", "1e6"])("fails on amount %s", (amount) => {
    const results = byId(checkChallenge(input(challenge({ maxAmountRequired: amount }))));
    expect(results["c2.amount"]?.status).toBe("fail");
  });

  it("refuses an amount sent as an unsafe JSON number instead of reporting a rounded value", () => {
    const results = byId(
      checkChallenge(
        input({
          x402Version: 2,
          accepts: [
            {
              scheme: "exact",
              network: "eip155:2368",
              asset: ASSET,
              payTo: PAY_TO,
              amount: 9007199254740993,
            },
          ],
        }),
      ),
    );
    expect(results["c2.amount"]?.status).toBe("fail");
    expect(results["c2.amount"]?.detail).toMatch(/2\^53|decimal string/);
  });

  it("accepts `amount` as an alias for maxAmountRequired", () => {
    const results = byId(
      checkChallenge(
        input({ x402Version: 2, accepts: [{ scheme: "exact", network: "eip155:2368", asset: ASSET, payTo: PAY_TO, amount: "2500" }] }),
      ),
    );
    expect(results["c2.amount"]?.status).toBe("pass");
  });

  it("accepts a single object instead of an accepts array", () => {
    const results = byId(
      checkChallenge(
        input({ x402Version: 2, accepts: { scheme: "exact", network: "eip155:2368", asset: ASSET, payTo: PAY_TO, maxAmountRequired: "1" } }),
      ),
    );
    expect(results["c2.scheme"]?.status).toBe("pass");
  });

  it("fails when the option has no asset field (critical, not skip)", () => {
    const results = byId(
      checkChallenge(
        input({
          x402Version: 2,
          accepts: [{ scheme: "exact", network: "eip155:2368", payTo: PAY_TO, amount: "1000" }],
        }),
      ),
    );
    expect(results["c2.asset"]?.status).toBe("fail");
    expect(results["c2.asset"]?.level).toBe("critical");
    expect(results["c2.asset"]?.detail).toMatch(/no asset field/);
  });

  it("skips an empty network alias and uses chainId instead", () => {
    const results = byId(
      checkChallenge(
        input({
          x402Version: 2,
          accepts: [
            {
              scheme: "exact",
              network: "",
              chainId: "eip155:2368",
              asset: ASSET,
              payTo: PAY_TO,
              amount: "1000",
            },
          ],
        }),
      ),
    );
    expect(results["c2.network"]?.status).toBe("pass");
  });

  it("throws on an expectedNetwork inherited from Object.prototype", () => {
    expect(() =>
      checkChallenge({ status: 402, headers: {}, expectedNetwork: "toString" as "testnet" }),
    ).toThrow(/expectedNetwork/);
  });

  it("fails when there is no payment option at all", () => {
    const results = byId(checkChallenge(input({ x402Version: 2 })));
    expect(results["c2.scheme"]?.status).toBe("fail");
    expect(results["c2.network"]?.status).toBe("skip");
  });
});
