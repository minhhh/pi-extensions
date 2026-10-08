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

/** Spell a native path for a shell command without assuming a separator. */
const shell = (native: string): string => native.split(path.sep).join("/");

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

test("a symlink to .env is denied through the read permission", (t) => {
  // The deny is written against `.env`, so matching only the lexical name lets
  // `cat env-link` walk past it. The resolved spelling has to be tried too.
  const dotenv = path.join(cwd, ".env");
  const link = path.join(cwd, "env-link");
  fs.writeFileSync(dotenv, "SECRET=1");
  fs.rmSync(link, { force: true });
  try {
    fs.symlinkSync(dotenv, link);
  } catch {
    t.skip("symlinks unavailable on this platform");
    return;
  }

  assert.equal(readDecision("cat env-link"), "deny");
  assert.equal(readDecision(`cat ${shell(link)}`), "deny");
});

test("a case variant of .env is denied on a case-insensitive filesystem", (t) => {
  // On APFS and NTFS, `.ENV` reads `.env`. A case-sensitive matcher lets that
  // walk past the deny, so the matcher folds case on those volumes.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "permissions-case-"));
  try {
    fs.writeFileSync(path.join(dir, ".env"), "SECRET=1");
    if (!fs.existsSync(path.join(dir, ".ENV"))) {
      t.skip("filesystem is case-sensitive");
      return;
    }
    const request = bashRequests(analyzeBash("cat .ENV", dir), dir).find((entry) => entry.permission === "read");
    assert.ok(request, "expected a read request");
    assert.equal(resolveRequest(config(), request, []), "deny");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
