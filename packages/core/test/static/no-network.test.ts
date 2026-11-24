import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { findNetworkUsage } from "./scan-network.js";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src");
const PKG = path.resolve(SRC, "../package.json");

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await sourceFiles(p)));
    else if (/\.(c|m)?[jt]s$/.test(e.name)) out.push(p);
  }
  return out;
}

describe("@cyberkit/core makes no network calls (static)", () => {
  it("has no network imports or globals in src/", async () => {
    const files = await sourceFiles(SRC);
    expect(files.length).toBeGreaterThan(0);
    const violations: string[] = [];
    for (const file of files) {
      for (const v of findNetworkUsage(await readFile(file, "utf8"))) {
        violations.push(`${path.relative(SRC, file)}: ${v}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("declares no network client dependencies", async () => {
    const pkg = JSON.parse(await readFile(PKG, "utf8")) as Record<string, Record<string, string>>;
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies, ...pkg.optionalDependencies });
    expect(findNetworkUsage(deps.map((d) => `import "${d}";`).join("\n"))).toEqual([]);
  });
});

describe("the detector itself", () => {
  it.each([
    ['import http from "node:http";', "http"],
    ['import { request } from "https";', "https"],
    ['import net from "node:net";', "net"],
    ['import * as dns from "node:dns/promises";', "dns"],
    ['import tls from "tls";', "tls"],
    ['import dgram from "node:dgram";', "dgram"],
    ['import h2 from "node:http2";', "http2"],
    ['const x = require("node:https");', "https"],
    ['const m = await import("net");', "net"],
    ['export { get } from "node:http";', "http"],
    ['import axios from "axios";', "axios"],
    ['import f from "node-fetch";', "node-fetch"],
    ['import { fetch } from "undici";', "undici"],
    ['import WebSocket from "ws";', "ws"],
    ["const r = await fetch(url);", "fetch"],
    ["const r = await globalThis.fetch(url);", "fetch"],
    ["const s = new WebSocket(u);", "WebSocket"],
    ["const x = new XMLHttpRequest();", "XMLHttpRequest"],
    ["const s = new EventSource(u);", "EventSource"],
  ])("flags %s", (code, what) => {
    expect(findNetworkUsage(code).join(" ")).toContain(what);
  });

  it.each([
    "// import http from 'node:http'; fetch(url)",
    "/* const s = new WebSocket(u); */",
    'import path from "node:path";',
    'import { readFile } from "node:fs/promises";',
    "const prefetch = 1; const refetch = () => 2;",
    "obj.fetchAll(items)",
    'const httpStatus = 200; import("./httpUtils.js");',
  ])("does not flag %s", (code) => {
    expect(findNetworkUsage(code)).toEqual([]);
  });
});
