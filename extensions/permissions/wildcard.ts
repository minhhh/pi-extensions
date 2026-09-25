/**
 * Wildcard matching for permission patterns.
 *
 * This is a port of OpenCode's `Wildcard.match`, kept close to the original so
 * configs behave the same:
 *
 *   - `*` matches zero or more of any character, including `/`
 *   - `?` matches exactly one character
 *   - everything else is literal
 *   - a pattern ending in " *" makes the trailing space and rest optional, so
 *     `ls *` matches both `ls` and `ls -la`
 *
 * Note that `*` crosses path separators. `packages/web/*.mdx` matches nested
 * files too. That is intentional: OpenCode patterns are not shell globs.
 */

import * as os from "node:os";
import * as path from "node:path";

const cache = new Map<string, RegExp>();

function compile(pattern: string): RegExp {
  const cached = cache.get(pattern);
  if (cached) return cached;

  let escaped = pattern
    .replace(/\\/g, "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");

  if (escaped.endsWith(" .*")) {
    escaped = `${escaped.slice(0, -3)}( .*)?`;
  }

  const re = new RegExp(`^${escaped}$`, process.platform === "win32" ? "si" : "s");
  cache.set(pattern, re);
  return re;
}

export function wildcardMatch(value: string, pattern: string): boolean {
  return compile(pattern).test(value.replace(/\\/g, "/"));
}

/**
 * Expand a leading `~` or `$HOME` to the home directory. Only the start of a
 * pattern is expanded, matching OpenCode.
 */
export function expandHome(pattern: string, home = os.homedir()): string {
  if (pattern === "~") return home;
  if (pattern.startsWith("~/")) return home + pattern.slice(1);
  if (pattern.startsWith("$HOME/")) return home + pattern.slice(5);
  if (pattern.startsWith("$HOME")) return home + pattern.slice(5);
  return pattern;
}

/**
 * Spellings of one resolved path, tried in order. An absolute config pattern
 * hits the absolute form, and `~/...` hits the home form. The `~/...` form is
 * only added when the path sits under the home directory.
 */
export function pathPatterns(abs: string, home = os.homedir()): string[] {
  const out = [abs];
  const homeRel = path.relative(home, abs);
  if (homeRel && !homeRel.startsWith("..") && !path.isAbsolute(homeRel)) {
    out.push(`~/${homeRel}`);
  }
  return out;
}

/** True when a resolved path sits outside the working directory. */
export function isExternal(abs: string, cwd: string): boolean {
  const rel = path.relative(cwd, abs);
  return rel.startsWith("..") || path.isAbsolute(rel);
}

/** True when `child` sits strictly inside `parent`. */
export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Drop any folder that is contained by another folder in the list, so a set of
 * nested paths collapses to the outermost ones.
 */
export function collapseFolders(folders: readonly string[]): string[] {
  const unique = [...new Set(folders)];
  return unique.filter((folder) => !unique.some((other) => other !== folder && isInside(folder, other)));
}
