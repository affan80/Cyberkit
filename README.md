# CyberKit

**An offline-first security assessment toolkit for developers and security teams.**

> Status: early development (`@cyberkit/core` v0.1.0). The CLI and SDK work, but APIs may still change before the first release.

**Contents:** [What it is](#what-it-is) · [Install](#install) · [CLI](#cli) · [Terminal UI](#terminal-ui) · [Exit codes](#exit-codes) · [What gets checked](#what-gets-checked) · [GitHub code scanning](#github-code-scanning) · [SDK](#sdk) · [Developer console](#developer-console) · [Roadmap](#roadmap) · [Contributing](#contributing)

## What it is

CyberKit is a Node.js/TypeScript toolkit that scans a project, runs security checks locally, and reports the results as structured findings. It ships as:

- `@cyberkit/core`: a CLI and an SDK (`scan()` and a streaming iterator).
- `@cyberkit/tui`: an interactive, lazygit-style terminal UI for scans (`cyberkit-tui`).
- `@cyberkit/dev` (private, for contributors): a lazygit-style developer console that runs every project command and keeps an error log per run (`npm run ui`).

Core features:

- **Supply-chain engine** that checks dependencies, including typosquat detection against a bundled snapshot.
- **Plugin system** with isolated plugins (for example Semgrep).
- **Scope model** that restricts what a scan may touch, using realpath-validated paths, so a scan can't wander outside the target.
- **Immutable findings** with deterministic, content-addressed IDs, so the same issue always gets the same ID across runs.
- **Redaction at creation time** for tokens, credentials, cookies, auth headers and private keys. Redaction covers every free-text field of a finding (rule id, file path, message and evidence) and is irreversible, so secrets never reach reports or logs. It recognises GitHub, GitLab, AWS, Slack (tokens and webhook URLs), npm, Stripe, OpenAI, Anthropic and Google API keys, JWTs, PEM/OpenSSH/PGP and PuTTY private keys, credentials in URLs (`user:pass@` and token-only `token@`), JSON/dict-form auth and cookie headers, and `key=value` secrets with plain, double- or single-quoted keys. A corpus test checks every format against the text, JSON and SARIF reports.
- **Reporters** for plain text, JSON and SARIF (for GitHub code scanning and IDEs).
- **Stable exit codes** for CI.

## Why it exists

Most security scanners send code or metadata to a cloud service, need accounts and API keys, or behave differently in the CLI and in code. CyberKit is built around three rules:

1. **Offline by default.** A static test enforces that the core makes no network calls.
2. **Safe by construction.** Scope limits and redaction are enforced in the core, not left to each reporter.
3. **One engine, two interfaces.** The CLI and SDK give the same results, checked by a parity test.

## What problem it solves

| Problem | How CyberKit handles it |
|---|---|
| Scanning sensitive or air-gapped code with cloud tools isn't allowed | Runs fully offline |
| Secrets leak into scan reports and CI logs | Redacts them when the finding is created |
| Malicious look-alike packages (typosquats) slip into dependencies | Checks against a bundled snapshot |
| Scanners touch files they shouldn't | Scope validation with realpath checks |
| Results are hard to compare between runs | Deterministic finding IDs |
| Tools don't fit CI or IDEs | SARIF/JSON output and stable exit codes |
| Third-party plugins can crash or compromise the scan | Plugin isolation |

## Requirements

- Node.js **>= 22.13.0**

## Install

`@cyberkit/core` isn't published to npm yet. Until it is, run it from source:

```bash
git clone https://github.com/affan80/Cyberkit.git
cd Cyberkit
git checkout dev
npm install        # also links the `cyberkit` command into node_modules/.bin
npm run build
npm test
```

Then run the CLI from the repo with `npx cyberkit ...`, or point at any project: `npx cyberkit scan /path/to/project`. For an interactive view of a scan, use `npx cyberkit-tui /path/to/project` (see [Terminal UI](#terminal-ui)).

Working on CyberKit itself? `npm run ui` opens the [developer console](#developer-console): every build, lint, typecheck, test and scan command on one screen, with a history and an error log for each run.

## Usage

### CLI

```bash
npx cyberkit scan [target] [options]
```

| Option | Description |
|---|---|
| `-f, --format <fmt>` | `text` (default), `json` or `sarif` |
| `-o, --output <file>` | Write the report to a file instead of stdout (directories are created, symlinks are refused; see below) |
| `-p, --plugin <name>` | Enable a plugin, repeatable. Built in: `semgrep` |
| `--fail-on <sev>` | Exit 1 on findings at or above `critical`, `high`, `medium`, `low` (default), `info` or `none` |
| `-q, --quiet` | Hide plugin warnings on stderr |
| `-h, --help` / `-v, --version` | Help and version |

`target` defaults to the current directory. The report goes to stdout and diagnostics go to stderr, so piping (`cyberkit scan -f json | jq`) stays clean. Text output is coloured only in a terminal, and never when `NO_COLOR` is set.

`--output` treats the scanned tree and the working directory as untrusted. CyberKit refuses (exit `3`) to write the report if the output file, or any directory leading to it inside those trees, is a symbolic link. A pull request that plants `cyberkit.sarif -> ~/.ssh/authorized_keys` can't make a CI scan overwrite files outside the checkout. The report is written to a temp file and renamed into place, so it is never half-written either.

Example:

```console
$ npx cyberkit scan .
CyberKit: 3 findings (1 high, 2 medium)

HIGH      package.json:1  supply-chain/credentials-in-url
          b@git+https://[REDACTED]@example.com/b.git#v1 (dependencies) embeds credentials in its URL

MEDIUM    package.json:1  supply-chain/possible-typosquat
          lodahs (dependencies) resembles the popular package "lodash"

MEDIUM    package.json:1  supply-chain/wildcard-version
          left-pad@* (dependencies) accepts any version
```

The credential in that URL never reaches the report. It's redacted when the finding is created.

### Terminal UI

`cyberkit-tui` is an interactive, lazygit-style view of a scan. Findings stream in live; filter them by severity, search them, and read each one in full.

```bash
npx cyberkit-tui [target] [-p semgrep] [--fail-on <sev>]
```

```text
╭─[1] Scan─────────────────────╮┏━[4] Findings 1/4━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
│ Target /home/dev/demo-project│┃ ▸ MEDIUM   package.json:1         supply-chain/possible-typosquat┃
│ ✓ Done in 11 ms              │┃   MEDIUM   package.json:1         supply-chain/unpinned-git-depen┃
│ 4 findings                   │┃   MEDIUM   package.json:1         supply-chain/wildcard-version  ┃
│ exit 1 (findings)            │┃   LOW      package.json           supply-chain/missing-lockfile  ┃
╰──────────────────────────────╯┃                                                                  ┃
╭─[2] Severity─────────────────╮┃                                                                  ┃
│ ▸ all          4             │┃                                                                  ┃
│   critical     0             │┃                                                                  ┃
│   high         0             │┃                                                                  ┃
│   medium       3             │┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
│   low          1             │╭─Details──────────────────────────────────────────────────────────╮
│   info         0             ││ MEDIUM  supply-chain/possible-typosquat                          │
╰──────────────────────────────╯│ Location  package.json:1                                         │
╭─[3] Plugins──────────────────╮│ ID        a6af5fac10186770                                       │
│ ● supply-chain  engine       ││                                                                  │
│                              ││ lodahs (dependencies) resembles the popular package "lodash"     │
│                              ││                                                                  │
│                              ││ Evidence                                                         │
│                              ││ "lodahs": "^4.17.21"                                             │
╰──────────────────────────────╯╰──────────────────────────────────────────────────────────────────╯
j/k move  tab pane  / search  s severity  esc clear  r rescan  e export  ? help  q quit
```

| Key | Action |
|---|---|
| `j`/`k`, `↑`/`↓` | Move through the findings |
| `tab`, `1`–`4` | Switch panes (scan, severity, plugins, findings) |
| `/` | Search findings (`esc` clears) |
| `s` | Cycle the severity filter |
| `r` | Re-scan |
| `e` | Export the shown findings as JSON (never overwrites a file) |
| `?` | Help |
| `q` | Quit; the exit code is the scan's exit code |

`--frame` prints a single frame without going interactive (with `--cols`, `--rows` and `--keys` to replay keystrokes), which is handy in CI logs and for screenshots. Everything a finding contains is escaped before it is drawn, so a malicious file name or message can't inject terminal escape sequences.

### Exit codes

These are stable, so CI can rely on them.

| Code | Meaning |
|---|---|
| `0` | No findings at or above `--fail-on` |
| `1` | Findings at or above `--fail-on` |
| `2` | Usage or configuration error |
| `3` | Scan error (invalid target, I/O failure) |
| `4` | Partial scan: a plugin failed, and no findings at or above `--fail-on` |

### What gets checked

The **supply-chain engine** reads `package.json` (through the scope, so it can't be pointed outside the target) and reports:

| Rule | Severity |
|---|---|
| `credentials-in-url`: user:password or a token in a dependency URL | high |
| `insecure-source`: `http://` or `git://` dependency sources | high |
| `possible-typosquat`: same "skeleton" as a popular package (`l0dash`, `lo-dash`) | high |
| `possible-typosquat`: one edit away from a popular package (`lodahs`, `reakt`) | medium |
| `wildcard-version`: `*`, `latest`, `x` or an empty range | medium |
| `unpinned-git-dependency`: git or GitHub dependency without a `#ref` | medium |
| `missing-lockfile`: dependencies but no lockfile | low |

Typosquats are matched against a snapshot of popular packages that ships with CyberKit, so nothing is fetched.

### Semgrep plugin

```bash
npx cyberkit scan . -p semgrep
```

Needs `semgrep` on your `PATH` and a **local** rule config: `.semgrep.yml`, `.semgrep.yaml` or `.semgrep/` in the target. Registry configs (`auto`, `p/...`, URLs) are refused because they download rules, and Semgrep always runs with `--metrics=off --disable-version-check`. If Semgrep is missing or fails, the scan still finishes and exits `4` (or `1` if other findings cross the threshold). To write your own plugins, see the [plugin guide](docs/PLUGINS.md).

### Limiting what a scan touches

Add an optional `.cyberkit/scope.json` to the scanned project to exclude (or only include) paths:

```json
{ "version": 1, "exclude": ["vendor", "**/fixtures", "dist/**"] }
```

The CLI and SDK pick it up automatically. Findings in excluded paths are dropped, and an invalid file exits `2`. See [docs/SCOPE.md](docs/SCOPE.md) and the [JSON schema](docs/scope.schema.json).

### GitHub code scanning

```yaml
# .github/workflows/cyberkit.yml (in the project you want to scan)
- run: npx cyberkit scan . -f sarif -o cyberkit.sarif --fail-on high
- uses: github/codeql-action/upload-sarif@v4
  if: always()
  with:
    sarif_file: cyberkit.sarif
```

Each SARIF result carries the finding's content-addressed id as a fingerprint, so alerts stay the same across runs.

### SDK

```ts
import { renderPlain, scan, scanStream } from "@cyberkit/core";

// One call: engine and plugins run concurrently. Findings are deduplicated, sorted and frozen.
const result = await scan({ target: ".", plugins: ["semgrep"], failOn: "high" });
console.log(result.summary.total, "findings, exit code", result.exitCode);
process.stdout.write(renderPlain(result.findings));

// Streaming: findings arrive as each engine or plugin finishes.
for await (const event of scanStream({ target: "." })) {
  if (event.type === "finding") console.log(event.finding.severity, event.finding.ruleId);
  if (event.type === "end") process.exitCode = event.exitCode;
}
```

The SDK and CLI give identical results, and a parity test enforces it. Report order is locale-independent, so the same findings produce byte-identical text, JSON and SARIF on every machine. Other exports include `renderJson`, `renderSarif`, `createStore` (append-only JSONL), `createScope`, `redact`, `definePlugin`, `runPlugin` and `runPluginModule`.

## Developer console

For working on CyberKit itself there is a lazygit-style console that runs every project command from one screen, keeps a history of every run and pulls out the errors of each one.

```bash
npm run build   # once
npm run ui      # or: npx cyberkit-dev
```

```text
 CyberKit dev console · cyberkit                                                      idle · 2 runs
┌─ 1 Commands ─────────────────────┐┌─ 3 Output · core › typecheck · ✗ exit 2 · 12 lines · follow ─┐
│ checks                           ││                                                              │
│ ▶ verify                         ││ > @cyberkit/core@0.1.0 typecheck                             │
│ root                             ││ > tsc -p tsconfig.json                                       │
│   lint                     ✓ 5.2s││                                                              │
│   build                          ││ src/version.ts(3,14): error TS2322: Type 'string' is not assi│
│   test                           ││ npm error Lifecycle script `typecheck` failed with error:    │
│   typecheck                      ││ npm error code 2                                             │
│ core                             ││ npm error path /home/dev/projects/security/cyberkit-repo/pack│
│   build                          ││ npm error workspace @cyberkit/core@0.1.0                     │
│   test                           ││ npm error location /home/dev/projects/security/cyberkit-repo/│
│   typecheck                ✗ 5.2s││ npm error command failed                                     │
│ dev                              ││ npm error command sh -c tsc -p tsconfig.json                 │
└──────────────────────────────────┘│                                                              │
┌─ 2 Runs ─────────────────────────┐└──────────────────────────────────────────────────────────────┘
│›✗ 04:37:23 core › typecheck  5.2s│┌─ 4 Errors (2) · core › typecheck ────────────────────────────┐
│ ✓ 04:37:17 lint  5.2s            ││ typescript  src/version.ts:3:14  TS2322  Type 'string' is not│
│                                  ││ npm  Lifecycle script `typecheck` failed with error:         │
│                                  ││                                                              │
│                                  ││                                                              │
│                                  ││                                                              │
└──────────────────────────────────┘└──────────────────────────────────────────────────────────────┘
 enter show run · r rerun · x cancel · tab panes · ? help · q quit
```

- **Commands** lists every npm script of the repo and of each package (found automatically from the `package.json` files), the `verify` chain (`lint → typecheck → build → test`, the same order as CI) and *scan this repo*. Each command shows the result of its last run.
- **Runs** is the history: every run is cached under `node_modules/.cache/cyberkit-dev` (a redacted log per run plus `history.json`, the last 100 runs), so it survives restarts.
- **Output** streams the selected run live and follows the tail.
- **Errors** is the error log of the selected run. It recognises TypeScript (`tsc`), ESLint, failing vitest tests (with the `file:line` of the assertion), uncaught exceptions with their first stack frame, and npm lifecycle failures; anything else that fails shows its last stderr line. Press `enter` on an error to jump to it in the output.

| Key | Action |
|---|---|
| `enter` / `space` | Run the selected command · show the selected run · jump to the selected error |
| `a` | Run all checks (`verify`) |
| `r` | Re-run the run shown in Output |
| `x` | Cancel the running command (kills its whole process tree) |
| `e` | Show only the error lines (plus 3 lines of context) in Output |
| `/` | Filter the output (`esc` clears) |
| `f`, `G` | Toggle follow · jump to the end and follow |
| `tab`, `1`–`4`, `h`/`l` | Switch panes |
| `j`/`k`, `g`/`G`, `ctrl-d`/`ctrl-u` | Move or scroll |
| `?` | Help |
| `q` | Quit (asks first if a command is still running) |

It also works without the UI, for scripts and quick checks:

```bash
npx cyberkit-dev --list               # what it can run
npx cyberkit-dev --run chain:verify   # run without the UI, print the error log, exit with the command's code
npx cyberkit-dev --errors             # the error log of the latest run (or: --errors <run id>)
npx cyberkit-dev --history            # recent runs
npx cyberkit-dev --clear-history      # delete the cache
```

Commands are spawned without a shell. Their output is stripped of terminal escape sequences and redacted before it is shown or written to the cache, so a test that prints a token doesn't leave it in a log. The console is a private workspace package (`packages/dev`) and is not published.

## Roadmap

All 22 tasks of the v0.1.0 test-driven plan are done: redaction, scope validation and scope files, the static no-network guard, config and CLI parsing, the findings store, the supply-chain engine and typosquat snapshot, plugin isolation and the Semgrep plugin, plain, JSON and SARIF reporters, exit codes, `scan()`, `scanStream()`, the CLI, the end-to-end and SDK/CLI parity test suites, and the docs. The `@cyberkit/tui` terminal UI has shipped too, and contributors get the `npm run ui` developer console (runs every project command, caches runs, error log per run). All findings from a red-team assessment have since been fixed: output and config symlinks, PATH hijacking, redaction gaps and ReDoS, TOCTOU reads, and unbounded plugin, store and scope-matching work. See [CHANGELOG.md](CHANGELOG.md).

Next: publishing `@cyberkit/core` to npm.

## Contributing

Contributions are welcome. **All pull requests must target the `dev` branch, not `main`.** Please read [CONTRIBUTING.md](CONTRIBUTING.md) first.

## Security

Please don't report vulnerabilities in public issues. Use GitHub's private vulnerability reporting (Security tab > Report a vulnerability).

## License

To be decided before the first release.
