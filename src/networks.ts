/**
 * Kite network constants.
 *
 * Only values confirmed from public Kite documentation and the template
 * repositories are hardcoded. Anything unconfirmed is `null` on purpose: a
 * checker that silently guesses an endpoint produces false confidence, which is
 * worse than refusing to run. See docs/LIMITATIONS.md.
 */

export type KiteNetworkName = "mainnet" | "testnet";

export interface KiteNetwork {
  readonly name: KiteNetworkName;
  /** EIP-155 chain id. */
  readonly chainId: number;
  /** CAIP-2 identifier, the form x402 payloads normally advertise. */
  readonly caip2: string;
  /** `null` when the endpoint is not confirmed. Supply it via config instead. */
  readonly rpcUrl: string | null;
  /** `null` when the block explorer is not confirmed. */
  readonly explorerUrl: string | null;
  /** Whether every field above was confirmed against public sources. */
  readonly verified: boolean;
}

export const KITE_NETWORKS: Record<KiteNetworkName, KiteNetwork> = {
  mainnet: {
    name: "mainnet",
    chainId: 2366,
    caip2: "eip155:2366",
    rpcUrl: null,
    explorerUrl: null,
    verified: false,
  },
  testnet: {
    name: "testnet",
    chainId: 2368,
    caip2: "eip155:2368",
    rpcUrl: "https://rpc-testnet.gokite.ai/",
    explorerUrl: "https://testnet.kitescan.ai/",
    verified: true,
  },
};

export function networkByName(name: KiteNetworkName): KiteNetwork {
  return KITE_NETWORKS[name];
}

export interface NetworkMatch {
  readonly ok: boolean;
  /** Whatever the payload advertised, normalised to CAIP-2 when possible. */
  readonly normalised: string | null;
  readonly reason: string;
}

/**
 * Compare an advertised network field against the expected one.
 *
 * x402 payloads are inconsistent in practice: some advertise `eip155:2368`,
 * some a bare `2368`, some a JSON number. All three are accepted and must map to
 * the expected CAIP-2 id. Anything else fails closed.
 */
export function matchNetwork(advertised: unknown, expected: KiteNetworkName): NetworkMatch {
  const target = KITE_NETWORKS[expected].caip2;

  if (typeof advertised === "number") {
    const asCaip2 = `eip155:${advertised}`;
    return asCaip2 === target
      ? { ok: true, normalised: asCaip2, reason: "numeric chain id matches" }
      : { ok: false, normalised: asCaip2, reason: `expected ${target}, got eip155:${advertised}` };
  }

  if (typeof advertised === "string") {
    const raw = advertised.trim();
    if (raw.length === 0) {
      return { ok: false, normalised: null, reason: "network field is empty" };
    }
    const asCaip2 = /^\d+$/.test(raw) ? `eip155:${raw}` : raw.toLowerCase();
    return asCaip2 === target
      ? { ok: true, normalised: asCaip2, reason: "string network matches" }
      : { ok: false, normalised: asCaip2, reason: `expected ${target}, got ${asCaip2}` };
  }

  return { ok: false, normalised: null, reason: "network field is missing or not a string/number" };
}
