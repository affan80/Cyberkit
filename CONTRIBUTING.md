# Contributing to CyberKit

Thanks for helping out! Please follow these rules so reviews stay quick.

## The most important rule

> **Every pull request must target the `dev` branch. Never open a PR against `main`.**

- `main` holds released, stable code only. Maintainers merge `dev` into `main` at release time.
- `dev` is the integration branch where all work lands first.
- PRs opened against `main` will be closed or retargeted to `dev`.

## Workflow

1. Open or pick an issue (use the issue templates). Comment to claim it.
2. Fork the repo and branch from `dev`:
   ```bash
   git fetch origin
   git checkout -b feat/short-description origin/dev
   ```
3. Make your change, following the rules below.
4. Open a PR with **base: `dev`**, and fill in the PR template.
5. Respond to review feedback. Maintainers squash-merge into `dev`.

## Branch names

`feat/...`, `fix/...`, `docs/...`, `test/...`, `chore/...`

## Commit messages

Use the form `area: short imperative summary`, for example `core: add redaction for auth headers`. Keep commits focused.

## Code rules

- **Node >= 22.13.0**, TypeScript `strict`, ESM.
- **Test-first.** Write a failing test, then the minimal code to pass it. PRs without tests for new behavior won't be merged.
- Run before pushing: `npm run lint && npm run build && npm test`. Or open the developer console with `npm run ui` and press `a` to run the same checks as CI, with an error log for anything that fails.
- **No network calls in `@cyberkit/core`.** The static no-network test must keep passing.
- **Never log or store secrets.** Findings must go through redaction.
- Findings are immutable. Don't mutate them after creation.
- Keep PRs small and about one thing.

## Do not commit

- Secrets, tokens, `.env` files or real credentials (including in test fixtures).
- Internal planning files such as `GATE3_BUILD.md` and `GATE3_BUILD.html`. They are gitignored.
- `node_modules/` and `dist/`.

## Reporting bugs and requesting features

Use the issue templates. For security vulnerabilities, don't open a public issue. Use GitHub's private vulnerability reporting.

## Conduct

Be respectful and constructive. Harassment or abuse isn't tolerated.
