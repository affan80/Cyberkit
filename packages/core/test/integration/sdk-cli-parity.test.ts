import { rm } from "node:fs/promises";
import { afterAll, describe, expect, it } from "vitest";
import { type FailOn, type ScanEvent, renderPlain, scan, scanStream } from "../../src/index.js";
import { makeProject, runCli } from "./helpers.js";

interface Scenario {
  readonly name: string;
  readonly deps: Record<string, string>;
  readonly lockfile?: boolean;
  readonly failOn?: FailOn;
  readonly plugins?: readonly string[];
}

const SCENARIOS: readonly Scenario[] = [
  { name: "clean project", deps: { react: "^18.0.0", express: "^4.0.0" } },
  { name: "single wildcard", deps: { left: "*" } },
  { name: "mixed severities", deps: { lodahs: "1.0.0", l0dash: "1.0.0", c: "http://example.com/c.tgz", d: "github:o/r", e: "latest" } },
  { name: "credentials in a URL (redacted)", deps: { b: "git+https://user:hunter2pw@example.com/b.git" } },
  { name: "no lockfile", deps: { x: "1.0.0" }, lockfile: false },
  { name: "threshold above every finding", deps: { left: "*", lodahs: "1.0.0" }, failOn: "critical" },
  { name: "threshold none", deps: { l0dash: "1.0.0" }, failOn: "none" },
  { name: "failing plugin (partial scan)", deps: { react: "^18.0.0" }, plugins: ["semgrep"] },
];

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

/** Runs the SDK with the same PATH the CLI child gets, so built-in plugins resolve identically. */
async function withPath<T>(value: string, fn: () => Promise<T>): Promise<T> {
  const saved = process.env.PATH;
  process.env.PATH = value;
  try {
    return await fn();
  } finally {
    process.env.PATH = saved;
  }
}

describe.each(SCENARIOS)("SDK and CLI agree: $name", (s) => {
  const PATH = s.plugins ? "/nonexistent" : (process.env.PATH ?? "");
  const cliArgs = (dir: string, format: string) => [
    "scan", dir, "-f", format,
    ...(s.failOn ? ["--fail-on", s.failOn] : []),
    ...(s.plugins ?? []).flatMap((p) => ["-p", p]),
  ];

  it("same findings, summary, exit code and reports", async () => {
    const dir = await makeProject(s.deps, { lockfile: s.lockfile });
    dirs.push(dir);
    const options = { target: dir, ...(s.failOn ? { failOn: s.failOn } : {}), ...(s.plugins ? { plugins: s.plugins } : {}) };

    const sdk = await withPath(PATH, () => scan(options));
    const [json, text, sarif] = await Promise.all(["json", "text", "sarif"].map((f) => runCli(cliArgs(dir, f), { env: { PATH } })));

    // Findings: identical content and order (JSON round-trip of the frozen SDK objects).
    const cli = JSON.parse(json!.stdout) as { summary: { total: number; bySeverity: unknown }; findings: unknown[] };
    expect(cli.findings).toEqual(JSON.parse(JSON.stringify(sdk.findings)));
    expect(cli.summary).toEqual(JSON.parse(JSON.stringify(sdk.summary)));

    // Exit code: the process code equals the SDK's computed code, for every format.
    for (const r of [json, text, sarif]) expect(r!.code).toBe(sdk.exitCode);

    // Text report: byte-for-byte what the SDK's reporter renders.
    expect(text!.stdout).toBe(renderPlain(sdk.findings));

    // SARIF: one result per finding, fingerprinted by the same ids in the same order.
    const log = JSON.parse(sarif!.stdout) as { runs: { results: { partialFingerprints: Record<string, string> }[] }[] };
    expect(log.runs[0]!.results.map((r) => r.partialFingerprints["cyberkitFindingId/v1"])).toEqual(sdk.findings.map((f) => f.id));

    // Streaming SDK: same finding set and the same final exit code.
    const events: ScanEvent[] = [];
    await withPath(PATH, async () => {
      for await (const e of scanStream(options)) events.push(e);
    });
    const streamed = events.flatMap((e) => (e.type === "finding" ? [e.finding.id] : []));
    expect([...streamed].sort()).toEqual(sdk.findings.map((f) => f.id).sort());
    expect(events.at(-1)).toMatchObject({ type: "end", exitCode: sdk.exitCode });

    // And nothing secret crossed either interface.
    for (const out of [json!.stdout, text!.stdout, sarif!.stdout, JSON.stringify(sdk)]) expect(out).not.toContain("hunter2pw");
  });
});
