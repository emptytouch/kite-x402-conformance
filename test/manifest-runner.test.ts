import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { sameOrigin } from "../src/cli.js";
import { parseManifest } from "../src/manifest.js";
import {
  isManifestSource,
  runManifestProbes,
  type ManifestProbeOptions,
} from "../src/probes/manifest.js";
import { encodeHeaderValue } from "../src/wire.js";

const PAY_TO = `0x${"1".repeat(40)}`;
const ASSET = `0x${"2".repeat(40)}`;

function manifestJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    endpoints: [
      {
        path: "/v1/echo",
        network: "eip155:2368",
        payTo: PAY_TO,
        asset: ASSET,
        amount: "1000",
        ...overrides,
      },
    ],
  });
}

function challenge(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    x402Version: 2,
    accepts: [
      {
        scheme: "exact",
        network: "eip155:2368",
        payTo: PAY_TO,
        asset: ASSET,
        amount: "1000",
        ...overrides,
      },
    ],
  };
}

function fakeFetcher(
  responses: Record<string, { status: number; headers: Record<string, string> }>,
): NonNullable<ManifestProbeOptions["fetcher"]> {
  return async (url) => {
    const path = new URL(url).pathname;
    const response = responses[path];
    if (response === undefined) throw new Error(`unexpected URL ${url}`);
    return response;
  };
}

function goodResponse(overrides: Record<string, unknown> = {}): {
  status: number;
  headers: Record<string, string>;
} {
  return {
    status: 402,
    headers: { "payment-required": encodeHeaderValue(challenge(overrides)) },
  };
}

describe("parseManifest", () => {
  it("parses JSON manifests and keeps amounts as strings", () => {
    const parsed = parseManifest(manifestJson());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]).toMatchObject({ path: "/v1/echo", amount: "1000" });
  });

  it("rejects a JSON number amount instead of stringifying a rounded value", () => {
    const parsed = parseManifest(manifestJson({ amount: 9007199254740993 }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(/amount must be a canonical decimal string/);
  });

  it("rejects leading zeros in amounts", () => {
    const parsed = parseManifest(manifestJson({ amount: "00100" }));
    expect(parsed.ok).toBe(false);
  });

  it("parses the supported YAML subset", () => {
    const yaml = [
      "endpoints:",
      "  - path: /v1/echo",
      "    network: eip155:2368",
      `    payTo: ${PAY_TO}`,
      `    asset: ${ASSET}`,
      '    amount: "1000"',
      "",
    ].join("\n");
    const parsed = parseManifest(yaml);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.entries[0]).toMatchObject({
      path: "/v1/echo",
      network: "eip155:2368",
      amount: "1000",
    });
  });

  it("rejects YAML anchors rather than half-understanding them", () => {
    const yaml = ["endpoints:", "  - &x path: /v1/echo"].join("\n");
    expect(parseManifest(yaml).ok).toBe(false);
  });

  it("preserves duplicate declarations for the verdict layer", () => {
    const text = JSON.stringify({
      endpoints: [
        { path: "/v1/echo", network: 2368, payTo: PAY_TO, asset: ASSET, amount: "1000" },
        { path: "/v1/echo", network: 2368, payTo: PAY_TO, asset: ASSET, amount: "2000" },
      ],
    });
    const parsed = parseManifest(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.entries).toHaveLength(2);
  });
});

it("accepts JSON and YAML manifests with a UTF-8 BOM", () => {
  const withBom = `\uFEFF${manifestJson()}`;
  expect(parseManifest(withBom).ok).toBe(true);
  const yaml = [
    "endpoints:",
    "  - path: /v1/echo",
    "    network: eip155:2368",
    `    payTo: ${PAY_TO}`,
    `    asset: ${ASSET}`,
    '    amount: "1000"',
    "",
  ].join("\n");
  expect(parseManifest(`\uFEFF${yaml}`).ok).toBe(true);
});

describe("isManifestSource", () => {
  it("accepts only the four documented sources", () => {
    for (const source of ["static-file", "well-known", "challenge-echo", "unknown"])
      expect(isManifestSource(source)).toBe(true);
    for (const source of ["", "echo", "local", 1, undefined])
      expect(isManifestSource(source)).toBe(false);
  });
});

const entries = [
  { path: "/v1/echo", network: "eip155:2368", payTo: PAY_TO, asset: ASSET, amount: "1000" },
] as const;

