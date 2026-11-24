import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createScope, createStore, renderPlain, scanSupplyChain } from "../../src/index.js";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "cyberkit-plain-int-"));
  await writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({ dependencies: { lodahs: "1.0.0", b: "git+https://user:hunter2pw@example.com/b.git", "\u001b[31mevil": "*" } }, null, 2),
  );
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("scan -> store -> plain report (public API)", () => {
  it("renders a real scan, read back from the store, safely and deterministically", async () => {
    const scope = await createScope(dir);
    const store = createStore(path.join(dir, "findings.jsonl"));
    await store.appendMany(await scanSupplyChain(scope));
    const findings = await store.readAll();

    const report = renderPlain(findings);
    expect(report.split("\n")[0]).toMatch(/^CyberKit: \d+ findings \(.*high.*\)$/);
    expect(report).toContain("supply-chain/possible-typosquat");
    expect(report).toContain("package.json:");
    expect(report).not.toContain("hunter2pw");
    expect(report).not.toContain("\u001b");
    expect(renderPlain([...findings].reverse())).toBe(report);
  });
});
