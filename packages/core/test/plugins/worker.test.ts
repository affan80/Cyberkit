import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type Scope, createScope } from "../../src/scope.js";
import { runPluginModule } from "../../src/plugins/base.js";

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/plugins");
const fixture = (name: string) => path.join(FIXTURES, name);

let dir: string;
let scope: Scope;
beforeAll(async () => {
  dir = await realpath(await mkdtemp(path.join(tmpdir(), "cyberkit-worker-")));
  scope = await createScope(dir);
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("runPluginModule (worker-isolated plugins)", () => {
  it("runs a well-behaved plugin module", async () => {
    const res = await runPluginModule(fixture("good.mjs"), scope);
    expect(res).toMatchObject({ name: "good", status: "ok" });
    expect(res.findings[0]).toMatchObject({ engine: "plugin:good", ruleId: "demo", message: "scanned root" });
  });

  it("contains a module that throws at import time, with a redacted error", async () => {
    const res = await runPluginModule(fixture("throws-on-import.mjs"), scope);
    expect(res.status).toBe("error");
    expect(res.error).toContain("boom");
    expect(res.error).not.toContain("hunter2");
  });

  it("hard-kills a plugin stuck in a synchronous infinite loop", async () => {
    const start = performance.now();
    const res = await runPluginModule(fixture("infinite-loop.mjs"), scope, { timeoutMs: 200 });
    expect(res.status).toBe("timeout");
    expect(performance.now() - start).toBeLessThan(3000);
  });

  it("survives a plugin calling process.exit", async () => {
    const res = await runPluginModule(fixture("exits.mjs"), scope);
    expect(res.status).toBe("crashed");
    expect(res.error).toMatch(/exit/i);
  });

  it("contains a plugin that exhausts its memory limit", async () => {
    const res = await runPluginModule(fixture("memory-hog.mjs"), scope, { maxMemoryMb: 32, timeoutMs: 10_000 });
    expect(["crashed", "error"]).toContain(res.status);
  }, 15_000);

  it("isolates env, globals and stdio from the host", async () => {
    process.env.CYBERKIT_TEST_SECRET = "host-only-value";
    const out = vi.spyOn(process.stdout, "write");
    const err = vi.spyOn(process.stderr, "write");
    try {
      const res = await runPluginModule(fixture("noisy-and-nosy.mjs"), scope);
      expect(res.status).toBe("ok");
      expect(res.findings[0]?.message).toContain("hostvar:absent");
      expect(res.findings[0]?.message).toContain("path:set");
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      expect((globalThis as Record<string, unknown>).hostGlobal).toBeUndefined();
      const written = [...out.mock.calls, ...err.mock.calls].map((c) => String(c[0])).join("");
      expect(written).not.toContain("PLUGIN-STDOUT-MARKER");
      expect(written).not.toContain("PLUGIN-STDERR-MARKER");
    } finally {
      out.mockRestore();
      err.mockRestore();
      delete process.env.CYBERKIT_TEST_SECRET;
    }
  });

  it("reports a module without a plugin export as invalid", async () => {
    const res = await runPluginModule(fixture("no-export.mjs"), scope);
    expect(res.status).toBe("invalid-output");
  });

  it("reports a missing module as an error", async () => {
    const res = await runPluginModule(fixture("does-not-exist.mjs"), scope);
    expect(res.status).toBe("error");
  });
});
