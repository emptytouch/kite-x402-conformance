/**
 * EIP-712 and EIP-3009 primitives, computed step by step.
 *
 * Why not just call `hashTypedData`? Because when a signature fails to recover,
 * the only useful artefact is *which* byte range disagreed with the signer: the
 * domain separator, the struct hash, or the signature encoding. A single opaque
 * digest hides that. Both helpers below are cross-checked against viem's
 * `hashDomain` / `hashTypedData` in `test/eip712.test.ts`, so the hand-rolled
 * encoding has to agree with an independent implementation byte for byte.
 */

import {
  concat,
  encodeAbiParameters,
  hexToBigInt,
  isHex,
  keccak256,
  slice,
  toHex,
  type Hex,
} from "viem";

/** EIP-712 domain used by EIP-3009 tokens: `{ name, version, chainId, verifyingContract }`. */
export interface Eip712Domain {
  readonly name: string;
  readonly version: string;
  readonly chainId: number | bigint;
  readonly verifyingContract: Hex;
}

/** The EIP-3009 message that authorises a single transfer. */
export interface TransferWithAuthorization {
  readonly from: Hex;
  readonly to: Hex;
  readonly value: bigint;
  readonly validAfter: bigint;
  readonly validBefore: bigint;
  readonly nonce: Hex;
}

/**
 * Field order is part of the hash. Reordering these entries — even keeping the
 * same names — changes the type hash and invalidates every signature.
 */
export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

const DOMAIN_TYPE =
  "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)";
const AUTHORIZATION_TYPE =
  "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)";

export const EIP712_DOMAIN_TYPEHASH: Hex = keccak256(toHex(DOMAIN_TYPE));
export const TRANSFER_WITH_AUTHORIZATION_TYPEHASH: Hex = keccak256(toHex(AUTHORIZATION_TYPE));

/** Order of the secp256k1 curve. `s` above half of it is rejected on mainnet. */
export const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
export const SECP256K1_N_HALF = SECP256K1_N >> 1n;

/**
 * `domainSeparator = keccak256(abi.encode(typeHash, keccak256(name), keccak256(version), chainId, verifyingContract))`
 *
 * The two string fields are hashed, not embedded: EIP-712 encodes dynamic types
 * as the hash of their contents so every struct occupies a fixed number of words.
 */
export function eip712DomainSeparator(domain: Eip712Domain): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
      [
        EIP712_DOMAIN_TYPEHASH,
        keccak256(toHex(domain.name)),
        keccak256(toHex(domain.version)),
        BigInt(domain.chainId),
        domain.verifyingContract,
      ],
    ),
  );
}

export function transferWithAuthorizationStructHash(authorization: TransferWithAuthorization): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "address" },
        { type: "address" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "bytes32" },
      ],
      [
        TRANSFER_WITH_AUTHORIZATION_TYPEHASH,
        authorization.from,
        authorization.to,
        authorization.value,
        authorization.validAfter,
        authorization.validBefore,
        authorization.nonce,
      ],
    ),
  );
}

/**
 * `digest = keccak256(0x1901 ‖ domainSeparator ‖ structHash)`.
 *
 * The `0x1901` prefix is what stops a 32-byte struct hash from being replayed as
 * a standalone transaction hash.
 */
export function eip3009Digest(domain: Eip712Domain, authorization: TransferWithAuthorization): Hex {
  return keccak256(
    concat(["0x1901", eip712DomainSeparator(domain), transferWithAuthorizationStructHash(authorization)]),
  );
}

export interface ParsedEcdsaSignature {
  readonly r: Hex;
  readonly s: Hex;
  /** The 65th byte exactly as it appeared on the wire. Never normalised. */
  readonly trailingByte: number;
  readonly yParity: 0 | 1;
  /**
   * EIP-2 canonical `v`. On-chain `ecrecover` only accepts 27/28: a signature
   * ending in 0/1 recovers to the zero address, and `transferWithAuthorization`
   * then reverts after the payer already believes they paid.
   */
  readonly hasCanonicalV: boolean;
  /** `s <= n/2`. High-s signatures are rejected by the reference facilitator. */
  readonly hasLowS: boolean;
}

export type SignatureParseResult =
  | { readonly ok: true; readonly value: ParsedEcdsaSignature }
  | { readonly ok: false; readonly error: string };

/**
 * Parse a 65-byte `r ‖ s ‖ v` signature without normalising anything.
 *
 * Deliberately stricter than `viem.parseSignature`, which accepts a trailing
 * `0`/`1` and reports it as `yParity` — fine for off-chain recovery, wrong for a
 * tool whose job is predicting what the chain will do.
 */
export function parseSignature65(raw: string): SignatureParseResult {
  if (!isHex(raw)) {
    return { ok: false, error: "signature is not 0x-prefixed hex" };
  }
  const byteLength = (raw.length - 2) / 2;
  if (byteLength !== 65) {
    return {
      ok: false,
      error: `signature is ${byteLength} bytes; on-chain verification needs 65 (r‖s‖v)`,
    };
  }

  const r = hexToBigInt(slice(raw, 0, 32));
  const s = hexToBigInt(slice(raw, 32, 64));
  const trailingByte = Number(hexToBigInt(slice(raw, 64, 65)));

  if (r === 0n || r >= SECP256K1_N) {
    return { ok: false, error: "signature r is out of range for secp256k1" };
  }
  if (s === 0n || s >= SECP256K1_N) {
    return { ok: false, error: "signature s is out of range for secp256k1" };
  }

  const hasCanonicalV = trailingByte === 27 || trailingByte === 28;
  if (!hasCanonicalV && trailingByte !== 0 && trailingByte !== 1) {
    return {
      ok: false,
      error: `signature v is ${trailingByte}; expected 27 or 28`,
    };
  }

  return {
    ok: true,
    value: {
      r: slice(raw, 0, 32),
      s: slice(raw, 32, 64),
      trailingByte,
      yParity: (hasCanonicalV ? trailingByte - 27 : trailingByte) as 0 | 1,
      hasCanonicalV,
      hasLowS: s <= SECP256K1_N_HALF,
    },
  };
}
