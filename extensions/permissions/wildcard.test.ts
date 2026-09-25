import assert from "node:assert/strict";
import test from "node:test";
import { collapseFolders } from "./wildcard.ts";

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
