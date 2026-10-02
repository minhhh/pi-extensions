import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test, { after } from "node:test";
import { canonicalize, collapseFolders, expandHome, isExternal, wildcardMatch } from "./wildcard.ts";

test("collapseFolders keeps only the outermost folder", () => {
  const folders = [
    "/Users/alex/temp/test",
    "/Users/alex/temp/test/folder_2/folder_9",
    "/Users/alex/temp/test/folder_1",
  ];
  assert.deepEqual(collapseFolders(folders), ["/Users/alex/temp/test"]);
});

test("collapseFolders keeps unrelated folders", () => {
  assert.deepEqual(collapseFolders(["/a/b", "/a/c"]), ["/a/b", "/a/c"]);
});

test("collapseFolders does not treat a name prefix as containment", () => {
  assert.deepEqual(collapseFolders(["/a/b", "/a/bc"]), ["/a/b", "/a/bc"]);
});

test("collapseFolders dedupes equal folders", () => {
  assert.deepEqual(collapseFolders(["/a/b", "/a/b"]), ["/a/b"]);
});

test("a trailing path wildcard also matches the folder itself", () => {
  assert.equal(wildcardMatch("/home/u/.pi", "/home/u/.pi/*"), true);
  assert.equal(wildcardMatch("/home/u/.pi", "/home/u/.pi/**"), true);
  assert.equal(wildcardMatch("/home/u/.pi", expandHome("~/.pi/**", "/home/u")), true);
});

test("a trailing path wildcard still matches everything under the folder", () => {
  assert.equal(wildcardMatch("/home/u/.pi/agent/permissions.json", "/home/u/.pi/*"), true);
  assert.equal(wildcardMatch("/home/u/.pi/agent/permissions.json", "/home/u/.pi/**"), true);
});

test("a folder pattern does not match a sibling with the same prefix", () => {
  assert.equal(wildcardMatch("/home/u/.pix", "/home/u/.pi/*"), false);
});

test("a slash after a space is a command pattern, not a folder", () => {
  assert.equal(wildcardMatch("ls /tmp", "ls /*"), true);
  assert.equal(wildcardMatch("ls", "ls /*"), false);
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "permissions-wildcard-"));
const inside = path.join(tmp, "project");
const outside = path.join(tmp, "outside");
fs.mkdirSync(inside, { recursive: true });
fs.mkdirSync(outside, { recursive: true });
fs.writeFileSync(path.join(outside, "secret.txt"), "s");
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** Create every fixture symlink once; EEXIST would otherwise look like a skip. */
function makeSymlink(target: string, link: string): boolean {
  try {
    fs.symlinkSync(target, link);
    return true;
  } catch {
    return false;
  }
}

const dirLink = path.join(inside, "root");
const fileLink = path.join(inside, "secret-link");
const cwdLink = path.join(tmp, "project-link");
const symlinksAvailable =
  makeSymlink(outside, dirLink) &&
  makeSymlink(path.join(outside, "secret.txt"), fileLink) &&
  makeSymlink(inside, cwdLink);

test("isExternal treats a lexical child as internal", () => {
  assert.equal(isExternal(path.join(inside, "file.txt"), inside), false);
  assert.equal(isExternal(path.join(inside, "nested", "file.txt"), inside), false);
});

test("isExternal flags a symlinked directory that points outside the cwd", (t) => {
  if (!symlinksAvailable) {
    t.skip("symlinks unavailable on this platform");
    return;
  }
  // `/project/root/secret.txt` is lexically inside the cwd but resolves to
  // `/outside/secret.txt`, so the external gate has to ask.
  assert.equal(isExternal(path.join(dirLink, "secret.txt"), inside), true);
});

test("isExternal flags a symlinked file that points outside the cwd", (t) => {
  if (!symlinksAvailable) {
    t.skip("symlinks unavailable on this platform");
    return;
  }
  assert.equal(isExternal(fileLink, inside), true);
});

test("isExternal resolves the cwd through symlinks too", (t) => {
  if (!symlinksAvailable) {
    t.skip("symlinks unavailable on this platform");
    return;
  }
  // The cwd is given via a symlink, so a path under the real directory is
  // still internal.
  assert.equal(isExternal(path.join(inside, "file.txt"), cwdLink), false);
});

test("canonicalize resolves through a symlinked parent for a missing leaf", (t) => {
  if (!symlinksAvailable) {
    t.skip("symlinks unavailable on this platform");
    return;
  }
  assert.equal(canonicalize(path.join(dirLink, "not-created-yet.txt")), path.join(fs.realpathSync(outside), "not-created-yet.txt"));
});
