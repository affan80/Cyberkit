/**
 * Scaling harness (#50): for every redaction rule, an adversarial input of
 * size n and 2n must take roughly twice as long, not four times. Each piece
 * targets a rule's worst case (long runs that almost match).
 *
 * Timing is noisy (CI, other test files running in parallel), so each size
 * takes the best of 3 runs, the ratio is only enforced once the 2n run is
 * long enough to measure, and a pair is re-measured up to 3 times: it passes
 * if any attempt scales linearly. A quadratic rule fails every attempt.
 * Before the fix, "token" x 40k took about 3.4 s.
 */
import { describe, expect, it } from "vitest";
import { createFinding, redact } from "../src/index.js";

const BASE_BYTES = 200_000;
const NOISE_FLOOR_MS = 25;
const ATTEMPTS = 3;
const MAX_RATIO = 3;
const MAX_MS = 1000;

const PIECES: Readonly<Record<string, string>> = {
  // key=value rule (the reported case), one per keyword family
  "key=value: token": "token",
  "key=value: secret_": "secret_",
  "key=value: password": "password",
  "key=value: api-key": "api-key",
  "key=value: authorization": "authorization",
  "key=value: quoted key": '"password"',
  "auth key": "auth",
  // headers
  "header": "Authorization ",
  "JSON header string": '"cookie":"',
  "JSON header array": '"cookie":[',
  // blocks
  "PEM": "-----BEGIN A",
  "PEM without END": "-----BEGIN PRIVATE KEY-----",
  "PuTTY": "PuTTY-User-Key-File-1:",
  // vendor tokens
  "GitHub": "ghp_aaaa_",
  "AWS": "AKIA",
  "Slack token": "xoxb-",
  "npm": "npm_",
  "JWT": "eyJ-",
  "GitLab": "glpat-a",
  "Slack webhook": "https://hooks.slack.com/services/",
  "Stripe": "sk_live_",
  "OpenAI": "sk-a",
  "Google": "AIza",
  // URLs
  "URL scheme run": "a.",
  "URL user:pass": "x://y:",
  "URL token": "a.b://",
  "URL no @": "https://xxxxxxxx",
};

function bestOf3(input: string): number {
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    const start = performance.now();
    redact(input);
    best = Math.min(best, performance.now() - start);
  }
  return best;
}

describe("redaction scales linearly (#50)", () => {
  it.each(Object.entries(PIECES))("%s", (_name, piece) => {
    const n = Math.ceil(BASE_BYTES / piece.length);
    const small = piece.repeat(n);
    const large = piece.repeat(2 * n);
    let worst = "";
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const a = bestOf3(small);
      const b = bestOf3(large);
      if (b < MAX_MS && (b < NOISE_FLOOR_MS || b / Math.max(a, 1) < MAX_RATIO)) return;
      worst = `n: ${a.toFixed(1)} ms, 2n: ${b.toFixed(1)} ms`;
    }
    expect.fail(`super-linear redaction (${worst})`);
  });

  it("creates a finding with a 280 KB adversarial message quickly (issue repro)", () => {
    const start = performance.now();
    createFinding({ engine: "e", ruleId: "r", severity: "low", message: "secret_".repeat(40_000) });
    expect(performance.now() - start).toBeLessThan(MAX_MS);
  });
});
