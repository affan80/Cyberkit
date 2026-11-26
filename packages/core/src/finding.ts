/**
 * Findings: immutable records with deterministic, content-addressed ids.
 * Secrets are redacted at creation in every free-text field (engine, ruleId,
 * message, file, evidence; #55), and the id is derived from the redacted
 * content, so a secret can never influence (or be recovered from) an id.
 */
import { createHash } from "node:crypto";
import { redact } from "./redaction.js";

export const SEVERITIES = ["info", "low", "medium", "high", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];

export interface Finding {
  readonly id: string;
  readonly engine: string;
  readonly ruleId: string;
  readonly severity: Severity;
  readonly message: string;
  readonly file?: string;
  readonly line?: number;
  readonly evidence?: string;
}

export interface FindingInput {
  engine: string;
  ruleId: string;
  severity: string;
  message: string;
  file?: string;
  line?: number;
  evidence?: string;
}

export class FindingError extends Error {
  override readonly name = "FindingError";
}

const isSeverity = (v: unknown): v is Severity => (SEVERITIES as readonly unknown[]).includes(v);

function nonEmpty(value: unknown, what: string): string {
  if (typeof value !== "string" || value.length === 0) throw new FindingError(`${what} must be a non-empty string`);
  return value;
}

/** Validates field shapes and builds the frozen finding around a given id function. */
function build(input: Record<string, unknown>, finalize: (f: Omit<Finding, "id">) => string): Finding {
  const engine = nonEmpty(input.engine, "engine");
  const ruleId = nonEmpty(input.ruleId, "ruleId");
  const message = nonEmpty(input.message, "message");
  if (!isSeverity(input.severity)) throw new FindingError(`severity must be one of: ${SEVERITIES.join(", ")}`);
  const file = input.file === undefined ? undefined : nonEmpty(input.file, "file");
  const evidence = input.evidence === undefined ? undefined : nonEmpty(input.evidence, "evidence");
  const line = input.line;
  if (line !== undefined && !(typeof line === "number" && Number.isInteger(line) && line >= 1)) {
    throw new FindingError("line must be a positive integer");
  }
  const body = { engine, ruleId, severity: input.severity, message, file, line, evidence };
  const id = finalize(body);
  const out: Record<string, unknown> = { id, engine, ruleId, severity: input.severity, message };
  if (file !== undefined) out.file = file;
  if (line !== undefined) out.line = line;
  if (evidence !== undefined) out.evidence = evidence;
  return Object.freeze(out) as unknown as Finding;
}

function computeId(f: Omit<Finding, "id">): string {
  // A JSON array is an unambiguous encoding: fields cannot bleed into each other.
  const canonical = JSON.stringify([f.engine, f.ruleId, f.severity, f.file ?? null, f.line ?? null, f.message]);
  return createHash("sha256").update(canonical).digest("hex");
}

/** Every free-text field. Rule ids come from rule files and paths from the scanned tree, so both can carry secrets. */
const TEXT_FIELDS = ["engine", "ruleId", "message", "file", "evidence"] as const;

export function createFinding(input: FindingInput): Finding {
  const raw = input as unknown as Record<string, unknown>;
  const redacted: Record<string, unknown> = { ...raw };
  for (const field of TEXT_FIELDS) {
    const value = raw[field];
    if (typeof value === "string") redacted[field] = redact(value);
  }
  return build(redacted, computeId);
}

/** Validates an untrusted value (e.g. parsed from disk): shape, redaction and id integrity. */
export function verifyFinding(value: unknown): Finding {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new FindingError("finding must be an object");
  }
  const raw = value as Record<string, unknown>;
  const finding = build(raw, (body) => {
    const id = computeId(body);
    if (raw.id !== id) throw new FindingError("finding id does not match its content");
    return id;
  });
  for (const field of TEXT_FIELDS) {
    const value = finding[field];
    if (value !== undefined && redact(value) !== value) throw new FindingError("finding contains unredacted secrets");
  }
  return finding;
}
