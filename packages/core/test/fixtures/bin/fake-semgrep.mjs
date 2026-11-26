#!/usr/bin/env node
// Test double for the semgrep CLI. Behaviour is driven by FAKE_SEMGREP_MODE.
import { appendFileSync, writeFileSync } from "node:fs";

const mode = process.env.FAKE_SEMGREP_MODE ?? "results";
if (process.env.FAKE_SEMGREP_ARGS_FILE) appendFileSync(process.env.FAKE_SEMGREP_ARGS_FILE, JSON.stringify(process.argv.slice(2)) + "\n");
if (process.env.FAKE_SEMGREP_PID_FILE) writeFileSync(process.env.FAKE_SEMGREP_PID_FILE, String(process.pid));
if (process.env.FAKE_SEMGREP_CWD_FILE) writeFileSync(process.env.FAKE_SEMGREP_CWD_FILE, process.cwd());
const target = process.argv[process.argv.length - 1];

const output = {
  version: "1.99.0",
  errors: [],
  results: [
    { check_id: "rules.sql-injection", path: `${target}/src/a.js`, start: { line: 3, col: 1 }, end: { line: 3, col: 20 }, extra: { message: "Possible SQL injection", severity: "ERROR", lines: "db.query(`SELECT ${x}`)" } },
    { check_id: "rules.hardcoded-secret", path: `${target}/src/a.js`, start: { line: 7, col: 1 }, end: { line: 7, col: 30 }, extra: { message: "Hardcoded credential", severity: "WARNING", lines: 'const password = "hunter2"' } },
  ],
};

switch (mode) {
  case "results":
    process.stdout.write(JSON.stringify(output));
    break;
  case "empty":
    process.stdout.write(JSON.stringify({ version: "1.99.0", errors: [], results: [] }));
    break;
  case "garbage":
    process.stdout.write("this is not json");
    break;
  case "fail":
    process.stderr.write("semgrep: fatal config error token=abc123\n");
    process.exit(2);
    break;
  case "hang":
    setInterval(() => {}, 1000);
    break;
  case "flood":
    for (let i = 0; i < 200; i++) process.stdout.write("x".repeat(64 * 1024));
    break;
}
