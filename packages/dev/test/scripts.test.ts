/**
 * The repo's own npm scripts must never be dead: each one has to resolve to
 * something that exists, and `npm run ui` has to work even when
 * node_modules/.bin has no `cyberkit-dev` link (e.g. after a pull without a
 * fresh `npm install`).
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { VERSION } from "@cyberkit/core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const scripts = (JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;
const built = existsSync(path.join(ROOT, "packages/dev/dist/cli.js"));

describe("root npm scripts", () => {
  it("every script starts with a command that exists", () => {
    for (const [name, body] of Object.entries(scripts)) {
      const [cmd, arg] = body.trim().split(/\s+/);
      if (cmd === "npm") continue;
      if (cmd === "node") {
        expect(existsSync(path.join(ROOT, arg ?? "")), `${name}: ${arg} does not exist`).toBe(true);
        continue;
      }
      expect(existsSync(path.join(ROOT, "node_modules/.bin", cmd ?? "")), `${name}: ${cmd} is not installed`).toBe(true);
    }
  });

  it.runIf(built && process.platform !== "win32")("`ui` works without the node_modules/.bin link", () => {
    // Only node itself on PATH: no npm-provided node_modules/.bin, so a bare `cyberkit-dev` would be "command not found".
    const r = spawnSync("/bin/sh", ["-c", `${scripts.ui} --version`], { cwd: ROOT, encoding: "utf8", env: { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin` } });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`${VERSION}\n`);
  });
});

describe("commands documented in README.md and CONTRIBUTING.md", () => {
  const docs = ["README.md", "CONTRIBUTING.md"].map((f) => readFileSync(path.join(ROOT, f), "utf8")).join("\n");
  const helpOf = (bin: string) => spawnSync(process.execPath, [path.join(ROOT, `packages/${bin}/bin/cyberkit-${bin}`), "--help"], { encoding: "utf8" }).stdout;

  it("every `npm run <script>` exists in the root package.json", () => {
    const named = [...docs.matchAll(/npm run ([\w:.-]+)/g)].map((m) => m[1] as string);
    expect(named).toContain("ui");
    for (const name of new Set(named)) expect(Object.keys(scripts), `npm run ${name}`).toContain(name);
  });

  it.runIf(built)("every documented cyberkit-dev / cyberkit-tui flag is in that tool's --help", () => {
    for (const bin of ["dev", "tui"]) {
      const help = helpOf(bin);
      const lines = docs.split("\n").filter((l) => l.includes(`cyberkit-${bin}`) || (bin === "dev" && l.includes("npm run ui")));
      const flags = new Set(lines.flatMap((l) => [...l.matchAll(/(?<![\w-])--[a-z][\w-]*/g)].map((m) => m[0])));
      flags.delete("--"); // npm's argument separator
      expect(flags.size, `flags documented for cyberkit-${bin}`).toBeGreaterThan(0);
      for (const f of flags) expect(help, `cyberkit-${bin} ${f}`).toContain(f);
    }
  });
});
