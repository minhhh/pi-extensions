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
 *   - `cd` rebases later segments, but pipes, pushd/popd, and a `cd` inside a
 *     subshell are not modeled, so the base can be wrong after those
 */

import * as os from "node:os";
import * as path from "node:path";

import { sessionAlways, type AlwaysOption } from "./types.ts";

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

/**
 * Words that can start a line but never name a program to match against a
 * rule: shell keywords, plus the `[`/`test` conditionals. `do` prefixes the
 * body command, so it is dropped before parsing what follows. The rest are
 * path-only; a `for` header still contributes its word list, and `collectPaths`
 * still reads a conditional's path argument.
 *
 * `for` is deliberately absent. An empty pattern list can never match a rule,
 * so the gate would ask on every run and the prompt would offer no
 * always-grant. Keeping `for` as a candidate lets a rule cover the header.
 */
const NON_COMMAND_HEADS = new Set(["do", "done", "continue", "[", "test"]);

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

/**
 * Commands whose first positional argument is a program/expression, not a
 * path. The `/.../ ` delimiters in a sed or grep expression otherwise read as
 * a filesystem path.
 */
const SCRIPT_COMMANDS = new Set(["sed", "awk", "gawk", "mawk", "nawk", "grep", "egrep", "fgrep", "rg", "ag", "ack"]);

/** Flags that supply the program inline, moving it off the positional args. */
const INLINE_PROGRAM_FLAGS = ["--expression=", "--regexp=", "--file="];

/** Script flags whose value is a separate token, so the value is not a file. */
const SCRIPT_FLAG_WITH_VALUE = new Set([
  "-e",
  "-f",
  "-A",
  "-B",
  "-C",
  "-m",
  "-d",
  "-D",
  "--regexp",
  "--expression",
  "--file",
  "--after-context",
  "--before-context",
  "--context",
  "--max-count",
]);

/** Script flags that supply the program, so every remaining operand is a file. */
const PROGRAM_FLAGS = new Set(["-e", "-f", "--regexp", "--expression", "--file"]);

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
const OPERATORS = new Set([">", ">>", ">>>", "<", "<<", "<<<", "2>", "2>>", "&>", "|&"]);
/** A redirection token: optional fd digits, a redirect operator, then any target. */
const REDIRECTION = /^\d*(?:&>>?|>>>|>>|>|<<<|<<-|<<|<)/;
/** A bare redirect operator, so the following token is its target or delimiter. */
const REDIRECTION_OPERATOR = /^\d*(?:&>>?|>>>|>>|>|<<<|<<-|<<|<)$/;

export const SUBSTITUTION_FAMILY = "(subshell)";
export const INDIRECT_FAMILY = "(indirect)";

/** One shell segment: candidates to match, paths touched, and display text. */
export interface BashSegment {
  /** Candidate command strings matched against `bash` patterns. */
  patterns: string[];
  /** Resolved paths the segment touches. */
  paths: string[];
  /** Always choices for a session approval, specific first. */
  always: AlwaysOption[];
  display: string;
}

/**
 * Segments that carry a matchable command. A keyword-only segment such as
 * `done` or `continue` has no pattern, and no rule can match an empty pattern
 * list, so a request for it would always fall through to `ask` and prompt for
 * a word that does nothing. Any paths it touched are gated separately.
 */
export function matchableSegments(segments: readonly BashSegment[]): BashSegment[] {
  return segments.filter((segment) => segment.patterns.length > 0);
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

interface Heredoc {
  delimiter: string;
  stripTabs: boolean;
}

/**
 * Read a heredoc delimiter after its `<<` operator. The delimiter may be
 * quoted or escaped, which only changes shell expansion, not the terminator.
 */
function readHeredoc(input: string, start: number): { delimiter: string; end: number } | undefined {
  let i = start;
  while (i < input.length && (input[i] === " " || input[i] === "\t")) i++;

  let delimiter = "";
  let quote: '"' | "'" | null = null;

  while (i < input.length) {
    const ch = input[i]!;
    if (quote) {
      if (ch === quote) {
        quote = null;
        i++;
        continue;
      }
      delimiter += ch;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      i++;
      continue;
    }
    if (ch === "\\") {
      delimiter += input[i + 1] ?? "";
      i += 2;
      continue;
    }
    if (/[\s;&|<>()]/.test(ch)) break;
    delimiter += ch;
    i++;
  }

  return delimiter ? { delimiter, end: i } : undefined;
}

/** True when the segment opens a heredoc, so text after its first line is data. */
function opensHeredoc(segment: string): boolean {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]!;
    if (quote) {
      if (ch === "\\" && quote === '"') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "<" && segment[i + 1] === "<" && segment[i + 2] !== "<") {
      if (readHeredoc(segment, i + (segment[i + 2] === "-" ? 3 : 2))) return true;
    }
  }
  return false;
}

/**
 * The shell part of a segment: the command line, minus any heredoc body. The
 * body is fed to the command as data, so treating it as shell invents commands
 * and paths (`import json`) that were never run or read.
 */
