/**
 * Shared types for the permissions extension.
 *
 * The shape mirrors OpenCode's permission model: a flat rule list of
 * `{ permission, pattern, action }`, resolved by last match wins. Keep this a
 * leaf module so config, rules, matching, and grants can depend on it without
 * importing each other.
 */

export type Decision = "allow" | "ask" | "deny";

/** Higher wins when two decisions compete. Used for tighten-only merges. */
export const DECISION_RANK: Record<Decision, number> = { allow: 0, ask: 1, deny: 2 };

export function isDecision(value: unknown): value is Decision {
  return value === "allow" || value === "ask" || value === "deny";
}

/**
 * Permission keys the policy engine evaluates. The known set covers built-in
 * tools and the two synthetic gates; the `(string & {})` widening keeps custom
 * tool names valid so a strict union can't accidentally break them.
 */
export type Permission =
  | "read"
  | "edit"
  | "bash"
  | "list"
  | "grep"
  | "glob"
  | "doom_loop"
  | "external_directory"
  | (string & {});

/** A rule may also use `*` to match every permission. */
export type RulePermission = "*" | Permission;

/**
 * One resolved permission rule.
 *
 * `permission` is a tool key such as `bash`, `edit`, or `read`, or the `*`
 * catch-all. `pattern` is matched against the request's resource with simple
 * wildcards. `action` is what happens when the rule is the last match.
 */
export interface PermissionRule {
  permission: RulePermission;
  pattern: string;
  action: Decision;
}

/**
 * Shape check for a rule from a source the compiler cannot vouch for, such as a
 * session entry. Anything that fails is ignored rather than trusted.
 */
export function isPermissionRule(value: unknown): value is PermissionRule {
  if (!value || typeof value !== "object") return false;
  const rule = value as Record<string, unknown>;
  return typeof rule.permission === "string" && typeof rule.pattern === "string" && isDecision(rule.action);
}

/**
 * One "always" choice in a prompt.
 *
 * A request carries a list of these, and position in that list is the order the
 * prompt shows them: put the narrow choice first and the broad one after. A
 * choice can hold several patterns because approving one thing can require
 * approving another: `git push *` and `(subshell)` are granted together.
 */
export interface AlwaysOption {
  /** Patterns added as session allows when this choice is picked. */
  patterns: string[];
  /** Picker text. Callers derive one from `patterns` when it is omitted. */
  label?: string;
}

/** A single session-scoped always choice covering the given patterns. */
export function sessionAlways(...patterns: string[]): AlwaysOption {
  return { patterns: patterns.filter((pattern) => pattern.length > 0) };
}

/** One thing the model is trying to do, ready for evaluation. */
export interface PermissionRequest {
  permission: Permission;
  /**
   * Alternative spellings of one resource: absolute and `~/...`. A rule matches
   * when its pattern matches any one.
   */
  patterns: string[];
  /** Always choices in display order. Empty means the prompt offers no always. */
  always: AlwaysOption[];
  /** Human-readable summary shown in prompts and block reasons. */
  display: string;
}

export interface LoadedConfig {
  /** Built-in defaults, always present. */
  defaultRules: PermissionRule[];
  /** Parsed from the user config file. Empty when the file is absent. */
  userRules: PermissionRule[];
  /** Parsed from the project config file. May only tighten. */
  projectRules: PermissionRule[];
  userPath: string;
  projectPath: string;
  warnings: string[];
}
