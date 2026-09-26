/**
 * End-to-end check for the external_directory asks a bash call produces.
 *
 * `bashRequests` lives inside the extension and is not exported, so this file
 * mirrors its two steps: collect the touched paths `analyzeBash` reports, turn
 * each external one into a folder ask, then merge nested folders. The behavior
 * it encodes is what the gate should prompt for.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test, { after } from "node:test";
import { analyzeBash } from "./bash.ts";
import { mergeExternal } from "./requests.ts";
import type { PermissionRequest } from "./types.ts";
import { isExternal, pathPatterns } from "./wildcard.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "permissions-bash-"));
const work = path.join(tmp, "work");
const project = path.join(tmp, "project", "src", "core");
fs.mkdirSync(path.join(project, "extensions"), { recursive: true });
fs.mkdirSync(work, { recursive: true });
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function folderFor(abs: string): string {
  try {
    if (fs.statSync(abs).isDirectory()) return abs;
  } catch {
    // Path does not exist; treat it as a file about to be created.
  }
  return path.dirname(abs);
}

/** The folders the gate would ask for, after collapsing nested ones. */
function externalFolders(command: string, cwd: string): string[] {
  const folders = new Set<string>();
  for (const segment of analyzeBash(command, cwd)) {
    for (const touched of segment.paths) {
      if (isExternal(touched, cwd)) folders.add(folderFor(touched));
    }
  }
  const requests: PermissionRequest[] = [...folders].map((folder) => ({
    permission: "external_directory",
    patterns: pathPatterns(folder),
    always: [folder],
    display: "",
  }));
  return mergeExternal(requests).map((request) => request.always[0]!);
}

test("cd then relative reads asks for the cd tree, not root", () => {
  const command = [
    `cd ${project} && grep -n "custom" extensions/types.ts`,
    'echo "==="',
    "sed -n '/custom<T>/,/;/p' extensions/types.ts",
  ].join("; ");
  assert.deepEqual(externalFolders(command, work), [project]);
});

test("the sed address alone never asks for the filesystem root", () => {
  // `T>/,/` is a redirection candidate only because the scan ignores quotes.
  const command = `sed -n '/custom<T>/,/;/p' ${project}/extensions/types.ts`;
  assert.deepEqual(externalFolders(command, work), [path.join(project, "extensions")]);
});
