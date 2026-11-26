# Changelog

All notable changes to CyberKit are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

Fixes from the red-team assessment of `dev` (issues #46–#57 and #60).

### Added

- **Developer console** (`npm run ui` / `npx cyberkit-dev`, private package `packages/dev`): a lazygit-style terminal UI that runs every npm script in the repo and its packages, the `verify` chain (lint → typecheck → build → test, as in CI) and a repo scan. It caches every run (log + error log) under `node_modules/.cache/cyberkit-dev`, and extracts an error log per run (TypeScript, ESLint, vitest failures, uncaught exceptions, npm failures) with jump-to-error. Non-interactive modes: `--list`, `--run <id>`, `--errors`, `--history`, `--clear-history`, `--frame`. Output is escape-stripped and redacted before display and before it is cached; cancel kills the whole process tree.

### Security

- **`--output` never writes through a symlink** (#46). A report path, or a directory leading to it inside the scanned tree or the working directory, that is a symbolic link is refused (exit `3`). Reports are written to a temp file and renamed into place.
- **The Semgrep plugin never runs a repo-supplied `semgrep`** (#47). The binary is resolved to an absolute path that skips empty and relative `PATH` entries and anything inside the scan root, and the child runs with a cwd outside the scanned tree.
- **Semgrep configs are resolved through the scan scope** (#56). A `.semgrep.yml`, `.semgrep.yaml` or `.semgrep/` symlinked outside the root is refused before Semgrep runs. Plugins get a new `ctx.resolve()` for the same check.
- **Redaction covers more formats** (#48): GitLab tokens, Slack webhook URLs, Stripe keys and webhook secrets, OpenAI and Anthropic keys, Google API keys, PGP private key blocks and PuTTY `.ppk` keys.
- **Redaction covers more structures** (#49): JSON/dict-form `Authorization`/`Cookie`/`Set-Cookie` headers, token-only URL userinfo (`https://TOKEN@host`), single-quoted keys, and the key names `passphrase`, `AccountKey`, `auth`/`_auth`, `authorization` and `cookie`.
- **Every redaction rule runs in linear time** (#50). Three rules were quadratic on adversarial input (a 280 KB message took about 5 s).
- **Every free-text finding field is redacted** (#55): `ruleId` and `file` as well as `message` and `evidence`. `verifyFinding()` checks all of them.
- **Engine reads are atomic** (#51). `package.json` and `.cyberkit/scope.json` are read through one descriptor (`O_NOFOLLOW`, `fstat`, inode check, hard byte cap), so a symlink swap can't make CyberKit read a file outside the scope. Engines get a new `scope.readFile()` for the same read.
- **Plugin output processing is bounded** (#52):
  - Validation shares the plugin's deadline (`timeoutMs` + 1 s), past which the run ends as `invalid-output`.
  - A new `maxItems` option caps the items examined.
  - `message` and `evidence` are capped at 8 KB.

### Performance

- The supply-chain engine locates dependency lines in one pass (#53). A 1 MB manifest went from 20.8 s to 1.2 s. This also fixes wrong line numbers for nested `"dependencies"` keys, escaped keys and duplicate keys.
- Scope include/exclude matching tests each pattern once per path, using a bitset matcher and a cache (#54). With 1000 patterns, each path went from about 15 ms to under 0.2 ms.
- The findings store reads with a bounded line splitter (#57). Records over 1 MB are rejected without being buffered, and parse errors no longer quote record content.
- Report sorting no longer uses `localeCompare` (#60). It's about 8× faster.

### Changed

- **Report order is now locale-independent** (#60). `file` and `ruleId` are compared by UTF-16 code unit instead of the runtime locale, so identical findings give byte-identical text, JSON and SARIF output on every machine. As a result, **mixed-case paths sort differently**: uppercase before lowercase (`B.ts`, `a.ts`, `b.ts`), and digits by character (`a10.ts` before `a2.ts`).
- A store record over 1 MB is rejected on write as well as on read (#57).

### Fixed

- The CLI no longer crashes with `ENOTCONN`/`ECONNRESET` when stdout's reader goes away. This happens on macOS socketpair stdio (#74).

## [0.1.0]

- First release. Includes the supply-chain engine, the Semgrep plugin, plugin isolation, redaction, scope files, plain/JSON/SARIF reporters, the `scan()`/`scanStream()` SDK, the CLI and the `@cyberkit/tui` terminal UI.
