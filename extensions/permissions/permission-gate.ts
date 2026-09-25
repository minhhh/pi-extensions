/**
 * Permissions extension.
 *
 * Decides, for every tool call the model makes and every `!` command you type,
 * whether the action runs, prompts you, or is blocked. The model follows
 * OpenCode's permission rules:
 *
 *   - rules are `{ permission, pattern, action }`
 *   - the last matching rule wins
 *   - `allow` runs, `ask` prompts, `deny` blocks
 *   - defaults allow everything except `doom_loop` and `external_directory`,
 *     which ask, plus a few safety rails (`.env` reads, `.git`/`.ssh` edits,
 *     destructive shell commands)
 *
 * On top of that, a config deny is absolute. Session grants can only raise an
 * ask to an allow, and `--auto` turns any unanswered ask into an allow without
 * touching denies.
 *
 * Grants live in session entries, so they vanish when the session ends and
 * follow branch navigation when you fork.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { analyzeBash, resolveUserPath, type BashSegment } from "./bash.ts";
import { canonicalPermission, loadConfig } from "./config.ts";
import { buildMenu, describeRules } from "./grants.ts";
import { describeRule, resolveRequest, rulesForPermission } from "./rules.ts";
import type { Decision, LoadedConfig, PermissionRequest, PermissionRule, RulePermission } from "./types.ts";
import { log, logPath, template } from "./utils.ts";
import { isExternal, pathPatterns } from "./wildcard.ts";
import { coalesceAsks, mergeExternal } from "./requests.ts";

const AUTO_FLAG = "auto";
const GRANT_ENTRY = "permissions-rule";
const CLEAR_ENTRY = "permissions-clear";
const DOOM_THRESHOLD = 3;

/** Input fields that name the resource a custom tool acts on. */
const RESOURCE_FIELDS = ["command", "path", "filePath", "url", "query", "pattern", "name", "subagent_type", "skill"];

const REQUEST_EXTERNAL_TEMPLATE = template`⚠ Permission required\n${0}\n\nPatterns\n\n${1}\n`;
const REQUEST_TOOL_TEMPLATE = template`⚠ Permission required\n${0}`;
const ALLOW_EXTERNAL_TEMPLATE = template`\nThis will allow the following patterns until Pi is restarted\n\n${0}`;
const ALLOW_TOOL_TEMPLATE = template`\nThis will allow the following until Pi is restarted\n\n${0}`;

type PermissionDisplayType = "external" | "tool";

