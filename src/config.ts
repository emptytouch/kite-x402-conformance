import { isAddress } from "viem";
import { z } from "zod";

import type { KiteNetworkName } from "./networks.js";

/**
 * Environment configuration, validated at startup.
 *
 * Every value is optional except the network: dry-run checks work with no
 * configuration at all. Invalid values fail fast with a readable message instead
 * of producing a half-working run.
 */

const blankToUndefined = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
};

const optionalUrl = z.preprocess(blankToUndefined, z.string().url().optional());
const optionalAddress = z.preprocess(
  blankToUndefined,
  z
    .string()
    .refine((value) => isAddress(value), { message: "must be a 0x-prefixed EVM address" })
    .optional(),
);

const EnvSchema = z.object({
  KITE_NETWORK: z.preprocess(blankToUndefined, z.enum(["mainnet", "testnet"]).default("testnet")),
  KITE_RPC_URL: optionalUrl,
  KITE_FACILITATOR_URL: optionalUrl,
  KITE_ASSET_ADDRESS: optionalAddress,
  KITE_EXPECTED_PAY_TO: optionalAddress,
  KITE_PAYER_PRIVATE_KEY: z.preprocess(
    blankToUndefined,
    z
      .string()
      .regex(/^0x[0-9a-fA-F]{64}$/, "must be a 32-byte hex string")
      .optional(),
  ),
});

export interface Config {
  readonly network: KiteNetworkName;
  readonly rpcUrl: string | undefined;
  readonly facilitatorUrl: string | undefined;
  readonly assetAddress: string | undefined;
  readonly expectedPayTo: string | undefined;
  /** Present only when the caller intends to run the opt-in live mode. */
  readonly payerPrivateKey: string | undefined;
}

export class ConfigError extends Error {
  public readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`invalid configuration:\n  - ${issues.join("\n  - ")}`);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
    );
  }

  const value = parsed.data;
  return {
    network: value.KITE_NETWORK,
    rpcUrl: value.KITE_RPC_URL,
    facilitatorUrl: value.KITE_FACILITATOR_URL,
    assetAddress: value.KITE_ASSET_ADDRESS,
    expectedPayTo: value.KITE_EXPECTED_PAY_TO,
    payerPrivateKey: value.KITE_PAYER_PRIVATE_KEY,
  };
}
