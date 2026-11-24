# CyberKit

**An offline-first security assessment toolkit for developers and security teams.**

> Status: early development (`@cyberkit/core` v0.1.0). APIs may change.

## What it is

CyberKit is a Node.js/TypeScript toolkit that scans a project, runs security checks locally, and reports the results as structured findings. It ships as:

- `@cyberkit/core`: a CLI and an SDK (`scan()` and a streaming iterator).
- `@cyberkit/tui`: a terminal UI (planned, deferred past v0.1.0).

Core features:

- **Supply-chain engine** that checks dependencies, including typosquat detection against a bundled snapshot.
- **Plugin system** with isolated plugins (for example Semgrep).
- **Scope model** that restricts what a scan may touch, using realpath-validated paths, so a scan can't wander outside the target.
- **Immutable findings** with deterministic, content-addressed IDs, so the same issue always gets the same ID across runs.
- **Redaction at creation time** for tokens, credentials, cookies, auth headers and PEM keys. Redaction is irreversible, so secrets never reach reports or logs.
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

## Setup

```bash
git clone https://github.com/affan80/Cyberkit.git
cd Cyberkit
git checkout dev
npm install
npm run build
npm test
```

Usage examples will be added as the CLI lands (roadmap tasks 17-19).

## Roadmap

v0.1.0 follows a 22-task, test-driven plan. Done so far: monorepo init, error types and the finding model. Next up: redaction, then scope validation, config/CLI parsing, the findings store, engines, plugins and reporters.

## Contributing

Contributions are welcome. **All pull requests must target the `dev` branch, not `main`.** Please read [CONTRIBUTING.md](CONTRIBUTING.md) first.

## Security

Please don't report vulnerabilities in public issues. Use GitHub's private vulnerability reporting (Security tab > Report a vulnerability).

## License

To be decided before the first release.
