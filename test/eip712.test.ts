import { domainSeparator, hashTypedData, numberToHex, recoverAddress, size } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";

import {
  eip3009Digest,
  eip712DomainSeparator,
  parseSignature65,
  SECP256K1_N,
  TRANSFER_WITH_AUTHORIZATION_TYPES,
  transferWithAuthorizationStructHash,
  type Eip712Domain,
  type TransferWithAuthorization,
} from "../src/eip712.js";

// Hardhat account #1: a public test key from the Hardhat docs. It holds no
// funds and signs nothing but the fixtures in this file.
const DEMO_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const account = privateKeyToAccount(DEMO_KEY);

const domain: Eip712Domain = {
  name: "pieUSD",
  version: "1",
  chainId: 2368,
  verifyingContract: "0x0f5d2fb29fb7d3cfee444a200298f468908cc942",
};

const authorization: TransferWithAuthorization = {
  from: account.address,
  to: "0x1234567890123456789012345678901234567890",
  value: 1000n,
  validAfter: 0n,
  validBefore: 1_700_000_060n,
  nonce: "0x00000000000000000000000000000000000000000000000000000000deadbeef",
};

async function sign(
  overrides: { domain?: Partial<Eip712Domain>; message?: Partial<TransferWithAuthorization> } = {},
): Promise<`0x${string}`> {
  const signature = await account.signTypedData({
    domain: { ...domain, ...overrides.domain },
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message: { ...authorization, ...overrides.message },
  });
  return signature;
}

describe("EIP-712 encoding", () => {
  it("matches viem's domainSeparator byte for byte", () => {
    expect(eip712DomainSeparator(domain)).toBe(domainSeparator({ domain }));
  });

  it("matches viem's hashTypedData byte for byte", () => {
    expect(eip3009Digest(domain, authorization)).toBe(
      hashTypedData({
        domain,
        types: TRANSFER_WITH_AUTHORIZATION_TYPES,
        primaryType: "TransferWithAuthorization",
        message: authorization,
      }),
    );
  });

  /**
   * Pinned output. Both implementations agreeing is the real check; this literal
   * additionally catches the case where a library upgrade changes *both* sides'
   * behaviour at once (for example a viem change in how `version` is encoded).
   */
  it("reproduces the pinned Kite-testnet separator and digest", () => {
    expect(eip712DomainSeparator(domain)).toBe(
      "0x8cd960d2a24cc8871d2515a10764b5ffaed8788f8cd65cc0334557c1445bf493",
    );
    expect(eip3009Digest(domain, authorization)).toBe(
      "0x4fe5140ddf50b8f47b0c1348a33f19a1d84d9901f91068a71e773204bb1ab7b9",
    );
  });

  it("changes the digest when only the domain version changes", () => {
    const mainnetStyle = eip3009Digest({ ...domain, version: "2" }, authorization);
    expect(mainnetStyle).not.toBe(eip3009Digest(domain, authorization));
  });

  it("changes the digest when only the chain id changes", () => {
    expect(eip3009Digest({ ...domain, chainId: 2366 }, authorization)).not.toBe(
      eip3009Digest(domain, authorization),
    );
  });

  it("changes the digest when only the name changes", () => {
    expect(eip3009Digest({ ...domain, name: "USD Coin" }, authorization)).not.toBe(
      eip3009Digest(domain, authorization),
    );
  });

  it("changes the struct hash when a single field changes", () => {
    const base = transferWithAuthorizationStructHash(authorization);
    expect(transferWithAuthorizationStructHash({ ...authorization, value: 1001n })).not.toBe(base);
    expect(transferWithAuthorizationStructHash({ ...authorization, validBefore: 1n })).not.toBe(base);
    expect(
      transferWithAuthorizationStructHash({
        ...authorization,
        nonce: "0x00000000000000000000000000000000000000000000000000000000deadbeee",
      }),
    ).not.toBe(base);
  });

  it("recovers the signing account for the pinned signature", async () => {
    const signature = await sign();
    const recovered = await recoverAddress({ hash: eip3009Digest(domain, authorization), signature });
    expect(recovered).toBe(account.address);
  });
});

describe("65-byte signature parsing", () => {
  it("accepts a canonical signature and reports low s", async () => {
    const parsed = parseSignature65(await sign());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.hasCanonicalV).toBe(true);
    expect(parsed.value.hasLowS).toBe(true);
    expect(parsed.value.trailingByte).toBe(27);
    expect(parsed.value.yParity).toBe(0);
  });

  it("parses but flags a trailing 0/1 as non-canonical v", async () => {
    const signature = await sign();
    const zeroOne = `${signature.slice(0, -2)}00` as `0x${string}`;
    const parsed = parseSignature65(zeroOne);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // This is the bug viem.parseSignature hides: it accepts 0/1 while
    // on-chain ecrecover needs 27/28.
    expect(parsed.value.hasCanonicalV).toBe(false);
    expect(parsed.value.yParity).toBe(0);
  });

  it("flags a high-s signature, which is the same payment in a different encoding", async () => {
    const signature = await sign();
    const parsed = parseSignature65(signature);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const highS = SECP256K1_N - BigInt(parsed.value.s);
    const flipped = `0x${parsed.value.r.slice(2)}${numberToHex(highS, { size: 32 }).slice(2)}1c` as `0x${string}`;
    const reparsed = parseSignature65(flipped);
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) return;
    expect(reparsed.value.hasLowS).toBe(false);
    // Same digest, same signer, different bytes: this is why the nonce, not the
    // signature, is what stops a replay.
    await expect(recoverAddress({ hash: eip3009Digest(domain, authorization), signature: flipped })).resolves.toBe(
      account.address,
    );
  });

  it.each([
    ["64-byte compact signature", (s: string) => s.slice(0, 130)],
    ["33-byte truncation", (s: string) => s.slice(0, 66)],
    ["non-hex", () => "0xnothex"],
  ])("rejects %s", async (_label, mutate) => {
    const parsed = parseSignature65(mutate(await sign()));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.length).toBeGreaterThan(0);
  });

  it("rejects a v value outside {0,1,27,28}", async () => {
    const signature = await sign();
    const parsed = parseSignature65(`${signature.slice(0, -2)}1d`);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toMatch(/expected 27 or 28/);
  });

  it("reports the byte length of a wrong-sized signature", async () => {
    const signature = await sign();
    expect(size(signature as `0x${string}`)).toBe(65);
    const parsed = parseSignature65(signature.slice(0, 100));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toMatch(/49 bytes/);
  });
});
