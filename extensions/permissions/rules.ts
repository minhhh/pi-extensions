/**
 * Rule evaluation.
 *
 * Resolution is order-based, like OpenCode: the last rule that matches the
 * permission key and the resource wins. Defaults come first, then the user
 * file, then matching session grants. A project file is appended after the
 * user result but may only tighten it.
 *
 * A single resource can have several spellings: an absolute path and a `~/...`
 * form. They are alternatives, not separate resources, so a rule matches when
 * its pattern matches any spelling. Resolving each spelling on its own would
 * let a catch-all rule that misses one spelling outvote a specific rule that
 * hits another.
 *
 * The tighten-only clamp for project rules is the one deliberate deviation.
 * A repository should be able to add a deny, not lift one the user set.
 */

import { DECISION_RANK, type Decision, type LoadedConfig, type Permission, type PermissionRequest, type PermissionRule } from "./types.ts";
import { wildcardMatch } from "./wildcard.ts";

export function ruleMatches(rule: PermissionRule, permission: Permission, patterns: readonly string[]): boolean {
  if (!wildcardMatch(permission, rule.permission)) return false;
  return patterns.some((pattern) => wildcardMatch(pattern, rule.pattern));
}

/** Last rule that matches across the given rule lists, or undefined. */
export function findLastRule(
  rulesets: readonly (readonly PermissionRule[])[],
  permission: Permission,
  patterns: readonly string[],
): PermissionRule | undefined {
  let found: PermissionRule | undefined;
  for (const ruleset of rulesets) {
    for (const rule of ruleset) {
      if (ruleMatches(rule, permission, patterns)) found = rule;
    }
  }
  return found;
}

export function evaluate(
  permission: Permission,
  patterns: readonly string[],
  rulesets: readonly (readonly PermissionRule[])[],
  fallback: Decision = "ask",
): Decision {
  return findLastRule(rulesets, permission, patterns)?.action ?? fallback;
}

/**
 * Decision for one permission.
 *
 * Config is resolved first and a config deny is final. Then project rules may
 * tighten the result. Only when the result is still `ask` does an approved
 * session grant get a chance to raise it to `allow`. That ordering is what
 * keeps a config deny absolute: approving a broad `read *` for the session
 * cannot open a `.env` that the config denies.
 */
export function resolveOne(
  config: LoadedConfig,
  permission: Permission,
  patterns: readonly string[],
  approved: readonly PermissionRule[],
): Decision {
  const configured = evaluate(permission, patterns, [config.defaultRules, config.userRules]);
  if (configured === "deny") return "deny";

  const projectRule = findLastRule([config.projectRules], permission, patterns);
  const base =
    projectRule && DECISION_RANK[projectRule.action] > DECISION_RANK[configured]
      ? projectRule.action
      : configured;

  if (base !== "ask") return base;

  const grant = findLastRule([approved], permission, patterns);
  return grant?.action === "allow" ? "allow" : "ask";
}

export function resolveRequest(
  config: LoadedConfig,
  request: PermissionRequest,
  approved: readonly PermissionRule[],
): Decision {
  return resolveOne(config, request.permission, request.patterns, approved);
}

/** Rules that mention a permission key. Used by /permissions to explain a decision. */
export function rulesForPermission(rules: readonly PermissionRule[], permission: string): PermissionRule[] {
  return rules.filter((rule) => wildcardMatch(permission, rule.permission));
}

export function describeRule(rule: PermissionRule): string {
  return `${rule.permission} ${rule.pattern} -> ${rule.action}`;
}
