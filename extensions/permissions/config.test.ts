/**
 * Tests for config loading.
 *
 * The important contract: an absent file is normal, a malformed file warns,
 * and a file that exists but cannot be read throws. The last one fails closed:
 * the gate blocks rather than silently dropping the rules the file held.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test, { after } from "node:test";
import { BUILTIN_RULES, loadConfig } from "./config.ts";
import { resolveOne } from "./rules.ts";
import type { LoadedConfig } from "./types.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "permissions-config-"));
const cwd = path.join(tmp, "cwd");
const agentDir = path.join(tmp, "agent");
fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
fs.mkdirSync(agentDir, { recursive: true });

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;

after(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const projectFile = path.join(cwd, ".pi", "permissions.json");
const userFile = path.join(agentDir, "permissions.json");

test("absent config files are not an error", () => {
  const config = loadConfig(cwd);
  assert.deepEqual(config.warnings, []);
  assert.deepEqual(config.userRules, []);
  assert.deepEqual(config.projectRules, []);
  assert.ok(config.defaultRules.length > 0);
  assert.equal(config.userPath, userFile);
  assert.equal(config.projectPath, projectFile);
});

test("the user config is read from the agent dir", () => {
  fs.writeFileSync(userFile, JSON.stringify({ permission: { bash: { "git *": "deny" } } }));
  try {
    const config = loadConfig(cwd);
    assert.deepEqual(config.userRules, [{ permission: "bash", pattern: "git *", action: "deny" }]);
  } finally {
    fs.rmSync(userFile, { force: true });
  }
});

test("a malformed config warns instead of throwing", () => {
  fs.writeFileSync(projectFile, "{ not json");
  try {
    const config = loadConfig(cwd);
    assert.equal(config.warnings.length, 1);
    assert.match(config.warnings[0]!, /permissions\.json/);
  } finally {
    fs.rmSync(projectFile, { force: true });
  }
});

test("an unreadable config throws instead of dropping rules silently", () => {
  // A directory where the file should be makes readFileSync fail with EISDIR,
  // which is exactly the class of error that used to be swallowed.
  fs.mkdirSync(projectFile, { recursive: true });
  try {
    assert.throws(() => loadConfig(cwd), /permissions: cannot read .*permissions\.json/);
  } finally {
    fs.rmSync(projectFile, { recursive: true, force: true });
  }
});

test("builtin edit denies cover .git and .ssh, absolute and relative", () => {
  const config: LoadedConfig = {
    defaultRules: [...BUILTIN_RULES],
    userRules: [],
    projectRules: [],
    userPath: "",
    projectPath: "",
    warnings: [],
  };
  const edit = (pattern: string) => resolveOne(config, "edit", [pattern], []);

  // Absolute spellings are what requests carry; the relative ones need the
  // anchored `*/.git`-style rules, since `**/` requires a literal slash.
  assert.equal(edit("/p/sub/.git"), "deny");
  assert.equal(edit("/p/sub/.git/config"), "deny");
  assert.equal(edit(".git/config"), "deny");
  assert.equal(edit("/home/u/.ssh/id_ed25519"), "deny");
  assert.equal(edit(".ssh/id_ed25519"), "deny");

  // Neighbours with the same name prefix stay editable.
  assert.equal(edit("/p/.github/workflows/ci.yml"), "allow");
  assert.equal(edit("/p/.gitignore"), "allow");
  assert.equal(edit("/p/.git2/file"), "allow");
});
