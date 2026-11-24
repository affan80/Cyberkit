import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { redact } from "../../src/redaction.js";

const FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src/data/typosquat-snapshot.json");
const NPM_NAME = /^[a-z0-9][a-z0-9._-]*$/;

describe("typosquat snapshot data file", async () => {
  const raw = await readFile(FILE, "utf8");
  const snap = JSON.parse(raw) as { version: number; generatedAt: string; source: string; packages: string[] };

  it("has version, generation date and source metadata", () => {
    expect(snap.version).toBe(1);
    expect(snap.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Number.isNaN(Date.parse(snap.generatedAt))).toBe(false);
    expect(snap.source.length).toBeGreaterThan(0);
  });

  it("contains a few hundred well-known packages", () => {
    expect(snap.packages.length).toBeGreaterThanOrEqual(200);
    for (const known of ["lodash", "react", "express", "axios", "typescript", "webpack", "chalk"]) {
      expect(snap.packages).toContain(known);
    }
  });

  it("holds only valid, unscoped, lowercase npm names", () => {
    for (const name of snap.packages) expect(name, name).toMatch(NPM_NAME);
  });

  it("has no duplicates and is sorted (stable diffs)", () => {
    expect(new Set(snap.packages).size).toBe(snap.packages.length);
    expect([...snap.packages].sort()).toEqual(snap.packages);
  });

  it("contains no URLs, tokens or credential-looking strings", () => {
    expect(raw).not.toMatch(/https?:\/\//i);
    // The project's own redactor must find nothing to redact (names like "jsonwebtoken" are fine).
    expect(redact(raw)).toBe(raw);
  });
});
