import { describe, expect, it } from "vitest";
import { extractErrors, formatError } from "../src/errors.js";
import type { LogLine } from "../src/types.js";

const out = (text: string, stream: LogLine["stream"] = "stdout"): LogLine[] => text.split("\n").map((t) => ({ stream, text: t }));

describe("extractErrors", () => {
  it("recognises TypeScript errors in both tsc formats", () => {
    const errs = extractErrors(
      out(
        [
          "test/store.test.ts(137,16): error TS2339: Property 'message' does not exist on type 'Error | Finding[]'.",
          "src/a.ts:3:5 - error TS2322: Type 'string' is not assignable to type 'number'.",
        ].join("\n"),
      ),
    );
    expect(errs).toEqual([
      { kind: "typescript", file: "test/store.test.ts", line: 137, col: 16, rule: "TS2339", message: "Property 'message' does not exist on type 'Error | Finding[]'.", lineIndex: 0 },
      { kind: "typescript", file: "src/a.ts", line: 3, col: 5, rule: "TS2322", message: "Type 'string' is not assignable to type 'number'.", lineIndex: 1 },
    ]);
  });

  it("ignores npm's echo of the script line, which can contain error-looking text", () => {
    const errs = extractErrors(
      out(["> typecheck", `> node -e "console.log('src/a.ts(3,5): error TS2322: bad')"`, "", "src/a.ts(3,5): error TS2322: bad"].join("\n")),
      { exitCode: 2 },
    );
    expect(errs).toEqual([{ kind: "typescript", file: "src/a.ts", line: 3, col: 5, rule: "TS2322", message: "bad", lineIndex: 3 }]);
  });

  it("ignores the console's own system lines (chain step headers)", () => {
    const lines: LogLine[] = [{ stream: "system", text: "▶ typecheck: node -e \"console.log('src/a.ts(3,5): error TS2322: bad')\"" }, { stream: "stdout", text: "src/a.ts(3,5): error TS2322: bad" }];
    expect(extractErrors(lines, { exitCode: 2 }).map((e) => e.lineIndex)).toEqual([1]);
    expect(extractErrors([{ stream: "system", text: "failed to start: spawn x ENOENT" }], { exitCode: null })).toEqual([{ kind: "generic", message: "failed to start: spawn x ENOENT", lineIndex: 0 }]);
  });

  it("recognises ESLint stylish output and ignores warnings", () => {
    const errs = extractErrors(
      out(
        [
          "",
          "/repo/packages/bench/src/run.mjs",
          "  91:62  error  'URL' is not defined  no-undef",
          "   3:1   warning  Unexpected console statement  no-console",
          "",
          "/repo/packages/bench/src/stats.mjs",
          "  216:156  error  '_' is assigned a value but never used  @typescript-eslint/no-unused-vars",
          "",
          "✖ 3 problems (2 errors, 1 warning)",
        ].join("\n"),
      ),
    );
    expect(errs.map((e) => [e.kind, e.file, e.line, e.col, e.rule, e.message])).toEqual([
      ["eslint", "/repo/packages/bench/src/run.mjs", 91, 62, "no-undef", "'URL' is not defined"],
      ["eslint", "/repo/packages/bench/src/stats.mjs", 216, 156, "@typescript-eslint/no-unused-vars", "'_' is assigned a value but never used"],
    ]);
  });

  it("recognises vitest FAIL blocks once each, with message and location", () => {
    const errs = extractErrors(
      out(
        [
          " ❯ test/smoke.test.mjs (3 tests | 1 failed) 28114ms",
          "   × benchmark suite (quick smoke run) > runs every suite and returns well-formed rows 28109ms",
          "     → .toMatch() expects to receive a string, but got undefined",
          "⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯",
          "",
          " FAIL  test/smoke.test.mjs > benchmark suite (quick smoke run) > runs every suite and returns well-formed rows",
          "TypeError: .toMatch() expects to receive a string, but got undefined",
          " ❯ test/smoke.test.mjs:15:131",
          "     13|       expect(r.name.length).toBeGreaterThan(0);",
        ].join("\n"),
      ),
      { exitCode: 1 },
    );
    expect(errs).toEqual([
      {
        kind: "test",
        file: "test/smoke.test.mjs",
        line: 15,
        col: 131,
        test: "benchmark suite (quick smoke run) > runs every suite and returns well-formed rows",
        message: "TypeError: .toMatch() expects to receive a string, but got undefined",
        lineIndex: 5,
      },
    ]);
  });

  it("recognises an uncaught exception with its first non-internal frame", () => {
    const errs = extractErrors(
      out(["file:///x/app.mjs:3", 'throw new Error("boom");', "^", "", "Error: boom", "    at file:///x/app.mjs:3:7", "    at ModuleJob.run (node:internal/modules/esm/module_job:271:25)"].join("\n"), "stderr"),
      { exitCode: 1 },
    );
    expect(errs).toEqual([{ kind: "exception", message: "Error: boom", file: "file:///x/app.mjs", line: 3, col: 7, lineIndex: 4 }]);
  });

  it("keeps one npm entry, the most specific", () => {
    const errs = extractErrors(
      out(["npm error Lifecycle script `test` failed with error:", "npm error code 1", "npm error path /repo", "npm error command failed", "npm error command sh -c vitest run"].join("\n"), "stderr"),
      { exitCode: 1 },
    );
    expect(errs).toEqual([{ kind: "npm", message: "Lifecycle script `test` failed with error:", lineIndex: 0 }]);
  });

  it("falls back to the last stderr line only when a failed run matched nothing", () => {
    const lines = [...out("working...\ndone?"), ...out("fatal: something broke\n", "stderr")];
    expect(extractErrors(lines, { exitCode: 2 })).toEqual([{ kind: "generic", message: "fatal: something broke", lineIndex: 2 }]);
    expect(extractErrors(lines, { exitCode: 0 })).toEqual([]);
    expect(extractErrors(out("all good"), { exitCode: 0 })).toEqual([]);
  });

  it("dedupes identical errors and caps the count", () => {
    const line = "src/a.ts(1,1): error TS1005: ';' expected.";
    expect(extractErrors(out(`${line}\n${line}`))).toHaveLength(1);
    const many = out(Array.from({ length: 50 }, (_, i) => `src/a.ts(${i + 1},1): error TS1005: x`).join("\n"));
    expect(extractErrors(many, { maxErrors: 10 })).toHaveLength(10);
  });

  it("is linear on large outputs", () => {
    const lines = out(Array.from({ length: 200_000 }, (_, i) => (i % 1000 === 0 ? `src/f${i}.ts(1,1): error TS1: x` : ` ✓ test ${i} ok`)).join("\n"));
    const start = performance.now();
    const errs = extractErrors(lines, { maxErrors: 1000 });
    expect(errs).toHaveLength(200);
    expect(performance.now() - start).toBeLessThan(1500);
  });
});

describe("formatError", () => {
  it("joins the non-empty parts", () => {
    expect(formatError({ kind: "eslint", file: "a.js", line: 2, col: 3, rule: "no-undef", message: "x", lineIndex: 0 })).toBe("eslint  a.js:2:3  no-undef  x");
    expect(formatError({ kind: "npm", message: "Lifecycle script failed", lineIndex: 0 })).toBe("npm  Lifecycle script failed");
    expect(formatError({ kind: "test", file: "t.ts", test: "a > b", message: "Error: x", lineIndex: 0 })).toBe("test  t.ts  a > b  Error: x");
  });
});
