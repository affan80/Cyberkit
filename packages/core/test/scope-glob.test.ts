/**
 * Differential + performance tests for the compiled glob matchers (#54).
 * `reference` is the original algorithm (every pattern against every
 * directory prefix, recursive memoised matcher); the optimised matchers
 * must agree with it on random input.
 */
import { describe, expect, it } from "vitest";
import { compileGlob, compileGlobSet } from "../src/scope-file.js";

function referenceSegment(pattern: string, text: string): boolean {
  const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")}$`);
  return re.test(text);
}
function referenceGlob(pattern: string, relPath: string): boolean {
  const pat = pattern.replace(/\/+$/, "").split("/");
  const parts = relPath.split("/");
  const memo = new Map<number, boolean>();
  const match = (pi: number, si: number): boolean => {
    const key = pi * (parts.length + 1) + si;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    let r: boolean;
    if (pi === pat.length) r = si === parts.length;
    else if (pat[pi] === "**") r = match(pi + 1, si) || (si < parts.length && match(pi, si + 1));
    else r = si < parts.length && referenceSegment(pat[pi] as string, parts[si] as string) && match(pi + 1, si + 1);
    memo.set(key, r);
    return r;
  };
  return match(0, 0);
}
const referenceSelfOrAncestor = (patterns: readonly string[], parts: readonly string[]): boolean =>
  parts.some((_, i) => patterns.some((p) => referenceGlob(p, parts.slice(0, i + 1).join("/"))));

// Small deterministic PRNG so failures are reproducible.
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
const NAMES = ["a", "b", "ab", "src", "lib", "x.js", "a.ts", "test", "node_modules", "ba"];
const SEGS = [...NAMES, "*", "**", "?", "a*", "*b", "*a*", "?b", "*.js", "s*c", "**"];

describe("compileGlob / compileGlobSet agree with the reference matcher", () => {
  it("on 3000 random pattern sets and paths (including > 30-deep paths)", () => {
    const r = rng(54);
    for (let iter = 0; iter < 3000; iter++) {
      const patterns = Array.from({ length: 1 + Math.floor(r() * 4) }, () =>
        Array.from({ length: 1 + Math.floor(r() * 4) }, () => pick(r, SEGS)).join("/"),
      );
      const depth = iter % 50 === 0 ? 31 + Math.floor(r() * 5) : 1 + Math.floor(r() * 6);
      const parts = Array.from({ length: depth }, () => pick(r, NAMES));
      const expected = referenceSelfOrAncestor(patterns, parts);
      expect(compileGlobSet(patterns).matchesSelfOrAncestor(parts), `${JSON.stringify(patterns)} vs ${parts.join("/")}`).toBe(expected);
      for (const p of patterns) expect(compileGlob(p).test(parts.join("/"))).toBe(referenceGlob(p, parts.join("/")));
    }
  }, 30_000);

  it("handles an empty pattern list and the root", () => {
    expect(compileGlobSet([]).matchesSelfOrAncestor(["a"])).toBe(false);
    expect(compileGlobSet(["**"]).matchesSelfOrAncestor([])).toBe(false);
  });
});

describe("compileGlobSet performance (#54)", () => {
  it("checks a 13-deep path against 1000 wildcard patterns in a few hundred microseconds", () => {
    const set = compileGlobSet(Array.from({ length: 1000 }, (_, i) => `**/*a*b${i}/**`));
    const paths = Array.from({ length: 200 }, (_, i) => Array.from({ length: 12 }, (_, d) => `d${d}x${i}`).concat("f.js"));
    let best = Infinity;
    for (let attempt = 0; attempt < 3; attempt++) {
      const start = performance.now();
      for (const p of paths) set.matchesSelfOrAncestor(p);
      best = Math.min(best, (performance.now() - start) / paths.length);
    }
    expect(best).toBeLessThan(3); // ms per path (~0.2 ms idle, ~15 ms before #54); slack for loaded CI workers
  }, 30_000); // generous: the default 5 s is too tight when the whole suite runs in parallel
});
