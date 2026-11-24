# Scope

The **scope** is the set of files a scan may touch. CyberKit enforces it in the core, not in each engine or plugin, so nothing can read or report outside it.

## The scan root

Every scan has one root directory: the CLI `target`, `scan({ target })`, or `createScope(root)`.

- The root is canonicalised with `realpath` once. It must exist and be a directory.
- Every path is canonicalised with `realpath` **before** the containment check. `..` segments, absolute paths and symlinks that lead outside the root are rejected, and so are dangling symlinks.
- A sibling directory that shares the root's name as a prefix (`project` vs `project-evil`) is outside the root.
- Paths that don't exist yet are resolved through their nearest existing ancestor.

## Scope files

To narrow a scan further, add an optional `.cyberkit/scope.json` to the scan root:

```json
{
  "$schema": "https://github.com/affan80/Cyberkit/blob/dev/docs/scope.schema.json",
  "version": 1,
  "exclude": ["vendor", "**/fixtures", "dist/**", "*.min.js"]
}
```

The CLI and the SDK both pick it up automatically. The full format is defined by [`scope.schema.json`](scope.schema.json). Point `$schema` at it for editor completion and validation. A test keeps the schema and CyberKit's own validator in agreement.

| Key | Required | Meaning |
|---|---|---|
| `version` | yes | Must be `1`. |
| `exclude` | no | Paths matching any of these globs **and everything beneath a matching directory** are out of scope. |
| `include` | no | If non-empty, only paths matching one of these globs, or beneath a matching directory, are in scope. |
| `$schema` | no | Ignored by CyberKit, for editors. |

Any other key is an error. That catches typos like `exlude` instead of silently scanning everything.

### Patterns

Patterns are **relative to the scan root** and always use `/`:

| Pattern | Matches |
|---|---|
| `vendor` | the `vendor` directory and everything in it |
| `*.min.js` | `*.min.js` files **at the root** (`*` never crosses `/`) |
| `**/*.min.js` | `*.min.js` files at any depth |
| `**/fixtures` | every `fixtures` directory, at any depth, and its contents |
| `dist/**` | everything under `dist` (and `dist` itself) |
| `src/?.ts` | `src/a.ts`, but not `src/ab.ts` |

- `*` matches within one path segment, `?` matches one character in a segment, and `**` matches any number of segments, including none.
- A trailing `/` is ignored (`dist/` is the same as `dist`).
- Not allowed: a leading `/`, `..` segments, backslashes, NUL bytes, empty patterns, patterns over 1024 characters, or more than 1000 patterns per list.

### How include and exclude combine

1. The root itself is always in scope.
2. A path is **out** if it, or any directory above it, matches an `exclude` pattern.
3. If `include` is non-empty, a path is **in** only if it, or a directory above it, matches an `include` pattern. So name directories or files (`"src"`, `"packages/*/src"`, `"package.json"`), not just deep file globs.
4. Exclusion is checked on the **real** path, after symlinks are resolved. A symlink can't be used to reach an excluded directory.

## What scope affects

- **`scope.resolve(path)`** throws `ScopeError` for excluded paths, exactly as for paths outside the root, and **`scope.contains(path)`** returns `false`.
- **Plugins:** findings that point at an excluded file are dropped and counted in the plugin's `skipped`.
- **Supply-chain engine:** an excluded `package.json` isn't scanned. An excluded lockfile counts as absent, so `missing-lockfile` is reported if dependencies exist.

## Errors

A scope file that is invalid JSON, fails validation, is larger than 64 KB, or is a symlink pointing outside the root stops the scan with a clear message. The CLI exits with code **2** (usage/configuration error):

```console
$ npx cyberkit scan .
cyberkit: .cyberkit/scope.json: unknown scope config key "exlude"
Run "cyberkit --help" for usage.
```

## SDK

```ts
import { createScope } from "@cyberkit/core";

// Reads .cyberkit/scope.json from the root (default), plus explicit options:
const scope = await createScope("./app", {
  exclude: ["generated"],   // added to the scope file's excludes
  include: ["src"],         // replaces the scope file's include, if given
  scopeFile: true,          // set false to ignore .cyberkit/scope.json
});

scope.isExcluded("generated/types.ts"); // true: a pure check, no filesystem access
await scope.contains("src/index.ts");    // true
```

`scan()` and `scanStream()` create their scope this way, so they honour the scope file automatically.
