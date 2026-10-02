/**
 * Tests for the external_directory request the gate builds for a touched path.
 *
 * The contract: nothing outside the cwd produces a request, and every request
 * carries the canonical absolute folder. Symlinks are resolved, so a link
 * inside the tree that points outside it is named by its real target and not
 * by the link.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test, { after } from "node:test";
import { addExternalFolder } from "./permission-gate.ts";
import type { PermissionRequest } from "./types.ts";
import { canonicalize } from "./wildcard.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "permissions-gate-"));
const project = path.join(tmp, "project");
const outside = path.join(tmp, "outside");
fs.mkdirSync(project, { recursive: true });
fs.mkdirSync(outside, { recursive: true });
fs.writeFileSync(path.join(outside, "secret.txt"), "s");
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function collect(abs: string, cwd: string): PermissionRequest[] {
  const requests: PermissionRequest[] = [];
  addExternalFolder(requests, abs, cwd);
  return requests;
}

function makeSymlink(target: string, link: string): boolean {
  try {
    fs.symlinkSync(target, link);
    return true;
  } catch {
    return false;
  }
}

const dirLink = path.join(project, "root");
const symlinksAvailable = makeSymlink(outside, dirLink);

test("an internal path produces no external request", () => {
  assert.deepEqual(collect(path.join(project, "file.txt"), project), []);
  assert.deepEqual(collect(path.join(project, "nested", "file.txt"), project), []);
});

test("an external path asks for the canonical absolute folder", () => {
  const file = path.join(outside, "secret.txt");
  const requests = collect(file, project);

  assert.equal(requests.length, 1);
  const request = requests[0]!;
  const expected = canonicalize(outside);
  assert.deepEqual(request.patterns, [expected]);
  assert.deepEqual(request.always[0]!.patterns, [expected]);
  assert.equal(path.isAbsolute(request.patterns[0]!), true);
  assert.match(request.display, new RegExp(`Access external directory ${expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
});

test("a symlinked directory inside the cwd asks for its real target", (t) => {
  if (!symlinksAvailable) {
    t.skip("symlinks unavailable on this platform");
    return;
  }
  // `/project/root` is a link to `/outside`. The touched file is lexically
  // inside the cwd, and the grant names `/outside`, not the link.
  const requests = collect(path.join(dirLink, "secret.txt"), project);

  assert.equal(requests.length, 1);
  const folder = canonicalize(outside);
  assert.deepEqual(requests[0]!.patterns, [folder]);
  assert.deepEqual(requests[0]!.always[0]!.patterns, [folder]);
  assert.notEqual(requests[0]!.patterns[0], dirLink);
});

test("a path that does not exist yet still resolves through a symlinked parent", (t) => {
  if (!symlinksAvailable) {
    t.skip("symlinks unavailable on this platform");
    return;
  }
  const requests = collect(path.join(dirLink, "not-created-yet.txt"), project);

  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0]!.patterns, [canonicalize(outside)]);
});