function shellText(segment: string): string {
  const newline = segment.indexOf("\n");
  return newline !== -1 && opensHeredoc(segment) ? segment.slice(0, newline) : segment;
}

/** Count unquoted parentheses, which are the only ones that can group commands. */
function unquotedParens(text: string): { opens: number[]; closes: number[] } {
  const opens: number[] = [];
  const closes: number[] = [];
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === "\\" && quote === '"') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "(") opens.push(i);
    else if (ch === ")") closes.push(i);
  }

  return { opens, closes };
}

/**
 * Drop the parentheses that group a command list. A subshell splits at the
 * same operators as the rest of the line, so an opening `(` lands at the start
 * of a segment and its `)` lands at the end of another. Quoted parens stay
 * inside their token, and balanced parens that belong to `$(...)` are left
 * alone so the substitution is still visible to the rules.
 */
function stripGroupingParens(segment: string): string {
  const trimmed = segment.trim();
  if (!trimmed.includes("(") && !trimmed.includes(")")) return trimmed;

  const { opens, closes } = unquotedParens(trimmed);
  let lead = 0;
  while (trimmed[lead] === "(") lead++;

  const limit = lead > 0 ? lead : Math.max(0, closes.length - opens.length);
  const closeSet = new Set(closes);
  let end = trimmed.length;
  let removed = 0;
  while (removed < limit && end > 0 && trimmed[end - 1] === ")" && closeSet.has(end - 1)) {
    end--;
    removed++;
  }

  return trimmed.slice(lead, end);
}

