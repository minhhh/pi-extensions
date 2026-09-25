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

/** One thing the model is trying to do, ready for evaluation. */
export interface PermissionRequest {
  permission: Permission;
  /**
   * Alternative spellings of one resource: absolute and `~/...`. A rule matches
   * when its pattern matches any one.
   */
  patterns: string[];
  /** Patterns added as session allows when the user picks "always". */
  always: string[];
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
