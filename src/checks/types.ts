/**
 * Result model shared by every check.
 *
 * `skip` exists on purpose: a check that cannot be evaluated (missing header,
 * missing configuration) must never be reported as `pass`. Reporting "not
 * verified" as success is how conformance suites become useless.
 */

export type CheckLevel = "critical" | "warning";

export type CheckStatus = "pass" | "fail" | "skip";

export interface CheckResult {
  /** Stable id, e.g. `c2.network`. Used by `--checks` and by CI consumers. */
  readonly id: string;
  readonly title: string;
  readonly level: CheckLevel;
  readonly status: CheckStatus;
  readonly detail: string;
  readonly evidence?: Record<string, unknown>;
}

export function pass(
  id: string,
  title: string,
  detail: string,
  level: CheckLevel = "critical",
  evidence?: Record<string, unknown>,
): CheckResult {
  return { id, title, level, status: "pass", detail, ...(evidence ? { evidence } : {}) };
}

export function fail(
  id: string,
  title: string,
  detail: string,
  level: CheckLevel = "critical",
  evidence?: Record<string, unknown>,
): CheckResult {
  return { id, title, level, status: "fail", detail, ...(evidence ? { evidence } : {}) };
}

export function skip(id: string, title: string, detail: string, level: CheckLevel = "warning"): CheckResult {
  return { id, title, level, status: "skip", detail };
}
