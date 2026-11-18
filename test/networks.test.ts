import { describe, expect, it } from "vitest";

import { chainIdFromNetworkField, KITE_NETWORKS, matchNetwork, networkByName } from "../src/networks.js";

describe("Kite network constants", () => {
  it("keeps the documented chain ids", () => {
    expect(KITE_NETWORKS.mainnet.chainId).toBe(2366);
    expect(KITE_NETWORKS.testnet.chainId).toBe(2368);
    expect(networkByName("testnet").caip2).toBe("eip155:2368");
  });

  it("marks unverified networks instead of inventing endpoints", () => {
    expect(KITE_NETWORKS.mainnet.verified).toBe(false);
    expect(KITE_NETWORKS.mainnet.rpcUrl).toBeNull();
  });
});

describe("matchNetwork", () => {
  it("matches CAIP-2, numeric and string chain ids", () => {
    expect(matchNetwork("eip155:2368", "testnet").ok).toBe(true);
    expect(matchNetwork(2368, "testnet").ok).toBe(true);
    expect(matchNetwork("2368", "testnet").ok).toBe(true);
  });

  it("rejects the other network", () => {
    expect(matchNetwork("eip155:2366", "testnet").ok).toBe(false);
    expect(matchNetwork("eip155:2368", "mainnet").ok).toBe(false);
  });

  it("refuses an expected network inherited from Object.prototype", () => {
    expect(() => matchNetwork("eip155:2368", "toString" as "testnet")).toThrow(/expectedNetwork/);
    expect(() => matchNetwork("eip155:2368", "constructor" as "testnet")).toThrow(/expectedNetwork/);
  });

  it("fails closed on missing or empty values", () => {
    expect(matchNetwork(undefined, "testnet").ok).toBe(false);
    expect(matchNetwork("", "testnet").ok).toBe(false);
    expect(matchNetwork({ network: "eip155:2368" }, "testnet").ok).toBe(false);
  });
});

describe("chainIdFromNetworkField", () => {
  it("accepts CAIP-2, numeric and string chain ids", () => {
    expect(chainIdFromNetworkField("eip155:2368")).toBe(2368);
    expect(chainIdFromNetworkField(2366)).toBe(2366);
    expect(chainIdFromNetworkField("2368")).toBe(2368);
  });

  it("refuses an integer JSON cannot represent exactly", () => {
    // 9007199254740993 becomes 9007199254740992 during JSON.parse. Treating it
    // as a chain id would let a rounded value into the EIP-712 domain.
    expect(chainIdFromNetworkField(9007199254740993)).toBeUndefined();
    expect(chainIdFromNetworkField("9007199254740993")).toBeUndefined();
  });

  it("fails closed on malformed values", () => {
    expect(chainIdFromNetworkField("kite-testnet")).toBeUndefined();
    expect(chainIdFromNetworkField(0)).toBeUndefined();
    expect(chainIdFromNetworkField(null)).toBeUndefined();
  });
});
