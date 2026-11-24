import { describe, expect, it } from "vitest";
import { REDACTED, redact } from "../src/index.js";

const SECRETS = [
  "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8",
  "AKIA" + "IOSFODNN7EXAMPLE",
  "hunter2-db-pass",
  "sessionvalue987",
  "bearer-secret-xyz",
  "QUJDREVGR0hJSktMTU5PUA",
  "s3cr3t-url-pass",
];

const LOG = `
[2026-11-24T10:00:00Z] GET /api/users HTTP/1.1
Host: api.example.com
Authorization: Bearer bearer-secret-xyz
Cookie: session=sessionvalue987; theme=dark
User-Agent: cyberkit/0.1.0

env: DB_PASSWORD=hunter2-db-pass
env: GITHUB_TOKEN=${SECRETS[0]}
aws key ${SECRETS[1]} found in config
remote: https://deploy:s3cr3t-url-pass@git.example.com/org/repo.git

-----BEGIN OPENSSH PRIVATE KEY-----
${SECRETS[5]}
-----END OPENSSH PRIVATE KEY-----

Scan finished: 3 findings in src/app.ts
`;

describe("redaction (public API, realistic log)", () => {
  const out = redact(LOG);

  it("leaves none of the secrets in the output", () => {
    for (const s of SECRETS) expect(out).not.toContain(s);
  });

  it("keeps non-secret context intact", () => {
    expect(out).toContain("GET /api/users HTTP/1.1");
    expect(out).toContain("Host: api.example.com");
    expect(out).toContain("User-Agent: cyberkit/0.1.0");
    expect(out).toContain("https://deploy:");
    expect(out).toContain("@git.example.com/org/repo.git");
    expect(out).toContain("Scan finished: 3 findings in src/app.ts");
  });

  it("marks each redaction", () => {
    expect(out.split(REDACTED).length - 1).toBeGreaterThanOrEqual(6);
  });

  it("is stable when applied repeatedly", () => {
    expect(redact(out)).toBe(out);
  });

  it("does not mutate the caller's string", () => {
    const input = "password=abc";
    redact(input);
    expect(input).toBe("password=abc");
  });
});
