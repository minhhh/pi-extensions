/**
 * Tests that paths touched by bash and grep are evaluated under the `read`
 * permission.
 *
 * The read rules hold the `.env` protections. A command like `cat .env` names
 * no read tool, so without this the deny only applied to the read tool and bash
 * walked through it.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test, { after } from "node:test";
import { analyzeBash } from "./bash.ts";
import { BUILTIN_RULES } from "./config.ts";
import { bashRequests } from "./permission-gate.ts";
import { resolveRequest } from "./rules.ts";
import type { Decision, LoadedConfig, PermissionRule } from "./types.ts";

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "permissions-bash-read-"));
after(() => fs.rmSync(cwd, { recursive: true, force: true }));

function config(userRules: PermissionRule[] = []): LoadedConfig {
  return {
    defaultRules: [...BUILTIN_RULES],
    userRules,
    projectRules: [],
    userPath: "",
    projectPath: "",
    warnings: [],
  };
}

function decisions(command: string, loaded: LoadedConfig = config()): { permission: string; decision: Decision }[] {
  return bashRequests(analyzeBash(command, cwd), cwd).map((request) => ({
    permission: request.permission,
    decision: resolveRequest(loaded, request, []),
  }));
}

function readDecision(command: string, loaded: LoadedConfig = config()): Decision | undefined {
  return decisions(command, loaded).find((entry) => entry.permission === "read")?.decision;
}

test("cat .env is denied through the read permission", () => {
  assert.equal(readDecision("cat .env"), "deny");
});

test("a redirection into .env is denied too", () => {
  assert.equal(readDecision("echo secret > .env"), "deny");
});

test(".env.example stays allowed", () => {
  assert.equal(readDecision("cat .env.example"), "allow");
});

test("a normal file is not denied", () => {
  assert.equal(readDecision("cat notes.txt"), "allow");
  assert.equal(readDecision("head -n 5 src/core/types.ts"), "allow");
});

test("a user read deny now blocks the same path through bash", () => {
  const rules: PermissionRule[] = [{ permission: "read", pattern: "~/.ssh/*", action: "deny" }];
  const result = decisions("cat ~/.ssh/id_rsa", config(rules));

  assert.equal(result.find((entry) => entry.permission === "read")?.decision, "deny");
  assert.ok(result.some((entry) => entry.decision === "deny"), `expected a deny among ${JSON.stringify(result)}`);
});

test("paths are not evaluated under read when the tool filters them out", () => {
  // `ls` has no path operand here, so no read request is produced.
  assert.equal(decisions("ls -la").some((entry) => entry.permission === "read"), false);
});
