/**
 * Corpus-driven redaction tests: every fake secret in the corpus must be gone
 * from redact() output, standalone and embedded in realistic text, and from
 * every report format once it went through a finding.
 */
import { describe, expect, it } from "vitest";
import { REDACTED, createFinding, redact, renderJson, renderPlain, renderSarif } from "../src/index.js";
import { NON_SECRETS, SECRET_CORPUS } from "./fixtures/secret-corpus.js";

describe("redaction corpus", () => {
  it.each(SECRET_CORPUS.map((c) => [c.name, c] as const))("removes a %s", (_name, c) => {
    const out = redact(c.text);
    expect(out).not.toContain(c.secret);
    expect(out).toContain(REDACTED);
  });

  it.each(SECRET_CORPUS.map((c) => [c.name, c] as const))("removes a %s embedded in surrounding text, keeping the context", (_name, c) => {
    const out = redact(`config loaded from .env:\n  value ${c.text}\nscan finished in src/app.ts`);
    expect(out).not.toContain(c.secret);
    expect(out).toMatch(/^config loaded from \.env:\n/);
    if (!c.toEnd) expect(out).toMatch(/scan finished in src\/app\.ts$/);
  });

  it.each(SECRET_CORPUS.map((c) => [c.name, c] as const))("is idempotent for a %s", (_name, c) => {
    const once = redact(c.text);
    expect(redact(once)).toBe(once);
  });

  it.each(NON_SECRETS)("leaves %j untouched", (text) => {
    expect(redact(text)).toBe(text);
  });

  it("keeps every corpus secret out of the text, JSON and SARIF reports", () => {
    const findings = SECRET_CORPUS.map((c, i) =>
      createFinding({ engine: "plugin:test", ruleId: `corpus.${i}`, severity: "high", message: `leaked: ${c.text}`, evidence: c.text, file: "src/a.js", line: i + 1 }),
    );
    for (const report of [renderPlain(findings), renderJson(findings), renderSarif(findings)]) {
      for (const c of SECRET_CORPUS) expect(report).not.toContain(c.secret);
    }
  });
});
