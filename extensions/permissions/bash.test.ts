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

test("analyzeBash does not read a > inside a sed script as a redirection", () => {
  // The `<T>` in the address is part of the sed program. Scanning it for a
  // shell redirect yields `/,/`, whose dirname is `/`, so the gate ends up
  // asking for the whole filesystem.
  const command = "sed -n '/custom<T>/,/;/p' extensions/types.ts";
  const sed = analyzeBash(command, "/work").find((segment) => segment.patterns.includes("sed"));
  assert.ok(sed, "expected a sed segment");
  assert.deepEqual(sed.paths, ["/work/extensions/types.ts"]);
});

test("analyzeBash resolves later relative paths against the cd target", () => {
  const command = "cd /other/project/src/core && grep -n custom extensions/types.ts";
  const grep = analyzeBash(command, "/work").find((segment) => segment.patterns.includes("grep"));
  assert.ok(grep, "expected a grep segment");
  assert.deepEqual(grep.paths, ["/other/project/src/core/extensions/types.ts"]);
});

test("analyzeBash reports the cd target when no segment names a file", () => {
  // `cd X && ls` has no path argument, so X itself is the only signal that the
  // command reads outside the working directory.
  const command = "cd /other/project/src/core && ls";
  const cd = analyzeBash(command, "/work").find((segment) => segment.patterns.includes("cd"));
  assert.ok(cd, "expected a cd segment");
  assert.deepEqual(cd.paths, ["/other/project/src/core"]);
});

test("analyzeBash collects a bare filename argument to grep", () => {
  // A slashless name is still a filesystem path for a script command; the
  // `looksLikePath` filter drops it and hides the read.
  const command = "grep -n custom types.ts";
  const grep = analyzeBash(command, "/work").find((segment) => segment.patterns.includes("grep"));
  assert.ok(grep, "expected a grep segment");
  assert.deepEqual(grep.paths, ["/work/types.ts"]);
});

test("analyzeBash keeps the file after a valueless flag like tail -f", () => {
  const command = "tail -f /var/log/system.log";
  const tail = analyzeBash(command, "/work").find((segment) => segment.patterns.includes("tail"));
  assert.ok(tail, "expected a tail segment");
  assert.deepEqual(tail.paths, ["/var/log/system.log"]);
});

test("analyzeBash does not read a grep flag value as a path", () => {
  const command = "grep -A 25 custom extensions/types.ts";
  const grep = analyzeBash(command, "/work").find((segment) => segment.patterns.includes("grep"));
  assert.ok(grep, "expected a grep segment");
  assert.deepEqual(grep.paths, ["/work/extensions/types.ts"]);
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

test("splitCommands keeps a heredoc body with its header, not as commands", () => {
  const command = "cat <<'EOF'\nhello world\nEOF\necho done";
  assert.deepEqual(splitCommands(command), ["cat <<'EOF'\nhello world\nEOF", "echo done"]);
});

test("splitCommands keeps multiple heredocs in body order", () => {
  const command = "cat <<A <<B\nfirst\nA\nsecond\nB";
  assert.deepEqual(splitCommands(command), ["cat <<A <<B\nfirst\nA\nsecond\nB"]);
});

test("splitCommands honors a tab-stripped heredoc terminator", () => {
  const command = "cat <<-EOF\n\tindented\n\tEOF";
  assert.deepEqual(splitCommands(command), ["cat <<-EOF\n\tindented\n\tEOF"]);
});

test("analyzeBash does not read a heredoc body as commands", () => {
  // Every non-empty body line reads as a command if the body is tokenized:
  // import, def, if, return, for, print, and the terminator itself.
  const command = `python3 - <<'PY'
import json
s=json.load(open('theme-schema.json'))
def find(o):
    if isinstance(o, dict):
        return o
PY`;
  const segments = analyzeBash(command, "/work");
  assert.deepEqual(
    segments.map((segment) => segment.patterns),
    [["python3 - <<PY", "python3"]],
  );
  for (const fake of ["import", "def", "if", "return", "PY"]) {
    assert.ok(
      !segments.some((segment) => segment.patterns.includes(fake)),
      `heredoc body leaked a "${fake}" command`,
    );
  }
});

test("analyzeBash does not resolve paths found only in a heredoc body", () => {
  // A body token like `"/work"))` resolves outside the cwd, so the gate asks
  // for its parent directory. Here that parent is `/`, which the prompt renders
  // as the whole-filesystem pattern `//*`.
  const command = `cat > /tmp/out.txt <<'EOF'
for (const s of analyzeBash(command, "/work")) {
  console.log(s.display, "| patterns:", JSON.stringify(s.patterns))
}
EOF`;
  const segments = analyzeBash(command, "/work");
  assert.deepEqual(segments.flatMap((segment) => segment.paths), ["/tmp/out.txt"]);
  assert.ok(
    !segments.some((segment) => segment.paths.includes("/")),
    "heredoc body leaked a path that resolves to the filesystem root",
  );
});

test("analyzeBash still runs the command after a heredoc terminator", () => {
  const command = "cat <<'EOF'\nbody text\nEOF\necho done";
  const segments = analyzeBash(command, "/work");
  assert.deepEqual(
    segments.map((segment) => segment.patterns[0]),
    ["cat <<EOF", "echo done"],
  );
});