describe("runManifestProbes", () => {
  it("produces a clean 12/12 verdict when the manifest matches the live challenge", async () => {
    const run = await runManifestProbes({
      entries: [...entries],
      baseUrl: "https://seller.example",
      source: "static-file",
      fetcher: fakeFetcher({ "/v1/echo": goodResponse() }),
    });
    expect(run.results).toHaveLength(12);
    expect(run.results.every((result) => result.status === "pass")).toBe(true);
    expect(run.probes[0]?.hasPaymentRequired).toBe(true);
  });

  it("reports a value mismatch from the real response, not from the manifest", async () => {
    const run = await runManifestProbes({
      entries: [...entries],
      baseUrl: "https://seller.example",
      source: "static-file",
      fetcher: fakeFetcher({ "/v1/echo": goodResponse({ amount: "9999" }) }),
    });
    const amount = run.results.find((result) => result.id === "c1.amount-match");
    expect(amount?.status).toBe("fail");
    expect(amount?.detail).toContain("9999");
  });

  it("marks a non-402 response as an observation and fails challenge-shape", async () => {
    const run = await runManifestProbes({
      entries: [...entries],
      baseUrl: "https://seller.example",
      source: "static-file",
      fetcher: fakeFetcher({ "/v1/echo": { status: 200, headers: {} } }),
    });
    const shape = run.results.find((result) => result.id === "c1.challenge-shape");
    expect(shape?.status).toBe("fail");
    expect(run.probes[0]?.hasPaymentRequired).toBe(false);
  });

  it("throws a runner error when the header exists but cannot be decoded", async () => {
    await expect(
      runManifestProbes({
        entries: [...entries],
        baseUrl: "https://seller.example",
        source: "static-file",
        fetcher: fakeFetcher({
          "/v1/echo": { status: 402, headers: { "payment-required": "not-json" } },
        }),
      }),
    ).rejects.toThrow(/cannot be decoded/);
  });

  it("throws a runner error on transport failure", async () => {
    await expect(
      runManifestProbes({
        entries: [...entries],
        baseUrl: "https://seller.example",
        source: "static-file",
        fetcher: async () => {
          throw new Error("ECONNRESET");
        },
      }),
    ).rejects.toThrow(/transport failure/);
  });

  it("skips source-dependent checks when the source is unknown", async () => {
    const run = await runManifestProbes({
      entries: [...entries],
      baseUrl: "https://seller.example",
      source: "unknown",
      fetcher: fakeFetcher({ "/v1/echo": goodResponse() }),
    });
    expect(run.results.find((result) => result.id === "c1.source-independent")?.status).toBe("skip");
    // source itself is skipped, plus the ten dependent assertions.
    expect(run.results.filter((result) => result.status === "skip").length).toBe(11);
  });

  it("rejects invalid timeouts and non-http base URLs", async () => {
    for (const timeoutMs of [0, -1, 1.5, Number.NaN]) {
      await expect(
        runManifestProbes({
          entries: [...entries],
          baseUrl: "https://seller.example",
          source: "static-file",
          timeoutMs,
        }),
      ).rejects.toThrow(/timeoutMs/);
    }
    await expect(
      runManifestProbes({
        entries: [...entries],
        baseUrl: "file:///etc/passwd",
        source: "static-file",
      }),
    ).rejects.toThrow(/http or https/);
  });
});

const execFileAsync = promisify(execFile);
const CLI_TIMEOUT = 45_000;

