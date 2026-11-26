# Writing CyberKit plugins

A plugin adds checks to a scan. It looks at the project and returns **plain finding data**. CyberKit turns that data into findings, so every plugin gets redaction, scope checks, stable ids and every reporter for free, and no plugin can bypass them.

## The contract

```ts
interface Plugin {
  readonly name: string; // 1-64 chars: a-z, 0-9, ".", "_", "-"
  run(ctx: PluginContext): Promise<PluginFindingInput[]> | PluginFindingInput[];
}

interface PluginContext {
  readonly root: string;       // canonical (realpath) scan root
  readonly signal: AbortSignal; // aborted when the plugin times out
}

interface PluginFindingInput {
  ruleId: string;               // stable id of the check, e.g. "no-eval"
  severity: "critical" | "high" | "medium" | "low" | "info";
  message: string;
  file?: string;                // relative to root, or absolute inside root
  line?: number;                // 1-based
  evidence?: string;            // the offending code or value
}
```

## What the host does with your output

| You return | CyberKit enforces |
|---|---|
| anything | `engine` is always `plugin:<name>`. You can't impersonate another engine. |
| `message`, `evidence` | Secrets are **redacted** before the finding exists. |
| `file` | Resolved through the scope. Paths outside the scan root, including via `..` or symlinks, are **dropped** and counted in `skipped`. Inside paths become root-relative. |
| any fields | The `id` is computed from the content (sha256), so a forged `id` is ignored. Identical findings dedupe across plugins. |
| invalid items | Skipped and counted. The rest of your output is kept. |
| too many items | Capped at `maxFindings` (10,000 by default). `truncated` is set. |

Running a plugin **never throws** into the scan. Every run ends as a `PluginRunResult` with `status` set to one of `ok`, `error`, `timeout`, `crashed` or `invalid-output`. Any non-`ok` status makes the scan exit `4` (partial), unless findings already cross `--fail-on`, in which case it exits `1`.

## Two ways to run a plugin

### 1. Module plugin (isolated). Use this for third-party code.

Export the plugin as the module's default export (or a named `plugin` export) from a plain `.mjs` file:

```js
// no-eval.mjs: flags eval() in .js/.mjs files under the scan root
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

async function* jsFiles(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* jsFiles(p);
    else if (/\.m?js$/.test(entry.name)) yield p;
  }
}

export default {
  name: "no-eval",
  async run(ctx) {
    const findings = [];
    for await (const file of jsFiles(ctx.root)) {
      const lines = (await readFile(file, "utf8")).split("\n");
      lines.forEach((text, i) => {
        if (/\beval\s*\(/.test(text)) {
          findings.push({ ruleId: "no-eval", severity: "high", message: "eval() executes arbitrary code", file, line: i + 1, evidence: text.trim() });
        }
      });
    }
    return findings;
  },
};
```

Run it through the SDK:

```ts
import { scan } from "@cyberkit/core";

const result = await scan({ target: ".", plugins: [{ module: "./no-eval.mjs" }] });
```

Module plugins run in a **worker thread**:

- **Hard kill on timeout**, even for a synchronous infinite loop (`pluginTimeoutMs`, 5 minutes by default).
- **Heap limit**: 512 MB by default (`maxMemoryMb` when calling `runPluginModule` directly).
- **Minimal environment**: only `PATH` is visible, never the host's tokens or secrets.
- **Separate globals**: prototype pollution or global writes don't reach the scan.
- **stdout and stderr are swallowed**: `console.log` can't corrupt a JSON or SARIF report.
- `process.exit()` and uncaught errors only end the worker, and the run is reported as `crashed`.

### 2. In-process plugin (trusted). Use this for your own code.

```ts
import { definePlugin, scan } from "@cyberkit/core";

const noTodoSecurity = definePlugin({
  name: "todo-security",
  async run(ctx) {
    // ... inspect files under ctx.root ...
    return [{ ruleId: "todo-security", severity: "low", message: "unresolved TODO(security)", file: "src/auth.ts", line: 42 }];
  },
});

const result = await scan({ target: ".", plugins: [noTodoSecurity] });
```

In-process plugins get error containment, output validation and a timeout that **aborts `ctx.signal`**. They can't be force-killed, so honour the signal in long-running work. The built-in Semgrep plugin works this way.

> The CLI's `-p` flag currently loads **built-in** plugins only (`semgrep`). Module and in-process plugins are loaded through the SDK.

## Spawning an external tool

To wrap a scanner the way the Semgrep plugin does (`packages/core/src/plugins/semgrep.ts`):

- Spawn with `shell: false` and an argument array. Never build a command string.
- **Resolve the binary yourself** with `resolveExecutable()` from `packages/core/src/plugins/exec.ts`, then spawn the absolute path it returns. A bare `spawn("tool")` searches `PATH` relative to the child's cwd, so a `PATH` containing `.` or an empty entry (a leading, trailing or doubled `:`) would run the scanned repo's own `./tool`. `resolveExecutable()` skips empty and relative entries and anything inside the scan root.
- **Never use the scan root as the child's cwd.** Pass the target as an argument and use `neutralCwd()` (the OS temp dir), so nothing the tool loads relative to its cwd comes from the repo.
- Pass `signal: ctx.signal` (and `killSignal: "SIGKILL"`) so a timeout really kills the child.
- **Cap stdout**, so a runaway tool can't exhaust memory.
- Keep it **offline**. Disable telemetry and update checks, and refuse configs that download rules.
- Give the child a minimal `env` (for example just `PATH`).
- Throw a clear error when the tool is missing. The run becomes `status: "error"` and the scan carries on.

## Testing a plugin

Run it against a real temporary directory and assert on the **result**, not on internals:

```ts
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { createScope, runPluginModule } from "@cyberkit/core";

it("flags eval()", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "no-eval-"));
  await writeFile(path.join(dir, "a.js"), "const x = 1;\neval(input);\n");
  const res = await runPluginModule("./no-eval.mjs", await createScope(dir));
  expect(res.status).toBe("ok");
  expect(res.findings[0]).toMatchObject({ engine: "plugin:no-eval", file: "a.js", line: 2 });
});
```

To test a tool-wrapping plugin without installing the tool, point it at a small fake executable that prints canned output, as `test/fixtures/bin/fake-semgrep.mjs` does.

## Limits

Isolation protects the scan from **faulty** plugins: crashes, hangs, memory blow-ups, noisy output, bad data. It isn't a security sandbox against **malicious** plugins. A worker can still read files and open network connections with your user's permissions. Only run plugins you trust, just as you would any npm dependency.

## Checklist

- [ ] `name` is lowercase, stable and unique
- [ ] `ruleId`s are stable (they feed finding ids and SARIF rule ids)
- [ ] `file` paths are inside `ctx.root`
- [ ] Long-running work honours `ctx.signal`
- [ ] No network access, telemetry or update checks
- [ ] Missing external tools fail with a clear error
- [ ] Tested against a real temp directory
