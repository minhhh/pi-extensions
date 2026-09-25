/**
 * Small shared helpers for the permissions extension.
 */

import { appendFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

let logFile: string | undefined;

/** Flip this to true to start appending to `<agent-dir>/permissions.log`. */
const LOG_ENABLED = true;

/** `<agent-dir>/permissions.log`, resolved lazily so tests can redirect it. */
export function logPath(): string {
  logFile ??= join(getAgentDir(), "permissions.log");
  return logFile;
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Append one timestamped line to the permission log. Best effort: a failure to
 * write must never change a permission decision.
 */
export function log(message: string, details?: unknown): void {
  if (!LOG_ENABLED) return;
  const suffix = details === undefined ? "" : ` ${stringify(details)}`;
  const line = `[${new Date().toISOString()}] ${message}${suffix}\n`;
  try {
    appendFileSync(logPath(), line);
  } catch {
    // Ignore logging errors.
  }
}


export function template(
       strings: TemplateStringsArray,
       ...keys: (number | string)[]
     ): (...values: unknown[]) => string {
       return (...values) => {
         const dict = (values[values.length - 1] ?? {}) as Record<string, unknown>;
         const result: unknown[] = [strings[0]];
         keys.forEach((key, i) => {
           const value = typeof key === "number" ? values[key] : dict[key];
           result.push(value, strings[i + 1]);
         });
         return result.join("");
       };
}
