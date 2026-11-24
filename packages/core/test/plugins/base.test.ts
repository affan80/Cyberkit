import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REDACTED } from "../../src/redaction.js";
import { type Scope, createScope } from "../../src/scope.js";
import { PluginError, definePlugin, runPlugin } from "../../src/plugins/base.js";

let dir: string;
let scope: Scope;
const GH = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";

beforeAll(async () => {
  dir = await realpath(await mkdtemp(path.join(tmpdir(), "cyberkit-plugin-")));
  await mkdir(path.join(dir, "src"));
  await writeFile(path.join(dir, "src", "a.ts"), "x");
  scope = await createScope(dir);
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const finding = { ruleId: "r", severity: "low", message: "m" } as const;

describe("definePlugin", () => {
  it("returns a frozen plugin", () => {
    const p = definePlugin({ name: "ok-name", run: async () => [] });
    expect(Object.isFrozen(p)).toBe(true);
  });

  it.each(["", "Bad Name", "../x", "a/b", "x".repeat(65)])("rejects invalid name %j", (name) => {
    expect(() => definePlugin({ name, run: async () => [] })).toThrow(PluginError);
  });

  it("rejects a missing run function", () => {
    expect(() => definePlugin({ name: "x", run: 5 } as never)).toThrow(PluginError);
  });
});

describe("runPlugin (in-process, trusted plugins)", () => {
  it("turns plugin output into findings owned by plugin:<name>", async () => {
    const res = await runPlugin(definePlugin({ name: "demo", run: async () => [{ ...finding, file: "src/a.ts", line: 2 }] }), scope);
    expect(res.status).toBe("ok");
    expect(res.findings).toHaveLength(1);
    expect(res.findings[0]).toMatchObject({ engine: "plugin:demo", ruleId: "r", file: "src/a.ts", line: 2 });
    expect(res.findings[0]?.id).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not let a plugin forge the engine or id", async () => {
    const res = await runPlugin(definePlugin({ name: "demo", run: async () => [{ ...finding, engine: "supply-chain", id: "f".repeat(64) } as never] }), scope);
    expect(res.findings[0]?.engine).toBe("plugin:demo");
    expect(res.findings[0]?.id).not.toBe("f".repeat(64));
  });

  it("redacts secrets in plugin findings", async () => {
    const res = await runPlugin(definePlugin({ name: "demo", run: async () => [{ ...finding, message: `found ${GH}` }] }), scope);
    expect(res.findings[0]?.message).toContain(REDACTED);
    expect(JSON.stringify(res)).not.toContain(GH);
  });

  it("contains a throwing plugin and redacts its error", async () => {
    const res = await runPlugin(definePlugin({ name: "demo", run: async () => { throw new Error(`bad password=hunter2`); } }), scope);
    expect(res.status).toBe("error");
    expect(res.findings).toEqual([]);
    expect(res.error).toContain("bad");
    expect(res.error).not.toContain("hunter2");
  });

  it("contains a plugin that throws synchronously", async () => {
    const res = await runPlugin(definePlugin({ name: "demo", run: () => { throw new TypeError("sync"); } }), scope);
    expect(res.status).toBe("error");
  });

  it("times out a slow plugin and aborts its signal", async () => {
    let signal: AbortSignal | undefined;
    const res = await runPlugin(
      definePlugin({ name: "slow", run: (ctx) => { signal = ctx.signal; return new Promise(() => {}); } }),
      scope,
      { timeoutMs: 50 },
    );
    expect(res.status).toBe("timeout");
    expect(signal?.aborted).toBe(true);
  });

  it("reports non-array output as invalid-output", async () => {
    const res = await runPlugin(definePlugin({ name: "demo", run: async () => "nope" as never }), scope);
    expect(res.status).toBe("invalid-output");
  });

  it("skips invalid items and counts them", async () => {
    const res = await runPlugin(
      definePlugin({ name: "demo", run: async () => [finding, { ruleId: "", severity: "low", message: "m" }, null as never, { ...finding, severity: "urgent" } as never] }),
      scope,
    );
    expect(res.status).toBe("ok");
    expect(res.findings).toHaveLength(1);
    expect(res.skipped).toBe(3);
  });

  it("drops findings that point outside the scope and normalises inside paths", async () => {
    const res = await runPlugin(
      definePlugin({
        name: "demo",
        run: async () => [
          { ...finding, message: "a", file: "../../etc/passwd" },
          { ...finding, message: "b", file: "/etc/passwd" },
          { ...finding, message: "c", file: path.join(dir, "src", "a.ts") },
        ],
      }),
      scope,
    );
    expect(res.findings.map((f) => f.file)).toEqual(["src/a.ts"]);
    expect(res.skipped).toBe(2);
  });

  it("caps the number of findings and flags truncation", async () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ ...finding, message: `m${i}` }));
    const res = await runPlugin(definePlugin({ name: "demo", run: async () => many }), scope, { maxFindings: 10 });
    expect(res.findings).toHaveLength(10);
    expect(res.truncated).toBe(true);
  });

  it("gives the plugin a frozen context with the scope root", async () => {
    let frozen = false;
    let root = "";
    await runPlugin(definePlugin({ name: "demo", run: async (ctx) => { frozen = Object.isFrozen(ctx); root = ctx.root; return []; } }), scope);
    expect(frozen).toBe(true);
    expect(root).toBe(scope.root);
  });

  it("reports how long the plugin ran", async () => {
    const res = await runPlugin(definePlugin({ name: "demo", run: async () => [] }), scope);
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
    expect(res.name).toBe("demo");
  });
});
