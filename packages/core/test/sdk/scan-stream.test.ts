import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT } from "../../src/cli/exit.js";
import { definePlugin } from "../../src/plugins/base.js";
import { ScopeError } from "../../src/scope.js";
import { type ScanEvent, scanStream } from "../../src/sdk/scan-stream.js";
import { scan } from "../../src/sdk/scan.js";

let dir: string;
beforeEach(async () => {
  dir = await realpath(await mkdtemp(path.join(tmpdir(), "cyberkit-stream-")));
  await writeFile(path.join(dir, "package.json"), JSON.stringify({ dependencies: { left: "*", lodahs: "1.0.0" } }, null, 2));
  await writeFile(path.join(dir, "package-lock.json"), "{}");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const delayed = (name: string, ms: number, severity = "high") =>
  definePlugin({ name, run: () => new Promise((r) => setTimeout(() => r([{ ruleId: "r", severity, message: `from ${name}` }]), ms)) });

async function collect(it: AsyncIterable<ScanEvent>): Promise<ScanEvent[]> {
  const out: ScanEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe("scanStream()", () => {
  it("emits start first and end last with summary and exit code", async () => {
    const events = await collect(scanStream({ target: dir }));
    expect(events[0]).toEqual({ type: "start", root: dir });
    const end = events.at(-1);
    expect(end).toMatchObject({ type: "end", exitCode: EXIT.FINDINGS, summary: { total: 2 } });
    expect(events.filter((e) => e.type === "start" || e.type === "end")).toHaveLength(2);
  });

  it("yields the same findings and exit code as scan() (SDK parity)", async () => {
    const plugins = [delayed("p1", 10), delayed("p2", 30, "low")];
    const events = await collect(scanStream({ target: dir, plugins }));
    const streamed = events.flatMap((e) => (e.type === "finding" ? [e.finding.id] : []));
    const result = await scan({ target: dir, plugins });
    expect([...streamed].sort()).toEqual(result.findings.map((f) => f.id).sort());
    expect(events.at(-1)).toMatchObject({ exitCode: result.exitCode, summary: { total: result.summary.total } });
  });

  it("streams fast results before slow plugins finish", async () => {
    const events: string[] = [];
    for await (const e of scanStream({ target: dir, plugins: [delayed("slow", 400), delayed("fast", 10)] })) {
      if (e.type === "finding") events.push(e.finding.engine);
      if (e.type === "plugin") events.push(`done:${e.result.name}`);
    }
    expect(events.indexOf("plugin:fast")).toBeLessThan(events.indexOf("done:slow"));
    expect(events.indexOf("supply-chain")).toBeLessThan(events.indexOf("done:slow"));
  });

  it("emits one plugin event per plugin, without duplicating its findings", async () => {
    const events = await collect(scanStream({ target: dir, plugins: [delayed("a", 5)] }));
    const pluginEvents = events.filter((e) => e.type === "plugin");
    expect(pluginEvents).toHaveLength(1);
    expect(pluginEvents[0]).toMatchObject({ result: { name: "a", status: "ok", findingCount: 1 } });
    expect(pluginEvents[0]).not.toHaveProperty("result.findings");
  });

  it("never yields the same finding twice", async () => {
    const events = await collect(scanStream({ target: dir, plugins: [delayed("dup", 5), delayed("dup", 15)] }));
    const ids = events.flatMap((e) => (e.type === "finding" ? [e.finding.id] : []));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("lets the consumer stop early without waiting for slow plugins", async () => {
    const start = performance.now();
    for await (const e of scanStream({ target: dir, plugins: [delayed("very-slow", 2000)] })) {
      if (e.type === "finding") break;
    }
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it("reports PARTIAL in the end event when a plugin times out", async () => {
    const hang = definePlugin({ name: "hang", run: () => new Promise(() => {}) });
    const events = await collect(scanStream({ target: dir, plugins: [hang], pluginTimeoutMs: 100, failOn: "critical" }));
    expect(events.find((e) => e.type === "plugin")).toMatchObject({ result: { status: "timeout" } });
    expect(events.at(-1)).toMatchObject({ type: "end", exitCode: EXIT.PARTIAL });
  });

  it("throws setup errors on the first iteration", async () => {
    await expect(collect(scanStream({ target: path.join(dir, "missing") }))).rejects.toThrow(ScopeError);
  });
});
