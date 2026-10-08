import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test, { after } from "node:test";
import { canonicalize, collapseFolders, expandHome, isDrivePath, isExternal, pathPatterns, toNativePath, wildcardMatch } from "./wildcard.ts";

const WINDOWS = process.platform === "win32";

test("toNativePath maps a git-bash drive path to a Windows path", () => {
  if (!WINDOWS) return;
  assert.equal(toNativePath("/c/Users/alex/list"), "C:\\Users\\alex\\list");
  assert.equal(toNativePath("/cygdrive/d/dev"), "D:\\dev");
  assert.equal(toNativePath("/c"), "C:\\");
});

test("toNativePath leaves native and relative spellings alone", () => {
  assert.equal(toNativePath("relative/file"), "relative/file");
  assert.equal(toNativePath("C:\\Users\\alex"), "C:\\Users\\alex");
  if (!WINDOWS) assert.equal(toNativePath("/c/Users/alex"), "/c/Users/alex");
});

test("isDrivePath recognizes a drive spelling and nothing else", () => {
  // Shape test, so it holds on every platform: the token is a drive spelling
  // when a single letter follows the root. This is what keeps a `/c/...` path
  // from being read as a Windows `/c` option.
  for (const spelling of ["/c", "/c/Users/alex", "/cygdrive/d", "/cygdrive/d/dev"]) {
    assert.equal(isDrivePath(spelling), true, spelling);
  }
  for (const other of ["/FI", "/FO", "/usr/bin", "/tmp", "/cygdrive", "c/Users", "C:\\Users"]) {
    assert.equal(isDrivePath(other), false, other);
  }
});

test("canonicalize does not pin a drive-style path to the cwd drive", () => {
  if (!WINDOWS) return;
  const resolved = canonicalize("/c/permissions-probe-missing");
  assert.ok(!resolved.includes("\\c\\"), `drive was doubled: ${resolved}`);
  assert.equal(resolved.toLowerCase(), "c:\\permissions-probe-missing");
});

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

test("expandHome joins the remainder with the platform separator", () => {
  const home = process.platform === "win32" ? "C:\\Users\\u" : "/home/u";
  assert.equal(expandHome("~/.pi/**", home), path.join(home, ".pi", "**"));
  assert.equal(expandHome("$HOME/.pi", home), path.join(home, ".pi"));
  assert.equal(expandHome("~/", home), home);
  if (process.platform === "win32") {
    // A native spelling opens the remainder too, which is what pathPatterns
    // generates on Windows.
    assert.equal(expandHome("~\\.pi", home), path.join(home, ".pi"));
  }
});

test("pathPatterns spells home with the platform separator", () => {
  const home = path.join(os.tmpdir(), "permissions-home-probe");
  const file = path.join(home, "project", "secret.txt");
  const patterns = pathPatterns(file, home);
  assert.ok(
    patterns.includes(path.join("~", "project", "secret.txt")),
    `expected a native ~ spelling among ${JSON.stringify(patterns)}`,
  );
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

test("pathPatterns adds the symlink-resolved spelling", (t) => {
  if (!symlinksAvailable) {
    t.skip("symlinks unavailable on this platform");
    return;
  }
  // A rule written against the real target has to match a request that names
  // the link, otherwise a deny on `.env` is bypassed by `cat link`.
  const patterns = pathPatterns(fileLink);
  assert.ok(patterns.includes(fileLink), `expected lexical form in ${JSON.stringify(patterns)}`);
  assert.ok(
    patterns.includes(fs.realpathSync(path.join(outside, "secret.txt"))),
    `expected resolved form in ${JSON.stringify(patterns)}`,
  );
});
