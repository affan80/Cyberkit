import { describe, expect, it } from "vitest";
import { REDACTED, redact } from "../src/redaction.js";

const GH = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
const AWS = "AKIA" + "IOSFODNN7EXAMPLE";
const JWT =
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
const PEM = [
  "-----BEGIN RSA PRIVATE KEY-----",
  "MIIEowIBAAKCAQEAfakefakefakefake",
  "-----END RSA PRIVATE KEY-----",
].join("\n");

describe("redact: tokens", () => {
  it.each([
    ["GitHub token", GH],
    ["fine-grained GitHub PAT", "github_pat_" + "A".repeat(30)],
    ["AWS access key id", AWS],
    ["Slack token", "xoxb-" + "1234567890-abcdefghij"],
    ["npm token", "npm_" + "a".repeat(36)],
    ["JWT", JWT],
  ])("removes a %s", (_name, secret) => {
    const out = redact(`value is ${secret} end`);
    expect(out).not.toContain(secret);
    expect(out).toContain(REDACTED);
    expect(out).toMatch(/^value is .* end$/);
  });
});

describe("redact: auth headers and cookies", () => {
  it("redacts Bearer authorization but keeps the header name", () => {
    expect(redact("Authorization: Bearer abc.def.ghi")).toBe(`Authorization: ${REDACTED}`);
  });

  it("redacts Basic authorization case-insensitively", () => {
    expect(redact("authorization: Basic dXNlcjpwYXNz")).toBe(`authorization: ${REDACTED}`);
  });

  it("redacts proxy-authorization and x-api-key", () => {
    expect(redact("Proxy-Authorization: Basic zzz")).toBe(`Proxy-Authorization: ${REDACTED}`);
    expect(redact("X-Api-Key: sk_live_12345")).toBe(`X-Api-Key: ${REDACTED}`);
  });

  it("redacts every cookie in Cookie and Set-Cookie", () => {
    expect(redact("Cookie: sid=abc123; theme=dark")).toBe(`Cookie: ${REDACTED}`);
    expect(redact("Set-Cookie: sid=abc123; Path=/; HttpOnly")).toBe(`Set-Cookie: ${REDACTED}`);
  });

  it("only redacts to the end of the line", () => {
    expect(redact("Cookie: a=b\nHost: example.com")).toBe(`Cookie: ${REDACTED}\nHost: example.com`);
  });
});

describe("redact: credentials", () => {
  it.each([
    ["password=hunter2", "password="],
    ["PASSWORD: hunter2", "PASSWORD: "],
    ['"api_key": "hunter2"', '"api_key": "'],
    ["client_secret = hunter2", "client_secret = "],
    ["access_token=hunter2", "access_token="],
  ])("redacts the value in %s", (input, prefix) => {
    const out = redact(input);
    expect(out).not.toContain("hunter2");
    expect(out.startsWith(prefix)).toBe(true);
    expect(out).toContain(REDACTED);
  });

  it("redacts credentials in URLs", () => {
    const out = redact("git clone https://user:s3cr3t@example.com/repo.git");
    expect(out).not.toContain("s3cr3t");
    expect(out).toContain("https://user:");
    expect(out).toContain("@example.com/repo.git");
  });
});

describe("redact: PEM keys", () => {
  it("replaces the whole block including headers", () => {
    const out = redact(`before\n${PEM}\nafter`);
    expect(out).toBe(`before\n${REDACTED}\nafter`);
  });

  it.each(["PRIVATE KEY", "EC PRIVATE KEY", "OPENSSH PRIVATE KEY", "ENCRYPTED PRIVATE KEY"])(
    "handles %s blocks",
    (label) => {
      const block = `-----BEGIN ${label}-----\nQUJD\n-----END ${label}-----`;
      expect(redact(block)).toBe(REDACTED);
    },
  );

  it("redacts a truncated block with no END marker", () => {
    const out = redact("-----BEGIN PRIVATE KEY-----\nQUJDREVG\nmore");
    expect(out).not.toContain("QUJDREVG");
  });
});

describe("redact: safety properties", () => {
  it("leaves clean text unchanged", () => {
    const text = "Found 3 issues in src/index.ts: password handling is documented.";
    expect(redact(text)).toBe(text);
  });

  it("is idempotent", () => {
    const text = `Authorization: Bearer x\npassword=hunter2\n${GH}\n${PEM}`;
    const once = redact(text);
    expect(redact(once)).toBe(once);
  });

  it("returns an empty string for empty input", () => {
    expect(redact("")).toBe("");
  });

  it("does not mutate or depend on previous calls (no global regex state)", () => {
    const a = redact(`token=${GH}`);
    const b = redact(`token=${GH}`);
    expect(a).toBe(b);
  });

  it("handles large inputs in linear-ish time (no ReDoS)", () => {
    const evil = "password=" + "a".repeat(200_000) + "\n" + "-----BEGIN PRIVATE KEY-----".repeat(2000);
    const start = performance.now();
    redact(evil);
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it("stays linear on adversarial input for the vendor-token and key-block rules (#48)", () => {
    const evil = [
      "sk-".repeat(50_000),
      "glpat-".repeat(30_000),
      "AIza".repeat(50_000),
      "https://hooks.slack.com/services/".repeat(5000),
      "PuTTY-User-Key-File-1:".repeat(5000),
      "-----BEGIN PGP PRIVATE KEY BLOCK-----".repeat(5000),
    ].join("\n");
    const start = performance.now();
    redact(evil);
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it("stays linear on adversarial input for the structural rules (#49)", () => {
    const evil = [
      '"cookie": "'.repeat(20_000),
      '"set-cookie": ['.repeat(20_000),
      '{"authorization": "' + "a".repeat(200_000),
      "https://".repeat(30_000),
      "x".repeat(200_000) + "@",
      "auth=".repeat(40_000),
    ].join("\n");
    const start = performance.now();
    redact(evil);
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it("throws a TypeError for non-string input", () => {
    expect(() => redact(undefined as unknown as string)).toThrow(TypeError);
  });
});
