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
  // `in` would accept inherited keys such as "toString", then dereference a
  // function instead of a network. hasOwn keeps the boundary honest.
  if (!Object.hasOwn(KITE_NETWORKS, expected)) {
    throw new TypeError(`matchNetwork: unknown expectedNetwork "${String(expected)}"`);
  }
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

/**
 * Extract the EIP-155 chain id from whatever a payload advertised.
 *
 * EIP-712 signatures commit to a numeric `chainId`, but challenges advertise
 * `eip155:2368`, `2368` or `"2368"` depending on the SDK build. This is the
 * single conversion point for all three; anything unrecognised returns
 * `undefined` rather than a guess, because a wrong chain id silently changes the
 * domain separator and every signature stops recovering.
 */
export function chainIdFromNetworkField(value: unknown): number | undefined {
  if (typeof value === "number") {
    // 2^53 and above are not exact after JSON.parse; using one as a chain id
    // would silently change the signed EIP-712 domain.
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  }
  if (typeof value !== "string") return undefined;

  const raw = value.trim();
  const digits = /^\d+$/.test(raw) ? raw : /^eip155:(\d+)$/i.exec(raw)?.[1];
  if (digits === undefined) return undefined;

  const parsed = Number.parseInt(digits, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}
