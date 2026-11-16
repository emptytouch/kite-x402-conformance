import { describe, expect, it } from "vitest";

import { KITE_NETWORKS, matchNetwork, networkByName } from "../src/networks.js";

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

  it("fails closed on missing or empty values", () => {
    expect(matchNetwork(undefined, "testnet").ok).toBe(false);
    expect(matchNetwork("", "testnet").ok).toBe(false);
    expect(matchNetwork({ network: "eip155:2368" }, "testnet").ok).toBe(false);
  });
});
