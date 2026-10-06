/**
 * Regression tests for the external_directory gate on direct tool calls.
 *
 * Every tool that names a path outside the cwd must produce an
 * `external_directory` request, the same way bash and grep do. The gate is what
 * asks before a read or write leaves the project tree, so a missing request is
 * a silent bypass.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test, { after } from "node:test";
import type { CustomToolCallEvent } from "@earendil-works/pi-coding-agent";
import { requestsForToolCall } from "./permission-gate.ts";
import type { PermissionRequest } from "./types.ts";
import { canonicalize } from "./wildcard.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "permissions-tool-requests-"));
const project = path.join(tmp, "project");
const outside = path.join(tmp, "outside");
fs.mkdirSync(project, { recursive: true });
fs.mkdirSync(outside, { recursive: true });
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const outsideFile = path.join(outside, "secret.txt");
const insideFile = path.join(project, "app.ts");

/** A tool_call event with the given name and input, as the SDK delivers it. */
function toolCall(toolName: string, input: Record<string, unknown>): CustomToolCallEvent {
  return { type: "tool_call", toolCallId: "test-call", toolName, input };
}

/** Folders named by the external_directory requests in a result. */
function externalFolders(requests: readonly PermissionRequest[]): string[] {
  return requests
    .filter((request) => request.permission === "external_directory")
    .map((request) => request.always[0]!.patterns[0]!);
}

for (const toolName of ["read", "write", "edit", "ls"] as const) {
  test(`${toolName} on an external path produces an external_directory request`, () => {
    const requests = requestsForToolCall(toolCall(toolName, { path: outsideFile }), project);
    assert.deepEqual(externalFolders(requests), [canonicalize(outside)]);
  });

  test(`${toolName} on an internal path produces no external_directory request`, () => {
    const requests = requestsForToolCall(toolCall(toolName, { path: insideFile }), project);
    assert.deepEqual(externalFolders(requests), []);
  });
}
