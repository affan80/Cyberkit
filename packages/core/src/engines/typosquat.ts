/**
 * Typosquat detection against a bundled, offline snapshot of popular npm
 * package names. Two signals:
 *  - same "skeleton" as a popular name (separators removed, digit look-alikes
 *    mapped, e.g. `l0dash`, `lo-dash`): high
 *  - one edit away (insert, delete, substitute, adjacent swap): medium
 * The index is built once per snapshot; each lookup only compares names of
 * similar length, so cost stays flat as the snapshot grows.
 */
import bundled from "../data/typosquat-snapshot.json" with { type: "json" };
import type { Check, CheckResult, Dep } from "./supply-chain.js";

export interface TyposquatSnapshot {
  readonly version: number;
  readonly generatedAt: string;
  readonly source: string;
  readonly packages: readonly string[];
}

export const snapshot: TyposquatSnapshot = Object.freeze({ ...bundled, packages: Object.freeze([...bundled.packages]) });

const MIN_EDIT_LENGTH = 5; // shorter names are too close to each other to flag by edit distance
const DIGIT_LOOKALIKES: Readonly<Record<string, string>> = { "0": "o", "1": "l", "3": "e", "4": "a", "5": "s", "7": "t" };

export function skeleton(name: string): string {
  return name.toLowerCase().replace(/[-_.]/g, "").replace(/[013457]/g, (d) => DIGIT_LOOKALIKES[d] ?? d);
}

/** True when `a` and `b` differ by exactly one insert, delete, substitution or adjacent transposition. */
export function isWithinOneEdit(a: string, b: string): boolean {
  if (a === b) return false;
  if (a.length === b.length) {
    let first = -1;
    let diffs = 0;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) {
        if (++diffs > 2) return false;
        if (first === -1) first = i;
      }
    }
    if (diffs === 1) return true;
    // Exactly two differences: only allowed as an adjacent swap.
    return a[first] === b[first + 1] && a[first + 1] === b[first] && a.slice(first + 2) === b.slice(first + 2);
  }
  const [s, l] = a.length < b.length ? [a, b] : [b, a];
  if (l.length - s.length !== 1) return false;
  let i = 0;
  while (i < s.length && s[i] === l[i]) i++;
  return s.slice(i) === l.slice(i + 1);
}

export function createTyposquatCheck(snap: TyposquatSnapshot = snapshot): Check {
  if (!Array.isArray(snap?.packages) || !snap.packages.every((p) => typeof p === "string")) {
    throw new TypeError("typosquat snapshot must have a packages array of strings");
  }
  const known = new Set(snap.packages.map((p) => p.toLowerCase()));
  const bySkeleton = new Map<string, string>();
  const byLength = new Map<number, string[]>();
  for (const name of known) {
    const sk = skeleton(name);
    if (!bySkeleton.has(sk)) bySkeleton.set(sk, name);
    const bucket = byLength.get(name.length) ?? [];
    bucket.push(name);
    byLength.set(name.length, bucket);
  }

  const lookalikeOf = (name: string): { popular: string; severity: "high" | "medium" } | undefined => {
    const sameSkeleton = bySkeleton.get(skeleton(name));
    if (sameSkeleton !== undefined) return { popular: sameSkeleton, severity: "high" };
    if (name.length < MIN_EDIT_LENGTH) return undefined;
    for (let len = name.length - 1; len <= name.length + 1; len++) {
      for (const candidate of byLength.get(len) ?? []) {
        if (candidate.length >= MIN_EDIT_LENGTH && isWithinOneEdit(name, candidate)) return { popular: candidate, severity: "medium" };
      }
    }
    return undefined;
  };

  return (manifest) => {
    const results: CheckResult[] = [];
    for (const dep of manifest.deps as readonly Dep[]) {
      const name = dep.name.toLowerCase();
      if (name.startsWith("@") || known.has(name)) continue;
      const hit = lookalikeOf(name);
      if (hit) {
        results.push({
          ruleId: "possible-typosquat",
          severity: hit.severity,
          message: `${dep.name} (${dep.section}) resembles the popular package "${hit.popular}"`,
          dep,
        });
      }
    }
    return results;
  };
}
