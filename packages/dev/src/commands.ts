/**
 * Command discovery: every npm script of the repo root and of each workspace,
 * a "verify" chain (lint → typecheck → build → test) and built-in tools.
 * Nothing to configure; everything comes from package.json files.
 */
import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { CommandSpec } from "./types.js";

/** Script names that are safe to pass as one argv entry on every platform. */
export const SCRIPT_NAME = /^[A-Za-z0-9][A-Za-z0-9:._-]*$/;

const LIFECYCLE = new Set(["prepare", "prepublishOnly", "preinstall", "install", "postinstall"]);
const CHAIN_STEPS = ["lint", "typecheck", "build", "test"] as const;

interface PackageJson {
  readonly name?: unknown;
  readonly scripts?: unknown;
  readonly workspaces?: unknown;
}

async function readPackageJson(dir: string): Promise<PackageJson | undefined> {
  let text: string;
  try {
    text = await readFile(path.join(dir, "package.json"), "utf8");
  } catch {
    return undefined;
  }
  const parsed: unknown = JSON.parse(text);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("package.json is not an object");
  return parsed as PackageJson;
}

async function tryReadPackageJson(dir: string): Promise<PackageJson | undefined> {
  try {
    return await readPackageJson(dir);
  } catch {
    return undefined;
  }
}

/** The nearest ancestor with a `workspaces` field, else the nearest with a package.json, else `start`. */
export async function findRepoRoot(start: string): Promise<string> {
  let dir = path.resolve(start);
  let nearest: string | undefined;
  for (;;) {
    if (existsSync(path.join(dir, "package.json"))) {
      nearest ??= dir;
      const pkg = await tryReadPackageJson(dir);
      if (pkg?.workspaces !== undefined) return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return nearest ?? path.resolve(start);
    dir = parent;
  }
}

export function npmArgv(script: string, platform: NodeJS.Platform = process.platform): string[] {
  return platform === "win32" ? ["cmd.exe", "/d", "/s", "/c", "npm", "run", script] : ["npm", "run", script];
}

/** `cyberkit-dev ...` or `node <path>/cyberkit-dev ...`: a script that opens this console. */
function opensConsole(body: string): boolean {
  const [cmd, arg] = body.trim().split(/\s+/);
  const isConsole = (word: string | undefined) => word !== undefined && /(^|[\\/])cyberkit-dev$/.test(word);
  return isConsole(cmd) || (cmd === "node" && isConsole(arg));
}

function scriptsOf(pkg: PackageJson): Array<[string, string]> {
  const raw = pkg.scripts;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return [];
  const entries = Object.entries(raw as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string");
  const names = new Set(entries.map(([n]) => n));
  return entries.filter(([name, body]) => {
    if (LIFECYCLE.has(name)) return false;
    if (opensConsole(body)) return false; // the console itself (needs a TTY of its own)
    if (!SCRIPT_NAME.test(name)) return false;
    const hook = /^(pre|post)(.+)$/.exec(name);
    if (hook && names.has(hook[2] as string)) return false;
    return true;
  });
}

function scriptCommands(pkg: PackageJson, group: string, cwd: string, platform: NodeJS.Platform): CommandSpec[] {
  return scriptsOf(pkg).map(([name, body]) => ({ id: `${group}:${name}`, group, name, description: body, argv: npmArgv(name, platform), cwd }));
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function workspaceDirs(root: string, workspaces: unknown): Promise<string[]> {
  const patterns = Array.isArray(workspaces)
    ? workspaces
    : workspaces !== null && typeof workspaces === "object" && Array.isArray((workspaces as { packages?: unknown }).packages)
      ? ((workspaces as { packages: unknown[] }).packages)
      : [];
  const dirs: string[] = [];
  for (const pattern of patterns) {
    if (typeof pattern !== "string") continue;
    if (pattern.endsWith("/*")) {
      const base = path.resolve(root, pattern.slice(0, -2));
      let names: string[];
      try {
        names = (await readdir(base)).sort();
      } catch {
        continue;
      }
      for (const name of names) {
        const dir = path.join(base, name);
        if ((await isDir(dir)) && existsSync(path.join(dir, "package.json"))) dirs.push(dir);
      }
    } else if (!pattern.includes("*")) {
      const dir = path.resolve(root, pattern);
      if (existsSync(path.join(dir, "package.json"))) dirs.push(dir);
    }
  }
  return [...new Set(dirs)];
}

export async function discoverCommands(root: string, options: { platform?: NodeJS.Platform; execPath?: string } = {}): Promise<CommandSpec[]> {
  const platform = options.platform ?? process.platform;
  const execPath = options.execPath ?? process.execPath;
  let rootPkg: PackageJson | undefined;
  try {
    rootPkg = await readPackageJson(root);
  } catch (e) {
    throw new Error(`invalid package.json in ${root}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const rootCommands = rootPkg ? scriptCommands(rootPkg, "root", root, platform) : [];

  const workspaceCommands: CommandSpec[] = [];
  for (const dir of rootPkg ? await workspaceDirs(root, rootPkg.workspaces) : []) {
    const pkg = await tryReadPackageJson(dir);
    if (!pkg) continue;
    const group = typeof pkg.name === "string" && pkg.name.length > 0 ? (pkg.name.split("/").pop() as string) : path.basename(dir);
    workspaceCommands.push(...scriptCommands(pkg, group, dir, platform));
  }

  const checks: CommandSpec[] = [];
  const steps = CHAIN_STEPS.filter((s) => rootCommands.some((c) => c.name === s));
  if (steps.length > 0) {
    checks.push({ id: "chain:verify", group: "checks", name: "verify", description: steps.join(" → "), cwd: root, steps: steps.map((s) => `root:${s}`) });
  }

  const tools: CommandSpec[] = [];
  const bin = path.join(root, "packages", "core", "bin", "cyberkit");
  if (existsSync(bin)) {
    tools.push({ id: "tool:scan", group: "tools", name: "scan this repo", description: "cyberkit scan .", argv: [execPath, bin, "scan", "."], cwd: root });
  }

  return [...checks, ...rootCommands, ...workspaceCommands, ...tools];
}
