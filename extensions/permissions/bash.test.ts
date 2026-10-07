import assert from "node:assert/strict";
import * as path from "node:path";
import test from "node:test";
import { analyzeBash, matchableSegments, resolveUserPath, splitCommands, SUBSTITUTION_FAMILY } from "./bash.ts";
import { sessionAlways } from "./types.ts";
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

test("analyzeBash reads a subshell as grouping, not as part of the command name", () => {
  // Without paren handling the inner command is named `(timeout`, so a
  // `timeout *` rule never matches and the pipe target is named `head -60)`.
  const command = "cd /tmp && (timeout 90 npx -y skills find typescript < /dev/null 2>&1 | head -60)";
  const segments = analyzeBash(command, "/work");

  const timeout = segments.find((segment) => segment.patterns.includes("timeout"));
  assert.ok(timeout, `expected a timeout segment, got ${JSON.stringify(segments.map((s) => s.patterns))}`);
  assert.deepEqual(timeout.patterns, [
    "timeout 90 npx -y skills find typescript < /dev/null 2>&1",
    "timeout",
  ]);

  const head = segments.find((segment) => segment.patterns.includes("head"));
  assert.ok(head, "expected a head segment");
  assert.deepEqual(head.patterns, ["head -60", "head"]);
});

test("analyzeBash ignores an input redirect to /dev/null", () => {
  // The null device is not a project file. Counting it makes the gate ask for
  // /dev, which nobody wants to approve.
  const command = "cd /tmp && (timeout 90 npx -y skills find typescript < /dev/null 2>&1 | head -60)";
  const paths = analyzeBash(command, "/work").flatMap((segment) => segment.paths);
  assert.deepEqual(paths, ["/tmp"]);
});

test("analyzeBash keeps a command substitution inside an assignment whole", () => {
  // Splitting at the spaces inside `$(...)` drops the `desc=` prefix and
  // promotes the awk program to the command name, so a `print; exit` fragment
  // becomes the suggested always-grant.
  const command = `desc=$(awk '/^description:/{sub(/^description: */,""); print; exit}' "$f")`;
  const segment = analyzeBash(command, "/work")[0]!;
  assert.deepEqual(segment.patterns, [SUBSTITUTION_FAMILY]);
  assert.deepEqual(segment.always, [sessionAlways(SUBSTITUTION_FAMILY)]);
});

test("analyzeBash does not leak a $() assignment value as a command in a for loop", () => {
  const command =
    'cd /Users/alex/gitrepos/local_tools/agent-skills && for d in skills/*/; do n=$(basename "$d"); f="$d/SKILL.md"; [ -f "$f" ] || continue; desc=$(awk \'/^description:/{sub(/^description: */,""); print; exit}\' "$f"); echo "$n :: ${desc:0:120}"; done';
  const segments = analyzeBash(command, "/work");

  for (const segment of segments) {
    const approved = segment.always.flatMap((option) => option.patterns);
    assert.ok(
      ![segment.patterns, approved].flat().some((pattern) => pattern.includes("print; exit}")),
      `awk program leaked into the parse: ${JSON.stringify({ patterns: segment.patterns, always: segment.always })}`,
    );
  }

  const segmentFor = (needle: string): (typeof segments)[number] => {
    const segment = segments.find((candidate) => candidate.display.includes(needle));
    assert.ok(segment, `expected a segment containing ${needle}`);
    return segment;
  };

  // `do` and the assignment are dropped, so the hidden `basename` call is only
  // visible as `(subshell)`.
  assert.deepEqual(segmentFor("basename").patterns, [SUBSTITUTION_FAMILY]);
  // `for` stays matchable so a rule can cover the header. The other keywords
  // and the conditional are path-only.
  assert.deepEqual(segmentFor("for d in").patterns, ["for d in skills/*/", "for"]);
  assert.deepEqual(segmentFor("for d in").paths, [
    "/Users/alex/gitrepos/local_tools/agent-skills/skills/*",
  ]);
  assert.deepEqual(segmentFor("continue").patterns, []);
  assert.deepEqual(segmentFor("done").patterns, []);
  // The conditional is a builtin, not a program; its only path argument is
  // already read by `collectPaths`.
  assert.deepEqual(segmentFor("[ -f").patterns, []);
});

test("analyzeBash treats `for` as a matchable candidate and leaves other keywords path-only", () => {
  // `for` needs a pattern so a rule can match the header and the prompt can
  // offer an always-grant. The other keywords stay path-only.
  const command = 'for d in skills/*/; do echo "$d"; done; continue';
  const segments = analyzeBash(command, "/work");

  assert.deepEqual(
    segments.map((segment) => segment.patterns),
    [["for d in skills/*/", "for"], ["echo $d", "echo"], [], []],
  );
  assert.deepEqual(segments[0]!.paths, ["/work/skills/*"]);
  assert.deepEqual(segments[0]!.always, [sessionAlways("for *")]);
  assert.deepEqual(segments[1]!.always, [sessionAlways("echo *")]);
  assert.deepEqual(segments[2]!.always, []);
  assert.deepEqual(segments[3]!.always, []);
});