async function invokeCli(args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", ...args],
      { cwd: process.cwd(), timeout: CLI_TIMEOUT },
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

describe("verify-manifest CLI contract", () => {
  it("rejects positional arguments instead of silently running", async () => {
    const result = await invokeCli([
      "verify-manifest",
      "stray",
      "--manifest",
      "missing.json",
      "--base-url",
      "https://seller.example",
    ]);
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("no positional arguments");
  }, CLI_TIMEOUT);

  it("requires exactly one manifest source", async () => {
    const result = await invokeCli(["verify-manifest", "--base-url", "https://seller.example"]);
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("exactly one of --manifest");
  }, CLI_TIMEOUT);

  it("requires --base-url", async () => {
    const result = await invokeCli(["verify-manifest", "--manifest", "missing.json"]);
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("--base-url");
  }, CLI_TIMEOUT);

  it("reports a parse failure as a runner error, not a verdict", async () => {
    const { writeFile, mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "x402conf-manifest-"));
    try {
      const file = join(dir, "broken.json");
      await writeFile(file, "{not json", "utf8");
      const result = await invokeCli([
        "verify-manifest",
        "--manifest",
        file,
        "--base-url",
        "https://seller.example",
      ]);
      expect(result.code).toBe(3);
      expect(result.stderr).toContain("manifest parse failed");
      expect(result.stderr).toContain("not a conformance verdict");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, CLI_TIMEOUT);
});

describe("manifest runner regression guards", () => {
  it("rejects network-path reference paths that escape the base origin", () => {
    for (const path of ["//attacker.example/v1/echo", "/\\attacker.example/v1/echo", "/v1/echo#frag"]) {
      const text = JSON.stringify({
        endpoints: [{ path, network: 2368, payTo: PAY_TO, asset: ASSET, amount: "1000" }],
      });
      expect(parseManifest(text).ok, path).toBe(false);
    }
  });

  it("rejects an escaped path even if it reaches the runner", async () => {
    await expect(
      runManifestProbes({
        entries: [
          {
            path: "//attacker.example/v1/echo",
            network: 2368,
            payTo: PAY_TO,
            asset: ASSET,
            amount: "1000",
          },
        ],
        baseUrl: "https://seller.example",
        source: "static-file",
        fetcher: fakeFetcher({}),
      }),
    ).rejects.toThrow(/escapes the target origin/);
  });

  it("rejects a bare numeric YAML amount", () => {
    const yaml = [
      "endpoints:",
      "  - path: /v1/echo",
      "    network: eip155:2368",
      `    payTo: ${PAY_TO}`,
      `    asset: ${ASSET}`,
      "    amount: 1000",
      "",
    ].join("\n");
    expect(parseManifest(yaml).ok).toBe(false);
  });

  it("accepts unquoted CAIP-2 network but requires quoted numeric network", () => {
    const base = [`  - path: /v1/echo`, `    payTo: ${PAY_TO}`, `    asset: ${ASSET}`, `    amount: "1000"`];
    expect(parseManifest(["endpoints:", ...base, "    network: eip155:2368", ""].join("\n")).ok).toBe(true);
    expect(parseManifest(["endpoints:", ...base, "    network: 2368", ""].join("\n")).ok).toBe(false);
  });

  it("accepts YAML line comments and non-indented sequences", () => {
    const yaml = [
      "endpoints:",
      "- path: /v1/echo  # the endpoint",
      "  network: eip155:2368 # chain",
      `  payTo: ${PAY_TO}`,
      `  asset: ${ASSET}`,
      '  amount: "1000"',
      "",
    ].join("\n");
    expect(parseManifest(yaml).ok).toBe(true);
  });

  it("reads network from the payment option, not a conflicting top-level field", async () => {
    const run = await runManifestProbes({
      entries: [...entries],
      baseUrl: "https://seller.example",
      source: "static-file",
      fetcher: fakeFetcher({
        "/v1/echo": {
          status: 402,
          headers: {
            "payment-required": encodeHeaderValue({
              x402Version: 2,
              network: "eip155:2368",
              accepts: [
                {
                  scheme: "exact",
                  network: "eip155:2366",
                  payTo: PAY_TO,
                  asset: ASSET,
                  amount: "1000",
                },
              ],
            }),
          },
        },
      }),
    });
    expect(run.results.find((result) => result.id === "c1.network-match")?.status).toBe("fail");
  });

  it("does not stringify array fields into valid-looking values", async () => {
    await expect(
      runManifestProbes({
        entries: [...entries],
        baseUrl: "https://seller.example",
        source: "static-file",
        fetcher: fakeFetcher({
          "/v1/echo": goodResponse({ payTo: [PAY_TO] }),
        }),
      }),
    ).rejects.toThrow(/missing a required payment field/);
  });

  it("rejects conflicting amount aliases instead of silently taking one", async () => {
    // Two aliases with different amounts are not "tolerant naming" — there is
    // no single real amount to compare. The old behaviour picked
    // maxAmountRequired and let C2/C3/C1 disagree on the same quote.
    await expect(
      runManifestProbes({
        entries: [...entries],
        baseUrl: "https://seller.example",
        source: "static-file",
        fetcher: fakeFetcher({
          "/v1/echo": goodResponse({ amount: "1000", maxAmountRequired: "9999" }),
        }),
      }),
    ).rejects.toThrow(/conflicting amount aliases/);
  });

  it("accepts both amount aliases when their values agree", async () => {
    const run = await runManifestProbes({
      entries: [...entries],
      baseUrl: "https://seller.example",
      source: "static-file",
      fetcher: fakeFetcher({
        "/v1/echo": goodResponse({ amount: "1000", maxAmountRequired: "1000" }),
      }),
    });
    expect(run.results.find((result) => result.id === "c1.amount-match")?.status).toBe("pass");
  });

  it("skips value assertions when the response is not a challenge", async () => {
    const run = await runManifestProbes({
      entries: [...entries],
      baseUrl: "https://seller.example",
      source: "static-file",
      fetcher: fakeFetcher({ "/v1/echo": { status: 200, headers: {} } }),
    });
    for (const id of ["c1.network-match", "c1.pay-to-match", "c1.asset-match", "c1.amount-match"])
      expect(run.results.find((result) => result.id === id)?.status).toBe("skip");
  });
});

describe("manifest source independence: loopback normalisation", () => {
  it("treats every spelling of the loopback machine as the same origin", () => {
    // A seller must not escape the source check by writing a different
    // loopback alias in its self-echoed well-known URL.
    const base = "http://127.0.0.1:8080";
    for (const alias of [
      "http://localhost:8080",
      "http://localhost.:8080",
      "http://127.0.0.2:8080",
      "http://127.255.255.254:8080",
      "http://0.0.0.0:8080",
      "http://[::1]:8080",
      "http://[::ffff:127.0.0.1]:8080",
      "http://2130706433:8080", // normalised to 127.0.0.1 by WHATWG URL
    ]) {
      expect(sameOrigin(alias, base), alias).toBe(true);
      expect(sameOrigin(base, alias), alias).toBe(true);
    }
  });

  it("keeps genuinely different origins distinct", () => {
    expect(sameOrigin("https://docs.example.org/.well-known/x402", "https://api.example.com")).toBe(false);
    expect(sameOrigin("http://localhost:8080", "https://localhost:8080")).toBe(false);
    expect(sameOrigin("http://example.com", "http://127.0.0.1")).toBe(false);
  });
});

