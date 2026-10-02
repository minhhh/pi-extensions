import assert from "node:assert/strict";
import test from "node:test";
import { coalesceAsks, mergeExternal } from "./requests.ts";
import type { PermissionRequest } from "./types.ts";
import { sessionAlways } from "./types.ts";

function request(overrides: Partial<PermissionRequest>): PermissionRequest {
  return { permission: "bash", patterns: [], always: [], display: "", ...overrides };
}

test("coalesceAsks merges same-permission asks into one prompt", () => {
  const touch = request({ display: "$ touch 1", patterns: ["touch 1", "touch"], always: [sessionAlways("touch *")] });
  const cat = request({ display: "$ cat 1", patterns: ["cat 1", "cat"], always: [sessionAlways("cat *")] });

  const merged = coalesceAsks([touch, cat]);

  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0]!.patterns, ["touch 1", "touch", "cat 1", "cat"]);
  // A compound line still offers one "always" entry; its patterns cover every
  // command rather than making the user pick one command to allow.
  assert.deepEqual(merged[0]!.always, [sessionAlways("touch *", "cat *")]);
  assert.equal(merged[0]!.display, "$ touch 1\n$ cat 1");
});

test("coalesceAsks collapses duplicate always patterns into one option", () => {
  const first = request({ display: "$ git status", always: [sessionAlways("git *", "git status *")] });
  const second = request({ display: "$ git log", always: [sessionAlways("git *")] });

  const merged = coalesceAsks([first, second]);

  assert.deepEqual(merged[0]!.always, [sessionAlways("git *", "git status *")]);
});

test("coalesceAsks keeps different permissions apart", () => {
  const bash = request({ permission: "bash", display: "$ ls" });
  const external = request({ permission: "external_directory", display: "← folder" });

  const merged = coalesceAsks([bash, external]);

  assert.deepEqual(
    merged.map((entry) => entry.permission),
    ["bash", "external_directory"],
  );
});

test("coalesceAsks leaves a single ask untouched", () => {
  const only = request({ permission: "read", display: "read /a" });
  assert.deepEqual(coalesceAsks([only]), [only]);
});

test("mergeExternal drops folders contained by another", () => {
  const parent = request({
    permission: "external_directory",
    always: [sessionAlways("/tmp/test")],
    patterns: ["/tmp/test", "~/test"],
  });
  const child = request({
    permission: "external_directory",
    always: [sessionAlways("/tmp/test/folder_1")],
    patterns: ["/tmp/test/folder_1", "~/test/folder_1"],
  });

  const merged = mergeExternal([parent, child]);

  assert.deepEqual(
    merged.map((entry) => entry.always[0]!.patterns[0]),
    ["/tmp/test"],
  );
});

test("mergeExternal drops exact duplicate folders", () => {
  const first = request({ permission: "external_directory", always: [sessionAlways("/tmp/test")], patterns: ["/tmp/test"] });
  const second = request({ permission: "external_directory", always: [sessionAlways("/tmp/test")], patterns: ["/tmp/test"] });

  const merged = mergeExternal([first, second]);

  assert.deepEqual(
    merged.map((entry) => entry.always[0]!.patterns[0]),
    ["/tmp/test"],
  );
});

test("mergeExternal drops duplicates nested under a kept folder", () => {
  const parent = request({ permission: "external_directory", always: [sessionAlways("/tmp/test")], patterns: ["/tmp/test"] });
  const child = request({ permission: "external_directory", always: [sessionAlways("/tmp/test/folder_1")], patterns: ["/tmp/test/folder_1"] });
  const childAgain = request({ permission: "external_directory", always: [sessionAlways("/tmp/test/folder_1")], patterns: ["/tmp/test/folder_1"] });

  const merged = mergeExternal([parent, child, childAgain]);

  assert.deepEqual(
    merged.map((entry) => entry.always[0]!.patterns[0]),
    ["/tmp/test"],
  );
});

test("mergeExternal keeps unrelated folders", () => {
  const left = request({ permission: "external_directory", always: [sessionAlways("/a")], patterns: ["/a"] });
  const right = request({ permission: "external_directory", always: [sessionAlways("/b")], patterns: ["/b"] });

  const merged = mergeExternal([left, right]);

  assert.deepEqual(
    merged.map((entry) => entry.always[0]!.patterns[0]),
    ["/a", "/b"],
  );
});
