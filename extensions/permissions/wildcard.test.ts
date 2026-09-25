import assert from "node:assert/strict";
import test from "node:test";
import { collapseFolders, expandHome, wildcardMatch } from "./wildcard.ts";

test("collapseFolders keeps only the outermost folder", () => {
  const folders = [
    "/Users/minh/temp/test",
    "/Users/minh/temp/test/folder_2/folder_9",
    "/Users/minh/temp/test/folder_1",
  ];
  assert.deepEqual(collapseFolders(folders), ["/Users/minh/temp/test"]);
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
