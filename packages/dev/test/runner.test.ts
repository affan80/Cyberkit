import { describe, expect, it } from "vitest";
import { labelFor, sanitizeLine, startRun } from "../src/runner.js";
import type { CommandSpec, RunEvent } from "../src/types.js";

const NODE = process.execPath;
const GH = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
const node = (id: string, code: string, extra: Partial<CommandSpec> = {}): CommandSpec => ({ id, group: "root", name: id, description: code, argv: [NODE, "-e", code], cwd: process.cwd(), ...extra });

async function collect(spec: CommandSpec, specs: CommandSpec[] = [], opts: { cancelAfterMs?: number; killGraceMs?: number; onLine?: (t: string, cancel: () => void) => void } = {}) {
  const events: RunEvent[] = [];
  const byId = new Map(specs.map((s) => [s.id, s]));
  const handle: ReturnType<typeof startRun> = startRun(spec, "r1", {
    resolve: (id) => byId.get(id),
    killGraceMs: opts.killGraceMs ?? 2000,
    onEvent: (e) => {
      events.push(e);
      if (e.type === "lines" && opts.onLine) for (const l of e.lines) opts.onLine(l.text, () => handle?.cancel());
    },
  });
  if (opts.cancelAfterMs !== undefined) setTimeout(() => handle?.cancel(), opts.cancelAfterMs);
  const exit = await handle.done;
  const lines = events.flatMap((e) => (e.type === "lines" ? e.lines : []));
  return { events, exit, lines, texts: lines.map((l) => l.text) };
}

describe("sanitizeLine", () => {
  it("strips ANSI/OSC sequences, keeps the text after the last carriage return and expands tabs", () => {
    expect(sanitizeLine("\u001b[1;31mred\u001b[0m and \u001b]0;title\u0007done")).toBe("red and done");
    expect(sanitizeLine("\u001b]8;;http://x\u001b\\link\u001b]8;;\u001b\\")).toBe("link");
    expect(sanitizeLine("\u009b2Jclear")).toBe("clear");
    expect(sanitizeLine("10%\r50%\r100%")).toBe("100%");
    expect(sanitizeLine("line\r")).toBe("line");
    expect(sanitizeLine("a\tb")).toBe("a       b");
    expect(sanitizeLine("abcdefgh\tx")).toBe("abcdefgh        x");
  });

  it("redacts secrets and escapes leftover control characters", () => {
    expect(sanitizeLine(`token ${GH} password=hunter2`)).not.toMatch(/ghp_|hunter2/);
    // eslint-disable-next-line no-control-regex
    expect(sanitizeLine("bell\u0007 and \u0000nul")).not.toMatch(/[\u0000-\u0008\u000b-\u001f]/);
  });

  it("caps the length, still redacting a secret that straddles the cap", () => {
    const out = sanitizeLine(`${"a".repeat(1990)} ${GH}`, 2000);
    expect(out.length).toBeLessThanOrEqual(2001);
    expect(out).not.toContain("ghp_a1B2");
    expect(sanitizeLine("x".repeat(3000), 100)).toBe(`${"x".repeat(100)}…`);
  });
});

