/**
 * Best-effort bash command analysis.
 *
 * This turns a shell string into segments the policy engine can reason about.
 * It is a guardrail, not a boundary: a shell string is a program, and no amount
 * of parsing makes it one. Anything that hides the real command from
 * inspection is surfaced as its own pattern so a rule can react to it rather
 * than being silently bypassed.
 *
 * Known limits, deliberately not papered over:
 *   - `sh -c '...'`, `eval`, and nested quoting are not expanded
 *   - aliases and shell functions are invisible
 *   - a wrapper with an unusual option-value pair may misattribute a command
 */

import * as os from "node:os";
import * as path from "node:path";

const WRAPPERS = new Set([
  "sudo",
  "doas",
  "command",
  "nohup",
  "exec",
  "time",
  "nice",
  "ionice",
  "stdbuf",
  "setsid",
  "env",
]);

const WRAPPER_OPTION_WITH_VALUE = new Set([
  "-u",
  "-g",
  "-p",
  "-C",
  "-D",
  "--user",
  "--group",
  "--prompt",
  "--chdir",
  "--directory",
]);

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Commands whose bare arguments are paths even without a slash in them. */
const PATH_COMMANDS = new Set([
  "rm",
  "rmdir",
  "shred",
  "dd",
  "truncate",
  "mkdir",
  "touch",
  "mv",
  "cp",
  "chmod",
  "chown",
  "chgrp",
  "ln",
  "tee",
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "stat",
  "du",
  "file",
  "readlink",
  "realpath",
  "install",
]);

/** Commands whose durable prefix is two words, so `git push *` beats `git *`. */
const TWO_WORD_COMMANDS = new Set([
  "git",
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "docker",
  "podman",
  "kubectl",
  "helm",
  "cargo",
  "go",
  "gh",
  "aws",
  "gcloud",
  "terraform",
  "systemctl",
  "apt",
  "apt-get",
  "brew",
  "pip",
  "pip3",
  "poetry",
  "uv",
  "deno",
  "bundle",
  "rails",
]);

