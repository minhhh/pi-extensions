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

import type { PermissionRequest, PermissionRule } from "./types.ts";

export interface GrantOption {
  label: string;
  rules: PermissionRule[];
}

/** Rules a grant adds when the user picks "always" for a request. */
export function grantRules(request: PermissionRequest): PermissionRule[] {
  const seen = new Set<string>();
  const rules: PermissionRule[] = [];

  for (const raw of request.always) {
    const pattern = raw.trim();
    if (!pattern || seen.has(pattern)) continue;
    seen.add(pattern);
    rules.push({ permission: request.permission, pattern, action: "allow" });
  }

  return rules;
}

/** OpenCode's three outcomes. "always" is dropped when the request has no patterns. */
export function buildMenu(request: PermissionRequest): GrantOption[] {
  const options: GrantOption[] = [];

  const always = grantRules(request);
  if (always.length > 0) {
    options.push({ label: "Allow always (this session)", rules: always });
  }

  options.push({ label: "Deny", rules: [] });
  return options;
}

/** Compact label for a set of granted rules. */
export function describeRules(rules: readonly PermissionRule[]): string {
  return rules.map((rule) => `${rule.permission}: ${rule.pattern}`).join(", ");
}
