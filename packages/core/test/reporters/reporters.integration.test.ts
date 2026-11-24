import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createScope, createStore, renderJson, renderPlain, renderSarif, scanSupplyChain, verifyFinding } from "../../src/index.js";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "cyberkit-reporters-int-"));
  await writeFile(path.join(dir, "package.json"), JSON.stringify({ dependencies: { lodahs: "1.0.0", b: "git+https://user:hunter2pw@example.com/b.git", c: "*" } }, null, 2));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("one scan, three reporters (public API)", () => {
  it("all reporters agree on the findings and none leaks the secret", async () => {
    const store = createStore(path.join(dir, "findings.jsonl"));
    await store.appendMany(await scanSupplyChain(await createScope(dir)));
    const findings = await store.readAll();

    const json = JSON.parse(renderJson(findings)) as { summary: { total: number }; findings: unknown[] };
    const sarif = JSON.parse(renderSarif(findings)) as { runs: { results: { partialFingerprints: Record<string, string> }[] }[] };
    const plain = renderPlain(findings);

    expect(json.summary.total).toBe(findings.length);
    for (const f of json.findings) expect(() => verifyFinding(f)).not.toThrow();
    expect(sarif.runs[0]?.results.map((r) => r.partialFingerprints["cyberkitFindingId/v1"]).sort()).toEqual(findings.map((f) => f.id).sort());
    expect(plain.split("\n")[0]).toContain(`${findings.length} findings`);
    for (const out of [renderJson(findings), renderSarif(findings), plain]) expect(out).not.toContain("hunter2pw");
  });
});
