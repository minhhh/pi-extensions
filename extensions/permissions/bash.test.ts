import assert from "node:assert/strict";
import test from "node:test";
import { analyzeBash, splitCommands } from "./bash.ts";
import { collapseFolders } from "./wildcard.ts";

test("splitCommands keeps file descriptor redirections intact", () => {
  assert.deepEqual(splitCommands("ls -la foo 2>&1"), ["ls -la foo 2>&1"]);
  assert.deepEqual(splitCommands("cmd >&2"), ["cmd >&2"]);
  assert.deepEqual(splitCommands("cmd &> out.log"), ["cmd &> out.log"]);
  assert.deepEqual(splitCommands("cmd &>> out.log"), ["cmd &>> out.log"]);
  assert.deepEqual(splitCommands("cmd <&3"), ["cmd <&3"]);
});

test("splitCommands still splits on control operators", () => {
  assert.deepEqual(splitCommands("a; b"), ["a", "b"]);
  assert.deepEqual(splitCommands("a && b"), ["a", "b"]);
  assert.deepEqual(splitCommands("a & b"), ["a", "b"]);
  assert.deepEqual(splitCommands("a | b"), ["a", "b"]);
});

test("analyzeBash does not treat a redirection fd as a command", () => {
  const segments = analyzeBash('ls -la; echo "---"; ls -la ../folder_2/folder_9/ 2>&1', "/tmp/work");
  assert.deepEqual(
    segments.map((segment) => segment.display),
    ["$ ls -la", '$ echo "---"', "$ ls -la ../folder_2/folder_9/ 2>&1"],
  );
  for (const segment of segments) {
    assert.ok(
      !segment.patterns.includes("1"),
      `unexpected command pattern "1" in ${JSON.stringify(segment.patterns)}`,
    );
  }
});

test("analyzeBash does not read a sed script as a path", () => {
  // The sed expression is a script, not a file. Its `/.../` delimiters make it
  // look path-like, but only the trailing file argument touches the filesystem.
  const command =
    "sed -n '/^export type ThemeColor =/,/^   |/p' src/modes/interactive/theme/theme.ts";
  const sed = analyzeBash(command, "/work").find((segment) => segment.patterns.includes("sed"));
  assert.ok(sed, "expected a sed segment");
  assert.deepEqual(sed.paths, ["/work/src/modes/interactive/theme/theme.ts"]);
});

test("nested external folders in one command collapse to the outermost", () => {
  const command =
    "ls -la /Users/minh/temp/test/ && ls -la /Users/minh/temp/test/folder_2/folder_9/ 2>&1; ls -la /Users/minh/temp/test/folder_1";
  const paths = analyzeBash(command, "/work").flatMap((segment) => segment.paths);
  assert.deepEqual(paths.sort(), [
    "/Users/minh/temp/test",
    "/Users/minh/temp/test/folder_1",
    "/Users/minh/temp/test/folder_2/folder_9",
  ]);
  assert.deepEqual(collapseFolders(paths), ["/Users/minh/temp/test"]);
});
