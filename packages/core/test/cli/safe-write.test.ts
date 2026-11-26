import { link, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UnsafeOutputError, writeFileNoFollow } from "../../src/cli/safe-write.js";

const posix = process.platform !== "win32";

let root: string; // the untrusted tree (scan root)
let victim: string; // a directory outside it that must never be touched
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "cyberkit-sw-root-")));
  victim = await realpath(await mkdtemp(path.join(tmpdir(), "cyberkit-sw-victim-")));
  await writeFile(path.join(victim, "authorized_keys"), "ssh-ed25519 AAAA-original-key\n");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(victim, { recursive: true, force: true });
});

const opts = () => ({ untrustedRoots: [root] });
const victimIntact = async () => expect(await readFile(path.join(victim, "authorized_keys"), "utf8")).toBe("ssh-ed25519 AAAA-original-key\n");
const noTempLeft = async (dir: string) => expect((await readdir(dir)).filter((f) => f.endsWith(".tmp"))).toEqual([]);

describe("writeFileNoFollow", () => {
  it("creates the file and any missing directories", async () => {
    const file = path.join(root, "a", "b", "out.json");
    await writeFileNoFollow(file, "{}", opts());
    expect(await readFile(file, "utf8")).toBe("{}");
    await noTempLeft(path.dirname(file));
  });

  it("replaces an existing regular file", async () => {
    const file = path.join(root, "out.json");
    await writeFile(file, "old");
    await writeFileNoFollow(file, "new", opts());
    expect(await readFile(file, "utf8")).toBe("new");
  });

  it.runIf(posix)("keeps the permission bits of a file it replaces", async () => {
    const file = path.join(root, "out.json");
    await writeFile(file, "old", { mode: 0o600 });
    await writeFileNoFollow(file, "new", opts());
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("refuses a symlink at the output path (issue #46)", async () => {
    const file = path.join(root, "cyberkit.sarif");
    await symlink(path.join(victim, "authorized_keys"), file);
    await expect(writeFileNoFollow(file, "pwned", opts())).rejects.toThrow(UnsafeOutputError);
    await victimIntact();
    expect((await lstat(file)).isSymbolicLink()).toBe(true);
    await noTempLeft(root);
  });

  it("refuses a dangling symlink at the output path", async () => {
    const file = path.join(root, "cyberkit.sarif");
    await symlink(path.join(victim, "new-file"), file);
    await expect(writeFileNoFollow(file, "pwned", opts())).rejects.toThrow(/symbolic link/);
    await expect(stat(path.join(victim, "new-file"))).rejects.toThrow();
  });

  it("refuses a symlinked directory on the way to the output (issue #46)", async () => {
    await symlink(victim, path.join(root, "reports"));
    await expect(writeFileNoFollow(path.join(root, "reports", "authorized_keys"), "pwned", opts())).rejects.toThrow(/symbolic link/);
    await victimIntact();
    expect(await readdir(victim)).toEqual(["authorized_keys"]);
  });

  it("refuses a symlinked directory deeper in the path, without creating anything through it", async () => {
    await mkdir(path.join(root, "a"));
    await symlink(victim, path.join(root, "a", "b"));
    await expect(writeFileNoFollow(path.join(root, "a", "b", "c", "out.json"), "x", opts())).rejects.toThrow(/symbolic link/);
    expect(await readdir(victim)).toEqual(["authorized_keys"]);
  });

  it("refuses to replace a directory or other non-regular file", async () => {
    await mkdir(path.join(root, "out.json"));
    await expect(writeFileNoFollow(path.join(root, "out.json"), "x", opts())).rejects.toThrow(/not a regular file/);
  });

  it.runIf(posix)("replaces a hard link instead of writing through it", async () => {
    const file = path.join(root, "out.json");
    await link(path.join(victim, "authorized_keys"), file);
    await writeFileNoFollow(file, "report", opts());
    expect(await readFile(file, "utf8")).toBe("report");
    await victimIntact();
  });

  it("allows symlinks above the untrusted root (the user's own path choice)", async () => {
    const alias = path.join(victim, "alias");
    await symlink(root, alias);
    const file = path.join(alias, "out.json");
    await writeFileNoFollow(file, "ok", { untrustedRoots: [alias] });
    expect(await readFile(path.join(root, "out.json"), "utf8")).toBe("ok");
  });

  it("still refuses a final symlink outside every untrusted root", async () => {
    const file = path.join(victim, "out.json");
    await symlink(path.join(victim, "authorized_keys"), file);
    await expect(writeFileNoFollow(file, "x", { untrustedRoots: [root] })).rejects.toThrow(/symbolic link/);
    await victimIntact();
  });

  it("checks from the outermost untrusted root that contains the output", async () => {
    await symlink(victim, path.join(root, "sub"));
    // Even though "sub" is also listed (e.g. as the scan target), the
    // outer root contains it, so the link is caught.
    await expect(writeFileNoFollow(path.join(root, "sub", "x.json"), "x", { untrustedRoots: [path.join(root, "sub"), root] })).rejects.toThrow(/symbolic link/);
    expect(await readdir(victim)).toEqual(["authorized_keys"]);
  });
});
