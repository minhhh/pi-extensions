/**
 * Request shaping.
 *
 * Turns the raw list of requests a call produces into what the prompt shows:
 * nested external folders collapse to the outermost one, and the asks of a
 * single permission coalesce into one prompt. Decisions stay per request, so
 * merging here never widens what is allowed.
 */

import type { PermissionRequest } from "./types.ts";
import { collapseFolders } from "./wildcard.ts";

/** Drop external folders that sit inside another folder in the list. */
export function mergeExternal(requests: readonly PermissionRequest[]): PermissionRequest[] {
  const byFolder = new Map<string, PermissionRequest>();
  for (const request of requests) {
    const folder = request.always[0];
    if (folder !== undefined && !byFolder.has(folder)) byFolder.set(folder, request);
  }
  const kept = new Set(collapseFolders([...byFolder.keys()]));
  return [...byFolder.entries()]
    .filter(([folder]) => kept.has(folder))
    .map(([, request]) => request);
}

/** Group asking requests by permission so one prompt covers them all. */
export function coalesceAsks(requests: readonly PermissionRequest[]): PermissionRequest[] {
  const groups = new Map<string, PermissionRequest[]>();
  for (const request of requests) {
    const group = groups.get(request.permission);
    if (group) group.push(request);
    else groups.set(request.permission, [request]);
  }
  return [...groups.values()].map((group) => (group.length === 1 ? group[0]! : mergeRequests(group)));
}

function mergeRequests(requests: readonly PermissionRequest[]): PermissionRequest {
  const first = requests[0]!;
  return {
    permission: first.permission,
    patterns: [...new Set(requests.flatMap((request) => request.patterns))],
    always: [...new Set(requests.flatMap((request) => request.always))],
    display: requests.map((request) => request.display).join("\n"),
  };
}
