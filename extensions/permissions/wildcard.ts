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
 *   - a pattern ending in a path wildcard also matches the directory itself,
 *     so `~/.pi/*` and `~/.pi/**` both match `~/.pi`
 *
 * Note that `*` crosses path separators. `packages/web/*.mdx` matches nested
 * files too. That is intentional: OpenCode patterns are not shell globs.
 * Because `*` already crosses `/`, `folder/*` and `folder/**` are equivalent,
 * and a folder rule must cover the folder itself. Allowing only the children
 * of a folder is not a useful policy: a deny on a child is written explicitly.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const cache = new Map<string, RegExp>();

function compile(pattern: string): RegExp {
  const cached = cache.get(pattern);
  if (cached) return cached;

  let escaped = pattern
    .replace(/\\/g, "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*+/g, ".*")
    .replace(/\?/g, ".");

  if (escaped.endsWith(" .*")) {
    escaped = `${escaped.slice(0, -3)}( .*)?`;
  } else if (/[^ ]\/\.\*$/.test(escaped)) {
    // `folder/*` and `folder/**` also match `folder`. The guard skips a slash
    // that follows a space, which is a command pattern such as `ls /*`.
    escaped = escaped.replace(/\/\.\*$/, "(/.*)?");
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
 *
 * The canonical (symlink-resolved) form is added too when it differs. A rule is
 * written against the real target, so matching only the lexical name lets
 * `cat link` walk past a deny on `link -> .env`. Both spellings stay, so a rule
 * written against either name still matches.
 */
export function pathPatterns(abs: string, home = os.homedir()): string[] {
  const spellings = [abs];
  const real = canonicalize(abs);
  if (real !== abs) spellings.push(real);

  const out: string[] = [];
  for (const candidate of spellings) {
    out.push(candidate);
    const homeRel = path.relative(home, candidate);
    if (homeRel && !homeRel.startsWith("..") && !path.isAbsolute(homeRel)) {
      out.push(`~/${homeRel}`);
    }
  }
  return [...new Set(out)];
}

/**
 * Resolve symlinks in a path. Follows to the nearest existing ancestor when
 * part of the path does not exist yet, so a file about to be created still
 * resolves through symlinked parents. Returns the lexical path when nothing
 * along it exists.
 */
export function canonicalize(target: string): string {
  const lexical = path.resolve(target);
  let current = lexical;
  const tail: string[] = [];

  for (;;) {
    try {
      const real = fs.realpathSync(current);
      return tail.length === 0 ? real : path.join(real, ...tail.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return lexical;
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * True when a path sits outside the working directory. Both sides are
 * canonicalized first, so a symlink inside the tree that points outside it is
 * caught instead of passing as a lexical child.
 */
export function isExternal(abs: string, cwd: string): boolean {
  const rel = path.relative(canonicalize(cwd), canonicalize(abs));
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
