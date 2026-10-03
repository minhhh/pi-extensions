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
import { isToolCallEventType, type ExtensionAPI, type ExtensionContext, type ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { analyzeBash, matchableSegments, resolveUserPath, type BashSegment } from "./bash.ts";
import { canonicalPermission, loadConfig } from "./config.ts";
import { buildMenu, describeRules } from "./grants.ts";
import { describeRule, resolveRequest, rulesForPermission } from "./rules.ts";
import { isPermissionRule, sessionAlways, type Decision, type LoadedConfig, type PermissionRequest, type PermissionRule, type RulePermission } from "./types.ts";
import { log, logPath, template } from "./utils.ts";
import { canonicalize, isExternal, pathPatterns } from "./wildcard.ts";
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
    approved = grantsFromEntries(ctx.sessionManager.getBranch());
  };

  /** Prompt with Pi's outcomes: once, one choice per always option, reject. */
  const confirm = async (request: PermissionRequest, ctx: ExtensionContext): Promise<boolean> => {
    const options = buildMenu(request, alwaysLabel);
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
    log("runRequests", { count: requests.length, permissions: [...new Set(requests.map((r) => r.permission))] });
    const asks: PermissionRequest[] = [];
    for (const request of requests) {
      const decision = decide(request, ctx);
      log("decision", { permission: request.permission, decision });
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
    log("doom_loop", { tool: event.toolName, repeatCount });
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

/**
 * Rules a session branch grants, in order. A `permissions-clear` entry resets
 * the list. An entry whose payload is not a rule is ignored rather than
 * trusted, so a hand-edited session file cannot inject a grant.
 */
export function grantsFromEntries(entries: readonly unknown[]): PermissionRule[] {
  const rules: PermissionRule[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const custom = entry as { type?: string; customType?: string; data?: unknown };
    if (custom.type !== "custom") continue;
    if (custom.customType === CLEAR_ENTRY) {
      rules.length = 0;
      continue;
    }
    if (custom.customType === GRANT_ENTRY && isPermissionRule(custom.data)) rules.push(custom.data);
  }
  return rules;
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

/** One-line picker text for an always choice, e.g. `Allow always: git push *`. */
function alwaysLabel(rules: readonly PermissionRule[]): string {
  const display = permissionDisplay(rules[0]!.permission);
  return `Allow always: ${rules.map((rule) => rulePattern(rule, display)).join(", ")}`;
}

function rulePattern(rule: PermissionRule, display: PermissionDisplayType): string {
  if (display === "external") return `${rule.pattern}/*`;
  if (rule.pattern === "*") return `${rule.permission} *`;
  return rule.pattern;
}

function patternLine(request: PermissionRequest): string {
  return request.always
    .flatMap((option) => option.patterns)
    .map((folder) => `- ${folder}/*`)
    .join("\n");
}

/**
 * Add an `external_directory` request for a touched path, or nothing when it
 * sits inside the cwd. Patterns use the canonical absolute folder, with
 * symlinks resolved, so a grant names the real location instead of a link to
 * it and never a relative path.
 */
export function addExternalFolder(requests: PermissionRequest[], abs: string, cwd: string): void {
  if (!isExternal(abs, cwd)) return;
  const folder = folderFor(canonicalize(abs));
  requests.push({
    permission: "external_directory",
    patterns: pathPatterns(folder),
    always: [sessionAlways(folder)],
    display: `  ← Access external directory ${folder}`,
  });
}

/**
 * A `read` request for a path another tool touches. The `read` rules carry the
 * `.env` protections, so evaluating a bash or grep path here is what stops
 * `cat .env` from slipping past a rule written for the read tool. A limit
 * remains: a grep with no explicit path searches the tree itself, so only the
 * grep tool's own ignore rules keep it out of a `.env` sitting in the cwd.
 */
function readRequest(abs: string, display: string): PermissionRequest {
  return {
    permission: "read",
    patterns: pathPatterns(abs),
    always: [],
    display,
  };
}

export function bashRequests(segments: readonly BashSegment[], cwd: string): PermissionRequest[] {
  const external: PermissionRequest[] = [];
  const reads: PermissionRequest[] = [];
  const requests: PermissionRequest[] = [];
  const seen = new Set<string>();
  for (const segment of segments) {
    for (const path of segment.paths) {
      addExternalFolder(external, path, cwd);
      if (seen.has(path)) continue;
      seen.add(path);
      reads.push(readRequest(path, `  ← Read ${path}`));
    }
  }
  for (const segment of matchableSegments(segments)) {
    requests.push({
      permission: "bash",
      patterns: segment.patterns,
      always: segment.always,
      display: segment.display,
    });
  }
  return [...mergeExternal(external), ...reads, ...requests];
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
  addExternalFolder(external, abs, cwd);
  return { permission, patterns: pathPatterns(abs), always: [sessionAlways("*")], display: `${name} ${raw}` };
}

function resourceField(input: Record<string, unknown>): string | undefined {
  for (const field of RESOURCE_FIELDS) {
    const value = input[field];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

/**
 * Read a string field off a tool input. The schema types it as a string, but a
 * sibling `tool_call` handler can mutate `event.input` in place and the SDK
 * does not re-validate, so the runtime shape is not guaranteed by the type.
 */
function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Map a tool call to the requests the policy engine evaluates. A bash call can
 * produce several requests, one per segment plus the external directory gate,
 * and the most restrictive result wins.
 */
function requestsForToolCall(event: ToolCallEvent, cwd: string): PermissionRequest[] {
  const external: PermissionRequest[] = [];

  log("requestsForToolCall", { tool: event.toolName, toolCallId: event.toolCallId });

  // Narrow with the SDK guard, not a `switch` on `event.toolName`. The guard
  // narrows `event.input` to each tool's schema, so a renamed field is a
  // compile error instead of a silent fall-through to `generic` with an
  // undefined resource.
  if (isToolCallEventType("bash", event) || isToolCallEventType("powershell", event)) {
    return bashRequests(analyzeBash(stringField(event.input.command) ?? "", cwd), cwd);
  }

  if (isToolCallEventType("read", event)) {
    const rawPath = stringField(event.input.path);
    if (!rawPath) return generic(event, event.input, cwd);
    return [...external, pathRequest("read", "read", rawPath, cwd, external)];
  }

  if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
    const rawPath = stringField(event.input.path);
    if (!rawPath) return generic(event, event.input, cwd);
    return [...external, pathRequest("edit", event.toolName, rawPath, cwd, external)];
  }

  if (isToolCallEventType("ls", event)) {
    const rawPath = stringField(event.input.path);
    if (!rawPath) return generic(event, event.input, cwd);
    return [...external, pathRequest("list", "ls", rawPath, cwd, external)];
  }

  if (isToolCallEventType("grep", event) || isToolCallEventType("find", event)) {
    const pattern = stringField(event.input.pattern) ?? "*";
    const rawPath = stringField(event.input.path);
    const permission = event.toolName === "grep" ? "grep" : "glob";
    if (rawPath) {
      const abs = resolveUserPath(rawPath, cwd);
      addExternalFolder(external, abs, cwd);
      external.push(readRequest(abs, `  ← Read ${rawPath}`));
    }
    return [
      ...external,
      { permission, patterns: [pattern], always: [sessionAlways("*")], display: `${event.toolName} ${pattern}` },
    ];
  }

  return generic(event, event.input, cwd);
}

function generic(event: ToolCallEvent, input: Record<string, unknown>, cwd: string): PermissionRequest[] {
  const permission = canonicalPermission(event.toolName);
  const resource = resourceField(input) ?? "*";
  const external: PermissionRequest[] = [];

  if (typeof input.path === "string") addExternalFolder(external, resolveUserPath(input.path, cwd), cwd);
  if (typeof input.filePath === "string") addExternalFolder(external, resolveUserPath(input.filePath, cwd), cwd);

  return [
    { permission, patterns: [resource], always: [sessionAlways("*")], display: `${event.toolName} ${resource}` },
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
