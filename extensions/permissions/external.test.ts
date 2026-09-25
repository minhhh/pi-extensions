/**
 * Regression tests for the `external_directory` gate around a trusted tree.
 *
 * The README documents `"~/projects/personal/**": "allow"` as the way to allow
 * a whole tree. The external gate matches rules against the *containing folder*
 * of the touched path, so a rule ending in `/**` has to match that folder too.
 * These tests encode the behavior the docs promise; they currently fail.
 */

import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { BUILTIN_RULES } from "./config.ts";
import { resolveRequest } from "./rules.ts";
import type { LoadedConfig, PermissionRequest } from "./types.ts";
import { expandHome, pathPatterns, wildcardMatch } from "./wildcard.ts";

const HOME = os.homedir();

/** A config that allows the whole `~/.pi` tree, exactly as a user would write it. */
function treeConfig(folder: string): LoadedConfig {
  return {
    defaultRules: [...BUILTIN_RULES],
    userRules: [
      { permission: "external_directory", pattern: expandHome("~/.pi/**", HOME), action: "allow" },
    ],
    projectRules: [],
    userPath: "",
    projectPath: "",
    warnings: [],
  };
}

/** The request `addExternalFolder` builds for a touched path. */
function externalRequest(folder: string): PermissionRequest {
  return {
    permission: "external_directory",
    patterns: pathPatterns(folder, HOME),
    always: [folder],
    display: `  ← Access external directory ${folder}`,
  };
}

test("a trailing /** also matches the tree root itself", () => {
  const tree = path.join(HOME, ".pi");
  assert.equal(
    wildcardMatch(tree, expandHome("~/.pi/**", HOME)),
    true,
    `~/.pi/** should cover the trusted tree root ${tree}`,
  );
});

test("external_directory allow ~/.pi/** covers the tree root folder", () => {
  const tree = path.join(HOME, ".pi");
  const decision = resolveRequest(treeConfig(tree), externalRequest(tree), []);
  assert.equal(decision, "allow");
});

test("external_directory allow ~/.pi/** covers a file directly under the root", () => {
  const tree = path.join(HOME, ".pi");
  const folder = path.dirname(path.join(tree, "permissions.json"));
  assert.equal(folder, tree, "precondition: the file's folder is the tree root");
  const decision = resolveRequest(treeConfig(tree), externalRequest(folder), []);
  assert.equal(decision, "allow");
});

test("a nested folder under the trusted tree still matches", () => {
  const nested = path.join(HOME, ".pi", "agent");
  const decision = resolveRequest(treeConfig(path.join(HOME, ".pi")), externalRequest(nested), []);
  assert.equal(decision, "allow");
});
