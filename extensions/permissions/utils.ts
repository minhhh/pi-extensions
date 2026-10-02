/**
 * Small shared helpers for the permissions extension.
 */

import { appendFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

let logFile: string | undefined;

/** Opt in with `PI_PERMISSIONS_LOG=1`. Off by default, so nothing is written. */
function loggingEnabled(): boolean {
  const value = process.env.PI_PERMISSIONS_LOG;
  return value === "1" || value === "true";
}

/** Truncate instead of growing without bound over a long session. */
const LOG_MAX_BYTES = 1 << 20;

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
 * Append one timestamped line to the permission log. Off unless
 * `PI_PERMISSIONS_LOG` is set. Callers log decisions and metadata, never the
 * arguments a call carries, so commands and file bodies stay out of the file.
 * Best effort: a failure to write must never change a permission decision.
 */
export function log(message: string, details?: unknown): void {
  if (!loggingEnabled()) return;
  const suffix = details === undefined ? "" : ` ${stringify(details)}`;
  const line = `[${new Date().toISOString()}] ${message}${suffix}\n`;
  const file = logPath();
  try {
    if (statSync(file).size > LOG_MAX_BYTES) writeFileSync(file, "");
  } catch {
    // No file yet, or the stat raced a write; append creates it.
  }
  try {
    appendFileSync(file, line);
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
