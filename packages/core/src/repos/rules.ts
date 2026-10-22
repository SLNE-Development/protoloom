import type { PathRules } from "./config.js";

const compiled = new Map<string, RegExp>();

/** The anchored regex of a glob pattern where `*` matches any run of characters (dots and slashes too). */
function globRegex(pattern: string): RegExp {
  let re = compiled.get(pattern);
  if (!re) {
    const body = pattern
      .split("*")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"))
      .join(".*");
    re = new RegExp(`^${body}$`, "s");
    if (compiled.size > 1000) compiled.clear();
    compiled.set(pattern, re);
  }
  return re;
}

/** Glob match where `*` matches any run of characters; empty allow = allow all; deny wins. */
export function matchesRules(rules: PathRules, subject: string): boolean {
  if (rules.deny.some((p) => globRegex(p).test(subject))) return false;
  return rules.allow.length === 0 || rules.allow.some((p) => globRegex(p).test(subject));
}
