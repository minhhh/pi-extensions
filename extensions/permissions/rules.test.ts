/**
 * Tests for the core resolution invariants in rules.ts.
 *
 * These are the guarantees the whole policy engine rests on:
 *   - the last matching rule wins, within a ruleset and across rulesets
 *   - a rule matches when its pattern matches any spelling of the resource
 *   - a project rule may only tighten, never loosen
 *   - a config deny is absolute: no session grant may lift it
 *   - a session grant may only raise an ask to an allow
 */

import assert from "node:assert/strict";
import test from "node:test";
import { evaluate, findLastRule, resolveOne, resolveRequest, ruleMatches } from "./rules.ts";
import type { Decision, LoadedConfig, PermissionRequest, PermissionRule } from "./types.ts";

function rule(permission: PermissionRule["permission"], pattern: string, action: Decision): PermissionRule {
  return { permission, pattern, action };
}

function makeConfig(parts: Partial<LoadedConfig> = {}): LoadedConfig {
  return {
    defaultRules: [],
    userRules: [],
    projectRules: [],
    userPath: "",
    projectPath: "",
    warnings: [],
    ...parts,
  };
}

// --- Last match wins -------------------------------------------------------

test("the last matching rule in a ruleset wins", () => {
  const config = makeConfig({
    defaultRules: [rule("bash", "*", "allow"), rule("bash", "rm *", "deny")],
  });
  assert.equal(resolveOne(config, "bash", ["rm -rf /tmp/x"], []), "deny");
});

test("a later permission-wide rule overrides an earlier specific one", () => {
  const config = makeConfig({
    userRules: [rule("bash", "rm *", "deny"), rule("bash", "*", "allow")],
  });
  assert.equal(resolveOne(config, "bash", ["rm -rf /tmp/x"], []), "allow");
});

test("a user rule overrides a default rule with the same scope", () => {
  const config = makeConfig({
    defaultRules: [rule("read", "*.env", "deny")],
    userRules: [rule("read", "*.env", "allow")],
  });
  assert.equal(resolveOne(config, "read", ["/p/.env"], []), "allow");
});

test("findLastRule returns the last match across rulesets", () => {
  const found = findLastRule(
    [[rule("bash", "*", "allow")], [rule("read", "*", "deny")], [rule("bash", "git *", "ask")]],
    "bash",
    ["git push"],
  );
  assert.deepEqual(found, rule("bash", "git *", "ask"));
});

test("findLastRule returns undefined when nothing matches", () => {
  assert.equal(findLastRule([[rule("bash", "*", "allow")]], "read", ["/p/.env"]), undefined);
});

// --- Pattern alternatives --------------------------------------------------

test("a rule matches when any spelling of the resource matches", () => {
  const envDeny = rule("read", "~/.env", "deny");
  assert.equal(ruleMatches(envDeny, "read", ["/home/u/.env", "~/.env"]), true);
});

test("a rule whose permission differs does not match", () => {
  assert.equal(ruleMatches(rule("edit", "*", "deny"), "read", ["/p/x"]), false);
});

test("a wildcard permission rule matches any permission key", () => {
  const config = makeConfig({ userRules: [rule("*", "*", "deny")] });
  assert.equal(resolveOne(config, "someCustomTool", ["anything"], []), "deny");
});

// --- Project rules may only tighten ----------------------------------------

test("a project deny overrides a user allow", () => {
  const config = makeConfig({
    userRules: [rule("bash", "*", "allow")],
    projectRules: [rule("bash", "git push *", "deny")],
  });
  assert.equal(resolveOne(config, "bash", ["git push origin main"], []), "deny");
});

test("a project ask tightens a user allow", () => {
  const config = makeConfig({
    userRules: [rule("bash", "*", "allow")],
    projectRules: [rule("bash", "docker *", "ask")],
  });
  assert.equal(resolveOne(config, "bash", ["docker run img"], []), "ask");
});

test("a project allow cannot loosen a user ask", () => {
  const config = makeConfig({
    userRules: [rule("bash", "sudo *", "ask")],
    projectRules: [rule("bash", "sudo *", "allow")],
  });
  assert.equal(resolveOne(config, "bash", ["sudo rm -rf /"], []), "ask");
});

test("a project allow cannot loosen a user deny", () => {
  const config = makeConfig({
    userRules: [rule("edit", "**/.ssh/*", "deny")],
    projectRules: [rule("edit", "**/.ssh/*", "allow")],
  });
  assert.equal(resolveOne(config, "edit", ["/home/u/.ssh/id_ed25519"], []), "deny");
});

test("the last matching project rule wins, not the most specific", () => {
  const userRules = [rule("bash", "*", "allow")];
  const denyThenAsk = makeConfig({
    userRules,
    projectRules: [rule("bash", "git push *", "deny"), rule("bash", "git *", "ask")],
  });
  const askThenDeny = makeConfig({
    userRules,
    projectRules: [rule("bash", "git *", "ask"), rule("bash", "git push *", "deny")],
  });
  assert.equal(resolveOne(denyThenAsk, "bash", ["git push x"], []), "ask");
  assert.equal(resolveOne(askThenDeny, "bash", ["git push x"], []), "deny");
});

// --- Config deny is absolute ----------------------------------------------

test("a session grant cannot lift a user deny", () => {
  const config = makeConfig({ userRules: [rule("read", "*.env", "deny")] });
  const grant = [rule("read", "*", "allow")];
  assert.equal(resolveOne(config, "read", ["/p/.env"], grant), "deny");
});

test("a session grant cannot lift a project deny", () => {
  const config = makeConfig({ projectRules: [rule("read", "*.env", "deny")] });
  const grant = [rule("read", "*", "allow")];
  assert.equal(resolveOne(config, "read", ["/p/.env"], grant), "deny");
});

// --- Session grants only raise ask to allow --------------------------------

test("a session grant raises an ask to an allow", () => {
  const config = makeConfig();
  const grant = [rule("bash", "git push *", "allow")];
  assert.equal(resolveOne(config, "bash", ["git push origin main"], grant), "allow");
});

test("a session grant leaves an allow untouched", () => {
  const config = makeConfig({ userRules: [rule("bash", "*", "allow")] });
  assert.equal(resolveOne(config, "bash", ["echo hi"], [rule("bash", "*", "deny")]), "allow");
});

test("a grant that is not an allow does not change an ask", () => {
  const config = makeConfig();
  assert.equal(resolveOne(config, "bash", ["echo hi"], [rule("bash", "*", "deny")]), "ask");
});

test("the last matching grant wins", () => {
  const config = makeConfig();
  const grants = [rule("bash", "*", "allow"), rule("bash", "rm *", "deny")];
  assert.equal(resolveOne(config, "bash", ["rm -rf /tmp/x"], grants), "ask");
});

// --- Fallbacks and request delegation --------------------------------------

test("evaluate falls back when nothing matches", () => {
  assert.equal(evaluate("bash", ["x"], [[]]), "ask");
  assert.equal(evaluate("bash", ["x"], [[]], "allow"), "allow");
});

test("resolveRequest evaluates the request's permission and patterns", () => {
  const config = makeConfig({ userRules: [rule("read", "*.env", "deny")] });
  const request: PermissionRequest = {
    permission: "read",
    patterns: ["/p/.env"],
    always: [],
    display: "read /p/.env",
  };
  assert.equal(resolveRequest(config, request, []), "deny");
});
