/**
 * Configuration loading.
 *
 *   <agent-dir>/permissions.json   user level, full authority
 *   <cwd>/.pi/permissions.json     project level, may only tighten
 *
 * The file uses OpenCode's `permission` shape:
 *
 *   { "permission": "allow" }
 *   { "permission": { "*": "ask", "bash": { "*": "ask", "git *": "allow" } } }
 *
 * Rules keep their written order; the last matching rule wins.
 *
 * Defaults always apply and the user file is appended after them, so a user
 * rule overrides a default with the same scope. Project rules are appended
 * after the user file but clamped to tighten-only in rules.ts.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { Decision, LoadedConfig, Permission, PermissionRule } from "./types.ts";
import { expandHome } from "./wildcard.ts";

export const CONFIG_FILENAME = "permissions.json";

/**
 * Config keys that name a different pi tool map onto OpenCode's permission
 * keys. `write` is folded into `edit`, the same way OpenCode folds
 * `write`/`patch` into `edit`.
 */
export const PERMISSION_ALIASES: Record<string, string> = {
  find: "glob",
  ls: "list",
  write: "edit",
  patch: "edit",
  apply_patch: "edit",
  powershell: "bash",
};

export function canonicalPermission(key: string): Permission {
  return PERMISSION_ALIASES[key] ?? key;
}

/**
 * OpenCode's defaults, plus a few safety rails of our own.
 *
 * Everything allows. `doom_loop` and `external_directory` ask. Reading a
 * `.env` file is denied while `.env.example` stays readable. Editing inside
 * `.git` or `.ssh` is denied. The defaults merge with user rules, so any of
 * them can be overridden by writing a later rule for the same scope.
 */
export const BUILTIN_RULES: readonly PermissionRule[] = [
  { permission: "*", pattern: "*", action: "allow" },
  { permission: "doom_loop", pattern: "*", action: "ask" },
  { permission: "external_directory", pattern: "*", action: "ask" },
  { permission: "read", pattern: "*.env", action: "deny" },
  { permission: "read", pattern: "*.env.*", action: "deny" },
  { permission: "read", pattern: "*.env.example", action: "allow" },
  { permission: "bash", pattern: "rm *", action: "ask" },
  { permission: "bash", pattern: "rmdir *", action: "ask" },
  { permission: "bash", pattern: "shred *", action: "ask" },
  { permission: "bash", pattern: "dd *", action: "ask" },
  { permission: "bash", pattern: "truncate *", action: "ask" },
  { permission: "bash", pattern: "mkfs *", action: "ask" },
  { permission: "bash", pattern: "sudo *", action: "ask" },
  { permission: "bash", pattern: "doas *", action: "ask" },
  { permission: "bash", pattern: "(subshell)", action: "ask" },
  { permission: "bash", pattern: "(indirect)", action: "ask" },
  { permission: "edit", pattern: ".git", action: "deny" },
  { permission: "edit", pattern: ".git/*", action: "deny" },
  { permission: "edit", pattern: "**/.git", action: "deny" },
  { permission: "edit", pattern: "**/.git/*", action: "deny" },
  { permission: "edit", pattern: ".ssh", action: "deny" },
  { permission: "edit", pattern: ".ssh/*", action: "deny" },
  { permission: "edit", pattern: "**/.ssh", action: "deny" },
  { permission: "edit", pattern: "**/.ssh/*", action: "deny" },
];

type PermissionValue = Decision | Record<string, Decision | Record<string, Decision>>;

function isDecision(value: unknown): value is Decision {
  return value === "allow" || value === "ask" || value === "deny";
}

/**
 * Turn a permission value into an ordered rule list. Key order and pattern
 * order are both preserved because the last match wins.
 */
function rulesFromPermission(value: PermissionValue, file: string, warnings: string[]): PermissionRule[] {
  if (isDecision(value)) return [{ permission: "*", pattern: "*", action: value }];

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    warnings.push(`${file}: "permission" must be a string or an object`);
    return [];
  }

  const rules: PermissionRule[] = [];
  for (const [rawKey, entry] of Object.entries(value)) {
    const permission = canonicalPermission(rawKey);

    if (isDecision(entry)) {
      rules.push({ permission, pattern: "*", action: entry });
      continue;
    }

    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      warnings.push(`${file}: permission "${rawKey}" must be a string or an object of patterns`);
      continue;
    }

    for (const [rawPattern, action] of Object.entries(entry)) {
      if (!isDecision(action)) {
        warnings.push(`${file}: permission "${rawKey}" pattern "${rawPattern}" has no valid action`);
        continue;
      }
      rules.push({ permission, pattern: expandHome(rawPattern), action });
    }
  }

  return rules;
}

function readConfigFile(file: string, warnings: string[]): PermissionRule[] | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    warnings.push(`${file}: ${error instanceof Error ? error.message : "invalid JSON"}`);
    return undefined;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    warnings.push(`${file}: expected a JSON object`);
    return undefined;
  }

  const object = parsed as Record<string, unknown>;

  if (object.permission === undefined) {
    warnings.push(`${file}: expected an object with a "permission" key`);
    return [];
  }

  return rulesFromPermission(object.permission as PermissionValue, file, warnings);
}

export function loadConfig(cwd: string): LoadedConfig {
  const warnings: string[] = [];
  const userPath = path.join(getAgentDir(), CONFIG_FILENAME);
  const projectPath = path.join(cwd, CONFIG_DIR_NAME, CONFIG_FILENAME);

  const userFile = readConfigFile(userPath, warnings);
  const projectFile = readConfigFile(projectPath, warnings);

  return {
    defaultRules: [...BUILTIN_RULES],
    userRules: userFile ?? [],
    projectRules: projectFile ?? [],
    userPath,
    projectPath,
    warnings,
  };
}