describe("startRun", () => {
  it("streams stdout and stderr lines, joining partial chunks and flushing the last line", async () => {
    const code = `process.stdout.write("hel"); setTimeout(() => { process.stdout.write("lo\\r\\nwor"); process.stderr.write("oops\\n"); setTimeout(() => process.stdout.write("ld"), 20); }, 20);`;
    const { events, exit, lines } = await collect(node("t", code));
    expect(events[0]).toMatchObject({ type: "start", runId: "r1", commandId: "t", label: "t" });
    expect(lines.filter((l) => l.stream === "stdout").map((l) => l.text)).toEqual(["hello", "world"]);
    expect(lines.filter((l) => l.stream === "stderr").map((l) => l.text)).toEqual(["oops"]);
    expect(exit).toMatchObject({ type: "exit", status: "passed", exitCode: 0, signal: null });
    expect(events.filter((e) => e.type === "exit")).toHaveLength(1);
  });

  it("reports failures, signals and the console's env", async () => {
    expect((await collect(node("f", "process.exit(3)"))).exit).toMatchObject({ status: "failed", exitCode: 3 });
    expect((await collect(node("s", "process.kill(process.pid, 'SIGTERM')"))).exit).toMatchObject({ status: "failed", signal: "SIGTERM" });
    const env = await collect(node("e", "console.log([process.env.FORCE_COLOR, process.env.NO_COLOR, process.env.CYBERKIT_DEV].join(','))"));
    expect(env.texts).toContain("0,1,1");
  });

  it("redacts secrets in output", async () => {
    const { texts } = await collect(node("x", `console.log("token ${GH.slice(0, 4)}" + "${GH.slice(4)}")`));
    expect(texts.join("\n")).not.toContain("ghp_");
  });

  it("reports a spawn failure once", async () => {
    const { events, exit, texts } = await collect({ id: "missing", group: "root", name: "missing", description: "", argv: ["/nonexistent/cyberkit-no-such-binary"], cwd: process.cwd() });
    expect(exit).toMatchObject({ status: "failed", exitCode: null });
    expect(texts.some((t) => t.startsWith("failed to start: "))).toBe(true);
    expect(events.filter((e) => e.type === "exit")).toHaveLength(1);
  });

  it("runs chains in order and stops at the first failure", async () => {
    const steps = [node("a", "console.log('A')"), node("b", "console.log('B'); process.exit(2)"), node("c", "console.log('C')")];
    const chain: CommandSpec = { id: "chain:verify", group: "checks", name: "verify", description: "a → b → c", cwd: process.cwd(), steps: ["a", "b", "c"] };
    const { exit, texts, lines } = await collect(chain, steps);
    expect(texts.filter((t) => ["A", "B", "C"].includes(t))).toEqual(["A", "B"]);
    expect(lines.filter((l) => l.stream === "system").map((l) => l.text)).toEqual(["▶ a: console.log('A')", "▶ b: console.log('B'); process.exit(2)"]);
    expect(exit).toMatchObject({ status: "failed", exitCode: 2 });

    const unknown = await collect({ ...chain, steps: ["a", "nope"] }, steps);
    expect(unknown.exit).toMatchObject({ status: "failed", exitCode: null });
    expect(unknown.texts).toContain("unknown command nope");
  });

  it("cancels: status cancelled, idempotent, and a chain runs no further steps", async () => {
    const slow = node("slow", "console.log('started'); setInterval(() => {}, 1000)");
    const res = await collect(slow, [], { onLine: (t, cancel) => t === "started" && (cancel(), cancel()) });
    expect(res.exit.status).toBe("cancelled");

    const chain: CommandSpec = { id: "chain:x", group: "checks", name: "x", description: "", cwd: process.cwd(), steps: ["slow", "after"] };
    const chained = await collect(chain, [slow, node("after", "console.log('AFTER')")], { onLine: (t, cancel) => t === "started" && cancel() });
    expect(chained.exit.status).toBe("cancelled");
    expect(chained.texts).not.toContain("AFTER");
  });

  it.runIf(process.platform !== "win32")("kills the whole process tree, even children that ignore SIGTERM", async () => {
    const grandchild = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)";
    const parent = `const c = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}], { stdio: "ignore" }); console.log("pid " + c.pid); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)`;
    let pid = 0;
    const res = await collect(node("tree", parent), [], { killGraceMs: 300, onLine: (t, cancel) => { if (t.startsWith("pid ")) { pid = Number(t.slice(4)); cancel(); } } });
    expect(res.exit.status).toBe("cancelled");
    expect(pid).toBeGreaterThan(0);
    const deadline = Date.now() + 5000;
    let alive = true;
    while (alive && Date.now() < deadline) {
      try {
        process.kill(pid, 0);
        await new Promise((r) => setTimeout(r, 50));
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  }, 15_000);
});

describe("labelFor", () => {
  it("labels workspace scripts with their group", () => {
    expect(labelFor({ id: "core:test", group: "core", name: "test", description: "", cwd: "/" })).toBe("core › test");
    expect(labelFor({ id: "root:lint", group: "root", name: "lint", description: "", cwd: "/" })).toBe("lint");
    expect(labelFor({ id: "chain:verify", group: "checks", name: "verify", description: "", cwd: "/" })).toBe("verify");
    expect(labelFor({ id: "tool:scan", group: "tools", name: "scan this repo", description: "", cwd: "/" })).toBe("scan this repo");
  });
});
