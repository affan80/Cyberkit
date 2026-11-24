import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { parseScopeConfig } from "../src/scope-file.js";

const SCHEMA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../docs/scope.schema.json");

const SAMPLES: unknown[] = [
  { version: 1 },
  { version: 1, include: ["src", "packages/*/src"], exclude: ["**/fixtures", "dist/**", "*.min.js"] },
  { $schema: "https://example.invalid/scope.schema.json", version: 1, exclude: [] },
  {},
  { version: 2 },
  { version: 1, exlude: ["x"] },
  { version: 1, exclude: "dist" },
  { version: 1, exclude: [""] },
  { version: 1, exclude: ["/abs"] },
  { version: 1, include: [".."] },
  { version: 1, include: ["a/../b"] },
  { version: 1, include: ["a/.."] },
  { version: 1, exclude: ["a\\b"] },
  { version: 1, exclude: ["a\u0000b"] },
  { version: 1, exclude: [1] },
  { version: 1, exclude: ["a".repeat(1025)] },
  { version: 1, exclude: Array.from({ length: 1001 }, (_, i) => `p${i}`) },
  { version: 1, exclude: ["..foo", "foo..", "a/..b/c"] },
  [],
  null,
];

describe("docs/scope.schema.json", () => {
  it("agrees with the runtime validator on every sample", async () => {
    const schema = JSON.parse(await readFile(SCHEMA, "utf8")) as object;
    const validate = new Ajv2020.default({ strict: true }).compile(schema);
    for (const sample of SAMPLES) {
      let runtime = true;
      try {
        parseScopeConfig(sample);
      } catch {
        runtime = false;
      }
      expect(validate(sample), JSON.stringify(sample).slice(0, 80)).toBe(runtime);
    }
  });
});
