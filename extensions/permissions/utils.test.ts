/**
 * Tests for the permission log.
 *
 * The log is off unless the env var opts in, and it is capped so a long session
 * cannot grow the file without bound.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test, { after } from "node:test";
import { log, logPath } from "./utils.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "permissions-utils-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousLogFlag = process.env.PI_PERMISSIONS_LOG;
process.env.PI_CODING_AGENT_DIR = dir;
delete process.env.PI_PERMISSIONS_LOG;

after(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  if (previousLogFlag === undefined) delete process.env.PI_PERMISSIONS_LOG;
  else process.env.PI_PERMISSIONS_LOG = previousLogFlag;
  fs.rmSync(dir, { recursive: true, force: true });
});

function readLog(): string {
  const file = logPath();
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}

test("logging is off unless the env var is set", () => {
  delete process.env.PI_PERMISSIONS_LOG;
  log("decision", { permission: "bash", decision: "allow" });
  assert.equal(fs.existsSync(logPath()), false);
});

test("setting the env var turns logging on", () => {
  process.env.PI_PERMISSIONS_LOG = "1";
  log("decision", { permission: "bash", decision: "allow" });

  const content = readLog();
  assert.match(content, /decision/);
  assert.match(content, /"permission":"bash"/);
});

test("the log is truncated when it grows past the cap", () => {
  process.env.PI_PERMISSIONS_LOG = "1";
  fs.writeFileSync(logPath(), "x".repeat((1 << 20) + 1));
  log("decision", { permission: "bash", decision: "allow" });

  assert.ok(fs.statSync(logPath()).size < 1 << 20, "expected the oversized log to be truncated");
  assert.match(readLog(), /decision/);
});
