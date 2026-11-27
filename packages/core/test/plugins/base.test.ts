import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REDACTED } from "../../src/redaction.js";
import { type Scope, createScope } from "../../src/scope.js";
import { MAX_TEXT_CHARS, PluginError, definePlugin, runPlugin, runPluginModule } from "../../src/plugins/base.js";

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

describe("runPlugin: output processing is bounded (#52)", () => {
  const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/plugins");

  it("caps message and evidence at MAX_TEXT_CHARS with an ellipsis", async () => {
    const huge = "A".repeat(4 * 1024 * 1024);
    const res = await runPlugin(definePlugin({ name: "big", run: async () => [{ ...finding, message: huge, evidence: huge }] }), scope);
    expect(res.status).toBe("ok");
    expect(res.findings[0]?.message).toHaveLength(MAX_TEXT_CHARS + 1);
    expect(res.findings[0]?.message.endsWith("…")).toBe(true);
    expect(res.findings[0]?.evidence).toHaveLength(MAX_TEXT_CHARS + 1);
  });

  it("redacts a secret that straddles the cut instead of leaving half of it", async () => {
    const message = "A ".repeat((MAX_TEXT_CHARS - 10) / 2) + GH + " tail";
    const res = await runPlugin(definePlugin({ name: "straddle", run: async () => [{ ...finding, message }] }), scope);
    expect(res.findings[0]?.message).not.toContain("ghp_");
    expect(res.findings[0]?.message).not.toContain(GH.slice(0, 10));
  });

  it("examines at most maxItems items and marks the result truncated", async () => {
    const items = Array.from({ length: 100_000 }, (_, i) => ({ ...finding, file: `../x/${i}.js` }));
    const start = performance.now();
    const res = await runPlugin(definePlugin({ name: "flood", run: async () => items }), scope, { timeoutMs: 1000 });
    expect(performance.now() - start).toBeLessThan(2000);
    expect(res.status).toBe("ok");
    expect(res.truncated).toBe(true);
    expect(res.skipped).toBe(20_000); // default maxItems = 2 x maxFindings
  });

  it("respects an explicit maxItems", async () => {
    const items = Array.from({ length: 50 }, () => ({ ...finding, file: "../outside.js" }));
    items.push({ ...finding, file: "src/a.ts" });
    const res = await runPlugin(definePlugin({ name: "few", run: async () => items }), scope, { maxItems: 10 });
    expect(res.skipped).toBe(10);
    expect(res.findings).toHaveLength(0);
    expect(res.truncated).toBe(true);
  });

  it("gives up with invalid-output once validation exceeds the plugin's time budget", async () => {
    const items = Array.from({ length: 200_000 }, (_, i) => ({ ...finding, file: `/nonexistent-cyberkit/${i}/a.js` }));
    const start = performance.now();
    const res = await runPlugin(definePlugin({ name: "slow-output", run: async () => items }), scope, { timeoutMs: 1, maxItems: 200_000 });
    expect(res.status).toBe("invalid-output");
    expect(res.error).toMatch(/time limit/);
    expect(res.findings).toHaveLength(0);
    expect(performance.now() - start).toBeLessThan(3000); // 1 ms + 1 s grace + slack
  });

  it("bounds a worker plugin's output the same way", async () => {
    const start = performance.now();
    const res = await runPluginModule(path.join(FIXTURES, "flood.mjs"), scope, { timeoutMs: 5000 });
    expect(res.status).toBe("ok");
    expect(res.truncated).toBe(true);
    expect(res.findings[0]?.message).toHaveLength(MAX_TEXT_CHARS + 1);
    expect(res.skipped).toBe(19_999);
    expect(performance.now() - start).toBeLessThan(5000);
  });
});

describe("ctx.resolve (#56)", () => {
  const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/plugins");

  it("resolves through the scope in-process and refuses escapes", async () => {
    const seen: Record<string, boolean> = {};
    await runPlugin(
      definePlugin({
        name: "resolver",
        async run(ctx) {
          for (const p of ["src/a.ts", "../outside.txt", "/etc/hosts"]) seen[p] = await ctx.resolve(p).then(() => true, () => false);
          return [];
        },
      }),
      scope,
    );
    expect(seen).toEqual({ "src/a.ts": true, "../outside.txt": false, "/etc/hosts": false });
  });

  it("applies the same containment rule inside a worker, including symlinks", async () => {
    await symlink(tmpdir(), path.join(dir, "link-out")).catch(() => undefined);
    const res = await runPluginModule(path.join(FIXTURES, "resolver.mjs"), scope);
    expect(res.status).toBe("ok");
    const byPath = Object.fromEntries(res.findings.map((f) => [f.message, f.ruleId]));
    expect(byPath).toEqual({ "src/a.ts": "accepted", "../outside.txt": "refused", "/etc/hosts": "refused", "link-out": "refused" });
  });
});