/** Split a command line into sub-commands at unquoted shell operators. */
export function splitCommands(input: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let pending: Heredoc[] = [];

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

    // `<<` (or `<<-`) opens a heredoc, but `<<<` is a here-string and has no body.
    if (ch === "<" && input[i + 1] === "<" && input[i + 2] !== "<") {
      const stripTabs = input[i + 2] === "-";
      const read = readHeredoc(input, i + (stripTabs ? 3 : 2));
      if (read) {
        pending.push({ delimiter: read.delimiter, stripTabs });
        current += input.slice(i, read.end);
        i = read.end - 1;
        continue;
      }
    }

    if (ch === "&") {
      const prev = input[i - 1];
      const next = input[i + 1];
      if (prev === ">" || prev === "<" || next === ">") {
        current += ch;
        continue;
      }
    }

    // A heredoc body runs to its terminator line. Keep it on the header so the
    // display shows what is being approved, but never split it into commands.
    if (ch === "\n" && pending.length > 0) {
      const bodyStart = i;
      let lastEnd = i;
      let cursor = i + 1;
      while (pending.length > 0 && cursor <= input.length) {
        const newline = input.indexOf("\n", cursor);
        const end = newline === -1 ? input.length : newline;
        const line = input.slice(cursor, end);
        const head = pending[0]!;
        const probe = head.stripTabs ? line.replace(/^\t+/, "") : line;
        if (probe === head.delimiter) pending.shift();
        lastEnd = end;
        if (newline === -1) break;
        cursor = newline + 1;
      }
      current += input.slice(bodyStart, lastEnd);
      i = lastEnd - 1;
      parts.push(current);
      current = "";
      continue;
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

/** Split one sub-command into tokens, respecting quotes and `$(...)` nesting. */
function tokenize(segment: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let substitution = 0;
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

    // Whitespace inside `$(...)` belongs to the substitution, so
    // `x=$(cmd a)` stays one token instead of leaking `cmd` as a command.
    if (ch === "(" && segment[i - 1] === "$") {
      substitution++;
      current += ch;
      started = true;
      continue;
    }

    if (ch === ")" && substitution > 0) {
      substitution--;
      current += ch;
      started = true;
      continue;
    }

    if (/\s/.test(ch)) {
      if (substitution > 0) {
        current += ch;
        started = true;
        continue;
      }
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

/**
 * Read redirection targets in both directions, skipping over quoted text so a
 * `<` or `>` inside a sed or awk program is not mistaken for a shell operator.
 * Heredocs carry data, not a file, and `>&2`/`<&3` duplicate a descriptor, so
 * neither yields a target. The null device is not a project file and is dropped
 * in both directions; counting it makes the gate ask to approve `/dev`.
 */
function redirectionTargets(segment: string): string[] {
  const targets: string[] = [];
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]!;

    if (quote) {
      if (ch === "\\" && quote === '"') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "\\") {
      i++;
      continue;
    }

    const output = ch === ">";
    const input = ch === "<";
    if (!output && !input) continue;

    const next = segment[i + 1];
    if (input && next === "<") {
      while (segment[i + 1] === "<") i++;
      continue;
    }
    if (next === "&") continue;

    let j = i + 1;
    while (segment[j] === ch) j++;
    while (j < segment.length && /\s/.test(segment[j]!)) j++;

    let target = "";
    if (segment[j] === '"' || segment[j] === "'") {
      const inner = segment[j]!;
      j++;
      while (j < segment.length) {
        const c = segment[j]!;
        if (c === "\\" && inner === '"') {
          target += segment[j + 1] ?? "";
          j += 2;
          continue;
        }
        if (c === inner) {
          j++;
          break;
        }
        target += c;
        j++;
      }
    } else {
      while (j < segment.length && !/[\s;&|<>]/.test(segment[j]!)) {
        target += segment[j]!;
        j++;
      }
    }

    if (target && target !== "/dev/null") targets.push(target);
    i = j - 1;
  }

  return targets;
}

/**
 * The operands of a command. Script commands can drop a flag's separate value
 * so `grep -A 25 pattern file` does not read `25` as a path. Other commands
 * keep every non-flag token, since flags like `tail -f` take no value.
 * Redirect operators and their targets are never operands.
 */
function positionalArgs(rest: string[], skipFlagValues: boolean): string[] {
  const out: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    // A bare redirect consumes the next token (a target or heredoc delimiter).
    // Attached forms such as `2>&1` or `</dev/null` are one token.
    if (REDIRECTION.test(token)) {
      if (REDIRECTION_OPERATOR.test(token)) i++;
      continue;
    }
    if (OPERATORS.has(token)) continue;
    if (isFlag(token)) {
      if (skipFlagValues && SCRIPT_FLAG_WITH_VALUE.has(token)) i++;
      continue;
    }
    out.push(token);
  }
  return out;
}

/** Resolve the directory a `cd` moves to, so later segments rebase onto it. */
function cdTarget(rest: string[], cwd: string): string | undefined {
  const operands = rest.filter((token) => !isFlag(token));
  const operand = operands.find((token) => token !== "-");
  if (operand !== undefined) return resolveUserPath(operand, cwd);
  if (operands.length === 0) return os.homedir();
  return undefined;
}

function collectPaths(segment: string, family: string, rest: string[], cwd: string): string[] {
  const paths = new Set<string>();
  const isScript = SCRIPT_COMMANDS.has(family);
  const operands = positionalArgs(rest, isScript);
  // A script command's first positional is its program. Skip it unless a flag
  // already supplied the program, in which case the positionals are all paths.
  const programAttached =
    rest.some((token) => INLINE_PROGRAM_FLAGS.some((flag) => token.startsWith(flag))) ||
    rest.some((token) => PROGRAM_FLAGS.has(token));

  let candidates: string[];
  if (PATH_COMMANDS.has(family)) {
    candidates = operands;
  } else if (isScript) {
    // The file operands read regardless of a slash, so a bare `types.ts` counts.
    candidates = programAttached ? operands : operands.slice(1);
  } else {
    candidates = operands.filter(looksLikePath);
  }

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
  // A `cd` changes the base for the rest of the line; shell state is best effort.
  let effectiveCwd = cwd;

  for (const segment of splitCommands(command)) {
    const shell = stripGroupingParens(shellText(segment));
    const tokens = tokenize(shell);

    if (tokens.length === 0) {
      if (SUBSTITUTION.test(shell)) {
        segments.push({
          patterns: [SUBSTITUTION_FAMILY],
          paths: [],
          always: [sessionAlways(SUBSTITUTION_FAMILY)],
          display: `$ ${clip(segment)}`,
        });
      }
      continue;
    }

    // A shell keyword names no program. `do` prefixes the body command, so
    // drop it and parse the rest; the others are handled as path-only.
    let words = tokens;
    while (words[0] === "do") words = words.slice(1);

    const substitution = SUBSTITUTION.test(shell);
    const indirect = INDIRECT.test(shell) || words.includes("xargs");

    if (words.length === 0 || NON_COMMAND_HEADS.has(words[0]!)) {
      const patterns: string[] = [];
      const approved: string[] = [];
      if (substitution) {
        patterns.push(SUBSTITUTION_FAMILY);
        approved.push(SUBSTITUTION_FAMILY);
      }
      if (indirect) {
        patterns.push(INDIRECT_FAMILY);
        approved.push(INDIRECT_FAMILY);
      }
      segments.push({
        patterns,
        paths: collectPaths(shell, "", words, effectiveCwd),
        always: approved.length > 0 ? [sessionAlways(...approved)] : [],
        display: `$ ${clip(segment)}`,
      });
      continue;
    }

    const { families, rest } = splitFamilies(words);
    const primary = families[families.length - 1] ?? "";

    const patterns = commandPatterns(words, families, primary, rest);
    const approved = approvalPatterns(primary, rest);

    if (substitution) {
      patterns.push(SUBSTITUTION_FAMILY);
      approved.push(SUBSTITUTION_FAMILY);
    }
    if (INDIRECT.test(shell) || families.includes("xargs")) {
      patterns.push(INDIRECT_FAMILY);
      approved.push(INDIRECT_FAMILY);
    }

    let paths: string[];
    if (primary === "cd" && !substitution) {
      const target = cdTarget(rest, effectiveCwd);
      paths = target ? [target] : [];
      if (target) effectiveCwd = target;
    } else {
      paths = collectPaths(shell, primary, rest, effectiveCwd);
    }

    segments.push({
      patterns,
      paths,
      always: approved.length > 0 ? [sessionAlways(...approved)] : [],
      display: `$ ${clip(segment)}`,
    });
  }

  return segments;
}