test("matchableSegments drops keyword-only segments so `done` is never asked", () => {
  // A `done` segment has no pattern, and no rule matches an empty pattern list,
  // so its request would always resolve to `ask`. The gate would prompt for a
  // word that runs nothing. It is dropped before a request is built.
  const command = 'for d in a b; do echo "$d"; done';
  const segments = analyzeBash(command, "/work");
  assert.equal(segments.at(-1)!.display, "$ done");
  assert.deepEqual(segments.at(-1)!.patterns, []);

  const kept = matchableSegments(segments);
  assert.ok(!kept.some((segment) => segment.display === "$ done"), "`done` should not produce a request");
  assert.deepEqual(
    kept.map((segment) => segment.display),
    ["$ for d in a b", '$ do echo "$d"'],
  );
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
    "ls -la /Users/alex/temp/test/ && ls -la /Users/alex/temp/test/folder_2/folder_9/ 2>&1; ls -la /Users/alex/temp/test/folder_1";
  const paths = analyzeBash(command, "/work").flatMap((segment) => segment.paths);
  assert.deepEqual(paths.sort(), [
    "/Users/alex/temp/test",
    "/Users/alex/temp/test/folder_1",
    "/Users/alex/temp/test/folder_2/folder_9",
  ]);
  assert.deepEqual(collapseFolders(paths), ["/Users/alex/temp/test"]);
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

test("analyzeBash parses a for loop over quoted queries with piped filters", () => {
  // A realistic skills-search loop. The quoted queries are loop data, so they
  // are not paths; `$q` is a variable reference, not a substitution; the sed
  // and grep expressions are programs, not files; and `< /dev/null` is not a
  // read. Only the `cd` target touches the filesystem.
  const command = `cd /tmp && for q in "typescript performance" "typescript security" "typescript code review"; do echo "##### $q #####";
 timeout 90 npx -y skills find "$q" < /dev/null 2>&1 | sed 's/\\x1b\\[[0-9;]*m//g' | grep -iE 'typescript|^[a-z]' | head -22;
 done`;

  const segments = analyzeBash(command, "/work");

  // The `for` header stays matchable, and its quoted queries are not paths.
  const header = segments.find((segment) => segment.display.includes("for q in"));
  assert.ok(header, `expected a for header, got ${JSON.stringify(segments.map((s) => s.display))}`);
  assert.deepEqual(header.patterns, [
    "for q in typescript performance typescript security typescript code review",
    "for",
  ]);
  assert.deepEqual(header.always, [sessionAlways("for *")]);
  assert.deepEqual(header.paths, []);

  // `$q` is a variable, so no segment should claim a hidden subshell.
  for (const segment of segments) {
    assert.ok(
      !segment.patterns.includes(SUBSTITUTION_FAMILY),
      `unexpected ${SUBSTITUTION_FAMILY} in ${JSON.stringify(segment.patterns)}`,
    );
  }

  // The sed and grep expressions are scripts; neither becomes a path, and the
  // null device is dropped. The `cd` target is the only path touched.
  assert.deepEqual(segments.flatMap((segment) => segment.paths), ["/tmp"]);

  assert.deepEqual(segments.find((segment) => segment.patterns.includes("sed"))!.patterns, [
    "sed s/\\x1b\\[[0-9;]*m//g",
    "sed",
  ]);
  assert.deepEqual(segments.find((segment) => segment.patterns.includes("grep"))!.patterns, [
    "grep -iE typescript|^[a-z]",
    "grep",
  ]);
  assert.deepEqual(segments.find((segment) => segment.patterns.includes("timeout"))!.patterns, [
    "timeout 90 npx -y skills find $q < /dev/null 2>&1",
    "timeout",
  ]);
});

test("analyzeBash parses a for loop over repo slugs and a curl pipeline", () => {
  // The loop words are slugs (`owner/repo`). `for` stays matchable so a rule can
  // cover the header and the prompt can offer `for *`.
  const command =
    'for r in mdproctor/cc-praxis affaan-m/ECC wshobson/agents jeffallan/claude-skills backnotprop/pstack sickn33/agentic-awesome-skills dotneet/claude-code-marketplace; do echo "=== $r ==="; curl -s "https://api.github.com/repos/$r/license" | grep -E \'"spdx_id"|"name":\' | head -3; done';
  const segments = analyzeBash(command, "/work");

  const header = segments.find((segment) => segment.display.includes("for r in"))!;
  assert.deepEqual(header.patterns, [
    "for r in mdproctor/cc-praxis affaan-m/ECC wshobson/agents jeffallan/claude-skills backnotprop/pstack sickn33/agentic-awesome-skills dotneet/claude-code-marketplace",
    "for",
  ]);
  assert.deepEqual(header.always, [sessionAlways("for *")]);

  const curl = segments.find((segment) => segment.patterns.includes("curl"))!;
  assert.deepEqual(curl.patterns, ["curl -s https://api.github.com/repos/$r/license", "curl"]);
});

test("resolveUserPath keeps a relative operand under the cwd", () => {
  const cwd = process.platform === "win32" ? "C:\\work" : "/work";
  assert.equal(resolveUserPath("list/Scripts", cwd), path.resolve(cwd, "list/Scripts"));
});

test("resolveUserPath translates a git-bash drive path instead of doubling the drive", () => {
  if (process.platform !== "win32") return;
  assert.equal(resolveUserPath("/c/Users/alex/list", "C:\\Users\\alex"), "C:\\Users\\alex\\list");
});