const SUBSTITUTION = /\$\(|`|\$\{/;
const INDIRECT = /(^|\s)-exec(dir)?(\s|$)/;
const REDIRECTION = /(?:^|[^<>])>>?\s*(?:"([^"]+)"|'([^']+)'|([^\s;&|<>]+))/g;
const OPERATORS = new Set([">", ">>", ">>>", "<", "<<", "<<<", "2>", "2>>", "&>", "|&"]);

export const SUBSTITUTION_FAMILY = "(subshell)";
export const INDIRECT_FAMILY = "(indirect)";

/** One shell segment: candidates to match, paths touched, and display text. */
export interface BashSegment {
  /** Candidate command strings matched against `bash` patterns. */
  patterns: string[];
  /** Resolved paths the segment touches. */
  paths: string[];
  /** Patterns suggested for a session approval. */
  always: string[];
  display: string;
}

function clip(text: string, max = 80): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function isFlag(token: string): boolean {
  return token.startsWith("-") && token !== "-";
}

function basename(command: string): string {
  const parts = command.split("/");
  return parts[parts.length - 1] ?? command;
}

export function resolveUserPath(target: string, cwd: string): string {
  if (target === "~") return os.homedir();
  if (target.startsWith("~/")) return path.resolve(os.homedir(), target.slice(2));
  return path.resolve(cwd, target);
}

/** Split a command line into sub-commands at unquoted shell operators. */
export function splitCommands(input: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;

    if (quote) {
      current += ch;
      if (ch === "\\" && quote === '"') {
        current += input[++i] ?? "";
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }

    if (ch === "\\") {
      current += ch + (input[++i] ?? "");
      continue;
    }

    if (ch === "&") {
      const prev = input[i - 1];
      const next = input[i + 1];
      if (prev === ">" || prev === "<" || next === ">") {
        current += ch;
        continue;
      }
    }

    if (ch === ";" || ch === "\n" || ch === "&" || ch === "|") {
      parts.push(current);
      current = "";
      if ((ch === "&" || ch === "|") && input[i + 1] === ch) i++;
      continue;
    }

    current += ch;
  }

  parts.push(current);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** Split one sub-command into tokens, respecting quotes. */
function tokenize(segment: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let started = false;

  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]!;

    if (quote) {
      if (ch === "\\" && quote === '"') {
        current += segment[++i] ?? "";
        continue;
      }
      if (ch === quote) {
        quote = null;
        started = true;
        continue;
      }
      current += ch;
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
      continue;
    }

    if (ch === "\\") {
      current += segment[++i] ?? "";
      started = true;
      continue;
    }

    if (/\s/.test(ch)) {
      if (started || current) tokens.push(current);
      current = "";
      started = false;
      continue;
    }

    current += ch;
  }

  if (started || current) tokens.push(current);
  return tokens;
}

/**
 * Walk past env assignments and wrapper commands, collecting each wrapper as a
 * family and the real command as the last one. Every family gets evaluated, so
 * `sudo rm` is subject to both the `sudo` rule and the `rm` rule.
 */
function splitFamilies(tokens: string[]): { families: string[]; rest: string[] } {
  const families: string[] = [];
  let i = 0;

  while (i < tokens.length) {
    const token = tokens[i]!;

    if (ENV_ASSIGNMENT.test(token)) {
      i++;
      continue;
    }

    const base = basename(token);
    if (WRAPPERS.has(base)) {
      families.push(base);
      i++;
      while (i < tokens.length && isFlag(tokens[i]!)) {
        i += WRAPPER_OPTION_WITH_VALUE.has(tokens[i]!) ? 2 : 1;
      }
      continue;
    }

    families.push(base);
    i++;
    break;
  }

  return { families, rest: tokens.slice(i) };
}

function looksLikePath(token: string): boolean {
  return token.includes("/") || token.startsWith(".") || token.startsWith("~");
}

function redirectionTargets(segment: string): string[] {
  const targets: string[] = [];
  REDIRECTION.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = REDIRECTION.exec(segment)) !== null) {
    const target = match[1] ?? match[2] ?? match[3];
    if (target && target !== "/dev/null") targets.push(target);
  }
  return targets;
}

function collectPaths(segment: string, family: string, rest: string[], cwd: string): string[] {
  const paths = new Set<string>();
  const args = rest.filter((token) => !isFlag(token) && !OPERATORS.has(token));
  const candidates = PATH_COMMANDS.has(family) ? args : args.filter(looksLikePath);

  for (const candidate of candidates) paths.add(resolveUserPath(candidate, cwd));
  for (const target of redirectionTargets(segment)) paths.add(resolveUserPath(target, cwd));

  return [...paths];
}

/** Command strings a `bash` pattern can match, plus synthetic markers. */
function commandPatterns(tokens: string[], families: string[], primary: string, rest: string[]): string[] {
  const patterns = new Set<string>();

  const full = tokens.filter((token) => !ENV_ASSIGNMENT.test(token)).join(" ");
  if (full) patterns.add(full);

  if (primary) patterns.add([primary, ...rest].join(" "));
  for (const family of families) if (family) patterns.add(family);

  return [...patterns];
}

/** A durable prefix for the "always" grant, e.g. `git push *` or `rm *`. */
function approvalPatterns(primary: string, rest: string[]): string[] {
  if (!primary) return [];
  const arg = rest.find((token) => !isFlag(token) && !OPERATORS.has(token));
  const prefix = arg && TWO_WORD_COMMANDS.has(primary) ? `${primary} ${arg}` : primary;
  return [`${prefix} *`];
}

/** Analyze a command line into the segments the policy engine should evaluate. */
export function analyzeBash(command: string, cwd: string): BashSegment[] {
  const segments: BashSegment[] = [];

  for (const segment of splitCommands(command)) {
    const tokens = tokenize(segment);

    if (tokens.length === 0) {
      if (SUBSTITUTION.test(segment)) {
        segments.push({
          patterns: [SUBSTITUTION_FAMILY],
          paths: [],
          always: [SUBSTITUTION_FAMILY],
          display: `$ ${clip(segment)}`,
        });
      }
      continue;
    }

    const { families, rest } = splitFamilies(tokens);
    const primary = families[families.length - 1] ?? "";
    const paths = collectPaths(segment, primary, rest, cwd);

    const patterns = commandPatterns(tokens, families, primary, rest);
    const always = approvalPatterns(primary, rest);

    const substitution = SUBSTITUTION.test(segment);
    if (substitution) {
      patterns.push(SUBSTITUTION_FAMILY);
      always.push(SUBSTITUTION_FAMILY);
    }
    if (INDIRECT.test(segment) || families.includes("xargs")) {
      patterns.push(INDIRECT_FAMILY);
      always.push(INDIRECT_FAMILY);
    }

    segments.push({ patterns, paths, always, display: `$ ${clip(segment)}` });
  }

  return segments;
}
