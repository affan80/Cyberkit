import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createScope, scanSupplyChain } from "../../src/index.js";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "cyberkit-typo-int-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function scan(deps: Record<string, string>) {
  await writeFile(path.join(dir, "package.json"), JSON.stringify({ dependencies: deps }, null, 2));
  await writeFile(path.join(dir, "package-lock.json"), "{}");
  return scanSupplyChain(await createScope(dir));
}

describe("typosquat detection inside the default engine (public API)", () => {
  it("reports look-alikes with file and line, offline", async () => {
    const fs = await scan({ react: "^18.0.0", lodahs: "^4.0.0", "l0dash": "^4.0.0" });
    const typos = fs.filter((f) => f.ruleId === "possible-typosquat");
    expect(typos.map((f) => [f.severity, f.line])).toEqual([
      ["medium", 4],
      ["high", 5],
    ]);
    expect(typos.every((f) => f.engine === "supply-chain" && f.file === "package.json")).toBe(true);
  });

  it("stays quiet for a project made only of popular packages", async () => {
    expect(await scan({ react: "^18.0.0", express: "^4.0.0", lodash: "^4.17.21", axios: "^1.0.0" })).toEqual([]);
  });
});