export default function permissionsExtension(pi: ExtensionAPI): void {
  let approved: PermissionRule[] = [];
  let config: LoadedConfig | undefined;
  let configCwd: string | undefined;
  let lastSignature: string | undefined;
  let repeatCount = 0;

  pi.registerFlag(AUTO_FLAG, {
    description: "Automatically approve permission asks. Explicit deny rules still apply.",
    type: "boolean",
    default: false,
  });

  const auto = (): boolean => pi.getFlag(AUTO_FLAG) === true;

  const activeConfig = (ctx: ExtensionContext): LoadedConfig => {
    if (!config || configCwd !== ctx.cwd) {
      config = loadConfig(ctx.cwd);
      configCwd = ctx.cwd;
      for (const warning of config.warnings) {
        log("config warning", { cwd: ctx.cwd, warning });
        if (ctx.hasUI) ctx.ui.notify(`permissions: ${warning}`, "warning");
      }
    }
    return config;
  };

  const reconstruct = (ctx: ExtensionContext): void => {
    approved = [];
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom") continue;
      const custom = entry as { customType?: string; data?: unknown };
      if (custom.customType === CLEAR_ENTRY) {
        approved = [];
        continue;
      }
      if (custom.customType === GRANT_ENTRY) approved.push(custom.data as PermissionRule);
    }
  };

  /** Prompt with Pi's outcomes: once, always, reject. */
  const confirm = async (request: PermissionRequest, ctx: ExtensionContext): Promise<boolean> => {
    const options = buildMenu(request);
    const labels = ["Allow once", ...options.map((option) => option.label)];

    const choice = await ctx.ui.select(requestText(request), labels);

    if (choice === undefined) {
      return false;
    }
    if (choice === "Allow once") {
      return true;
    }

    const picked = options.find((option) => option.label === choice);
    if (!picked || picked.rules.length === 0) return false;

    const confirmed = await ctx.ui.confirm("⚠ Always allow", allowText(picked.rules));
    if (!confirmed) return false;

    for (const rule of picked.rules) {
      pi.appendEntry(GRANT_ENTRY, rule);
      approved.push(rule);
    }
    log("grant", { rules: picked.rules, cwd: ctx.cwd });
    ctx.ui.notify(`Granted for this session: ${describeRules(picked.rules)}`, "info");
    return true;
  };

  const decide = (request: PermissionRequest, ctx: ExtensionContext): Decision => {
    const decision = resolveRequest(activeConfig(ctx), request, approved);
    if (decision === "ask" && auto()) return "allow";
    return decision;
  };

  /**
   * Decide every request first, then prompt once per permission for the asks.
   * Decisions stay independent per request, so an allow for one command never
   * covers another; deny still blocks before any prompt.
   */
  const runRequests = async (
    requests: readonly PermissionRequest[],
    ctx: ExtensionContext,
  ): Promise<{ blocked: boolean; reason?: string }> => {
    log("runRequests", requests);
    const asks: PermissionRequest[] = [];
    for (const request of requests) {
      const decision = decide(request, ctx);
      log("decision", { permission: request.permission, patterns: request.patterns, decision });
      if (decision === "allow") continue;
      if (decision === "deny") {
        return { blocked: true, reason: `Blocked by permissions: ${request.display}` };
      }
      asks.push(request);
    }

    for (const request of coalesceAsks(asks)) {
      if (!ctx.hasUI) {
        return { blocked: true, reason: `Permission required for ${request.display} but no UI is available.` };
      }
      if (!(await confirm(request, ctx))) {
        return { blocked: true, reason: `Denied by user: ${request.display}` };
      }
      if (request.permission === "doom_loop") repeatCount = 0;
    }
    return { blocked: false };
  };

  const doomRequest = (event: ToolCallEvent): PermissionRequest | undefined => {
    const signature = `${event.toolName}\u0000${stableStringify(event.input)}`;
    if (signature === lastSignature) repeatCount += 1;
    else {
      lastSignature = signature;
      repeatCount = 1;
    }
    if (repeatCount < DOOM_THRESHOLD) return undefined;
    log("doom_loop", { tool: event.toolName, input: event.input });
    return {
      permission: "doom_loop",
      patterns: ["*"],
      always: [],
      display: `doom loop: ${event.toolName} called ${DOOM_THRESHOLD} times with identical input`,
    };
  };

  pi.on("tool_call", async (event, ctx) => {
    const requests = requestsForToolCall(event, ctx.cwd);
    const doom = doomRequest(event);
    const result = await runRequests(doom ? [doom, ...requests] : requests, ctx);
    if (!result.blocked) return undefined;
    return { block: true, reason: result.reason };
  });

  pi.on("user_bash", async (event, ctx) => {
    const requests = bashRequests(analyzeBash(event.command, event.cwd), event.cwd);

    const result = await runRequests(requests, ctx);
    if (!result.blocked) return undefined;
    return { result: blocked(result.reason ?? "Blocked by permissions") };
  });

  pi.registerCommand("permissions", {
    description: "List permissions, explain a decision, or clear session grants",
    handler: async (args, ctx) => {
      const loaded = activeConfig(ctx);
      const trimmed = args.trim();
      const space = trimmed.indexOf(" ");
      const action = space === -1 ? trimmed : trimmed.slice(0, space);
      const rest = space === -1 ? "" : trimmed.slice(space + 1).trim();

      if (action === "clear") {
        approved = [];
        pi.appendEntry(CLEAR_ENTRY, {});
        ctx.ui.notify("Cleared session permission grants", "info");
        return;
      }

      if (action === "check" && rest) {
        const parts = rest.split(/\s+/);
        const key = canonicalPermission(parts[0] ?? "");
        const resource = stripQuotes(parts.slice(1).join(" ")) || "*";
        const request: PermissionRequest = { permission: key, patterns: [resource], always: [], display: key };
        const lines = [
          `${key} ${resource} -> ${decide(request, ctx)}`,
          ...rulesForPermission(
            [...loaded.defaultRules, ...loaded.userRules, ...loaded.projectRules, ...approved],
            key,
          ).map((rule) => `  ${describeRule(rule)}`),
        ];
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      const lines = [
        `user: ${loaded.userPath}`,
        `project: ${loaded.projectPath}`,
        `log: ${logPath()}`,
        `auto: ${auto() ? "on" : "off"}`,
        `grants: ${approved.length === 0 ? "none" : ""}`,
        ...approved.map((rule) => `  ${describeRule(rule)}`),
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    activeConfig(ctx);
    reconstruct(ctx);
    lastSignature = undefined;
    repeatCount = 0;
  });
  pi.on("session_tree", async (_event, ctx) => reconstruct(ctx));
}

function blocked(output: string): { output: string; exitCode: number; cancelled: boolean; truncated: boolean } {
  return { output, exitCode: 1, cancelled: false, truncated: false };
}

function stripQuotes(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function permissionDisplay(permission: RulePermission): PermissionDisplayType {
  return permission === "external_directory" ? "external" : "tool";
}

function requestText(request: PermissionRequest): string {
  switch (permissionDisplay(request.permission)) {
    case "external":
      return REQUEST_EXTERNAL_TEMPLATE(request.display, patternLine(request));
    case "tool":
      return REQUEST_TOOL_TEMPLATE(request.display);
  }
}

function allowText(rules: readonly PermissionRule[]): string {
  const display = permissionDisplay(rules[0]!.permission);
  const lines = rules.map((rule) => `- ${rulePattern(rule, display)}`).join("\n");
  switch (display) {
    case "external":
      return ALLOW_EXTERNAL_TEMPLATE(lines);
    case "tool":
      return ALLOW_TOOL_TEMPLATE(lines);
  }
}

function rulePattern(rule: PermissionRule, display: PermissionDisplayType): string {
  if (display === "external") return `${rule.pattern}/*`;
  if (rule.pattern === "*") return `${rule.permission} *`;
  return rule.pattern;
}

function patternLine(request: PermissionRequest): string {
  return request.always.map((folder) => `- ${folder}/*`).join("\n");
}

function addExternalFolder(requests: PermissionRequest[], abs: string, display: string, cwd: string): void {
  if (!isExternal(abs, cwd)) return;
  const folder = folderFor(abs);
  requests.push({
    permission: "external_directory",
    patterns: pathPatterns(folder),
    always: [folder],
    display: `  ← Access external directory ${folder}`,
  });
}

function bashRequests(segments: readonly BashSegment[], cwd: string): PermissionRequest[] {
  const external: PermissionRequest[] = [];
  const requests: PermissionRequest[] = [];
  for (const segment of segments) {
    for (const path of segment.paths) addExternalFolder(external, path, path, cwd);
    requests.push({
      permission: "bash",
      patterns: segment.patterns,
      always: segment.always,
      display: segment.display,
    });
  }
  return [...mergeExternal(external), ...requests];
}

function folderFor(abs: string): string {
  try {
    if (fs.statSync(abs).isDirectory()) return abs;
  } catch {
    // Path does not exist; treat as a file about to be created.
  }
  return path.dirname(abs);
}

function pathRequest(permission: string, name: string, raw: string, cwd: string, external: PermissionRequest[]): PermissionRequest {
  const abs = resolveUserPath(raw, cwd);
  addExternalFolder(external, abs, raw, cwd);
  return { permission, patterns: pathPatterns(abs), always: ["*"], display: `${name} ${raw}` };
}

function resourceField(input: Record<string, unknown>): string | undefined {
  for (const field of RESOURCE_FIELDS) {
    const value = input[field];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

/**
 * Map a tool call to the requests the policy engine evaluates. A bash call can
 * produce several requests, one per segment plus the external directory gate,
 * and the most restrictive result wins.
 */
function requestsForToolCall(event: ToolCallEvent, cwd: string): PermissionRequest[] {
  const input = event.input as unknown as Record<string, unknown>;
  const external: PermissionRequest[] = [];

  log("requestsForToolCall", event)

  if (event.toolName === "bash" || event.toolName === "powershell") {
    const command = typeof input.command === "string" ? input.command : "";
    return bashRequests(analyzeBash(command, cwd), cwd);
  }

  const rawPath = typeof input.path === "string" ? input.path : typeof input.filePath === "string" ? input.filePath : undefined;

  switch (event.toolName) {
    case "read": {
      if (!rawPath) return generic(event, input, cwd);
      const request = pathRequest("read", "read", rawPath, cwd, external);
      return [...external, request];
    }
    case "write":
    case "edit": {
      if (!rawPath) return generic(event, input, cwd);
      const request = pathRequest("edit", event.toolName, rawPath, cwd, external);
      return [...external, request];
    }
    case "ls": {
      if (!rawPath) return generic(event, input, cwd);
      const request = pathRequest("list", "ls", rawPath, cwd, external);
      return [...external, request];
    }
    case "grep":
    case "find": {
      const pattern = typeof input.pattern === "string" ? input.pattern : "*";
      if (rawPath) addExternalFolder(external, resolveUserPath(rawPath, cwd), rawPath, cwd);
      const permission = event.toolName === "grep" ? "grep" : "glob";
      return [
        ...external,
        { permission, patterns: [pattern], always: ["*"], display: `${event.toolName} ${pattern}` },
      ];
    }
    default:
      return generic(event, input, cwd);
  }
}

function generic(event: ToolCallEvent, input: Record<string, unknown>, cwd: string): PermissionRequest[] {
  const permission = canonicalPermission(event.toolName);
  const resource = resourceField(input) ?? "*";
  const external: PermissionRequest[] = [];

  if (typeof input.path === "string") addExternalFolder(external, resolveUserPath(input.path, cwd), input.path, cwd);
  if (typeof input.filePath === "string") addExternalFolder(external, resolveUserPath(input.filePath, cwd), input.filePath, cwd);

  return [
    { permission, patterns: [resource], always: ["*"], display: `${event.toolName} ${resource}` },
    ...mergeExternal(external),
  ];
}

/** JSON with sorted keys so identical inputs hash to the same signature. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`).join(",")}}`;
}
