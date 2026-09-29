/**
 * Session grants.
 *
 * A grant is a rule the user approved with "always" and lasts for the rest of
 * the session. It is stored as a session entry, so it follows branch
 * navigation when you fork and disappears when the session ends.
 *
 * A grant can only turn an ask into an allow. It cannot lift a config deny.
 * That short-circuit lives in rules.ts.
 */

import type { AlwaysOption, Permission, PermissionRequest, PermissionRule } from "./types.ts";

export interface GrantOption {
  label: string;
  rules: PermissionRule[];
}

/** Rules one always choice adds for a request. */
export function grantRules(permission: Permission, option: AlwaysOption): PermissionRule[] {
  const seen = new Set<string>();
  const rules: PermissionRule[] = [];

  for (const raw of option.patterns) {
    const pattern = raw.trim();
    if (!pattern || seen.has(pattern)) continue;
    seen.add(pattern);
    rules.push({ permission, pattern, action: "allow" });
  }

  return rules;
}

/**
 * Prompt choices for a request: one per always option, in order, then Deny.
 * `label` renders an option's rules, since only the caller knows how to show a
 * permission. Labels are kept unique so the selected label maps back to one
 * option.
 */
export function buildMenu(
  request: PermissionRequest,
  label: (rules: readonly PermissionRule[]) => string,
): GrantOption[] {
  const options: GrantOption[] = [];
  const used = new Set<string>();

  for (const option of request.always) {
    const rules = grantRules(request.permission, option);
    if (rules.length === 0) continue;
    let text = option.label ?? label(rules);
    while (used.has(text)) text = `${text} `;
    used.add(text);
    options.push({ label: text, rules });
  }

  options.push({ label: "Deny", rules: [] });
  return options;
}

/** Compact label for a set of granted rules. */
export function describeRules(rules: readonly PermissionRule[]): string {
  return rules.map((rule) => `${rule.permission}: ${rule.pattern}`).join(", ");
}
