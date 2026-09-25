# pi-extensions

Personal [pi](https://github.com/earendil-works/pi) extensions: permissions,
roles, and workflow tooling for the pi coding agent.

Early and opinionated. These are extensions I actually run, not a supported
distribution. Expect the config format to move.

## Layout

```
extensions/
  permissions/
    package.json          declares permission-gate.ts as the entry point
    permission-gate.ts    event wiring, the ask flow, /permissions
    config.ts             config loading and built-in defaults
    bash.ts               shell command analysis
```

Pi discovers a subdirectory only when it contains `index.ts`, `index.js`, or a
`package.json` with a `pi.extensions` field. The last option is why the entry
point can be named `permission-gate.ts` instead of `index.ts`.

## Install

Symlink the directory into the agent extensions folder:

```bash
ln -sfn /path/to/pi-extensions/extensions/permissions \
  ~/.pi/agent/extensions/permissions
```

Or install the package from git:

```bash
pi install git:github.com/minh/pi-extensions
```

Once it loads, `pi --help` lists the `--auto` flag.

## permissions

The `permissions` extension decides, for every tool call the model makes and
every `!` command you type, whether the action runs, prompts you, or is blocked.
The rule model follows [OpenCode's permissions](https://opencode.ai/docs/permissions/).

Each permission resolves to one of:

- `allow` runs without asking
- `ask` prompts you, then remembers an `always` choice for the session
- `deny` blocks, and nothing lifts it, not even `--auto`

### Config

User config lives at `~/.pi/agent/permissions.json`. Project config lives at
`.pi/permissions.json`. The file uses OpenCode's `permission` shape:

```jsonc
{
  "permission": {
    // Catch-all first. Specific rules after it win because the last match wins.
    "*": "ask",
    "bash": {
      "*": "ask",
      "git *": "allow",
      "git commit *": "deny",
      "git push *": "deny",
      "npm *": "allow"
    },
    "edit": {
      "*": "ask",
      "packages/web/src/content/docs/*.mdx": "allow"
    },
    "read": "allow",
    "external_directory": {
      "~/projects/personal/**": "allow"
    }
  }
}
```

`permission` can also be a single string, which applies to every tool:

```json
{ "permission": "allow" }
```

Rules are flat `{ permission, pattern, action }` entries. The last rule that
matches both the permission and the pattern wins, so put `"*"` first and the
specific rules after it. A user rule is appended after the defaults, so it
overrides a default with the same scope.

Project rules append after the user result but may only tighten it. A
repository can add a deny or turn an allow into an ask, never lift a
restriction the user set. Trusting a directory is not the same as letting it
grant itself permissions.

### Permission keys

OpenCode permissions are keyed by tool name. Pi's tool names map onto them:

| Pi tool | Permission key |
| --- | --- |
| `read` | `read` |
| `edit`, `write` | `edit` |
| `grep` | `grep` |
| `find` | `glob` |
| `ls` | `list` |
| `bash`, `powershell` | `bash` |
| anything else | the tool name |

For convenience, `find`, `ls`, `write`, and `powershell` are accepted as
aliases in config and normalized to the keys above.

The pattern matches the tool's resource:

| Permission | Pattern matches |
| --- | --- |
| `read`, `edit`, `list` | the file path |
| `glob` | the glob pattern |
| `grep` | the regex pattern |
| `bash` | the parsed command, such as `git status --porcelain` |
| `external_directory` | the path outside the working directory |
| `*` | the resource of whatever tool fired |

### Wildcards

Patterns use simple wildcard matching:

- `*` matches zero or more of any character, including `/`
- `?` matches exactly one character
- everything else matches literally

A pattern ending in `*` after a space makes the trailing part optional, so
`ls *` matches both `ls` and `ls -la`.

A pattern ending in a path wildcard also matches the directory itself, so
`~/.pi/*` and `~/.pi/**` both match `~/.pi`. Because `*` already crosses `/`,
they are equivalent. Allow the children of a folder while denying its root by
writing the child rule explicitly.

A leading `~` or `$HOME` expands to your home directory. That is most useful
for `external_directory`, where paths are absolute.

### external_directory

Any tool that touches a path outside the working directory is checked against
`external_directory` before the tool's own rule. This applies to path tools and
to paths the shell parser finds in a command.

The default is `ask`. Allow trusted trees explicitly:

```jsonc
{
  "permission": {
    "external_directory": { "~/projects/personal/**": "allow" },
    "edit": { "~/projects/personal/**": "deny" }
  }
}
```

Home expansion only changes how the pattern is written. It does not make the
path part of the workspace, so out-of-tree access still has to pass
`external_directory`.

### doom_loop

When the same tool call with identical input repeats three times in a row, the
extension asks under the `doom_loop` permission, which defaults to `ask`.
Approving once resets the counter.

### Defaults

Defaults always apply. Most permissions allow.

| Permission | Default |
| --- | --- |
| `*` | `allow` |
| `doom_loop` | `ask` |
| `external_directory` | `ask` |
| `read` | `allow`, but `*.env` and `*.env.*` deny, `*.env.example` allows |
| `edit` | `allow`, but `.git` and `.ssh` deny |
| `bash` | `allow`, but `rm`, `rmdir`, `shred`, `dd`, `truncate`, `mkfs`, `sudo`, `doas`, `(subshell)`, and `(indirect)` ask |

The `.env`, `.git`, `.ssh`, and destructive-command rules are guardrails this
extension keeps beyond OpenCode's own defaults. Any of them can be overridden
by a later user rule with the same scope.

### What ask does

The prompt offers three outcomes:

- `Allow once` runs just this request
- `Allow always` approves the request's suggested patterns for the rest of the
  session. Shell commands suggest a durable prefix such as `git status *`. Other
  tools suggest `*`, shown in the prompt as `<tool> *`. Picking this asks once
  more with the exact rules before granting them.
- `Deny` blocks the request

Requests are collapsed before prompting. Nested external folders reduce to the
outermost one, and every asking command in a compound shell line shares a single
prompt. Each command is still decided on its own, so allowing one never allows
another. A deny anywhere blocks before any prompt.

Grants live in session entries, so they disappear when the session ends and
follow branch navigation when you fork. A grant can only raise an ask to an
allow. It cannot lift a config deny.

`/permissions` lists the active grants and config paths. `/permissions clear`
drops every grant for the session. `/permissions check bash "git push x"` prints
the decision and the rules behind it.

### Log

Logging is off by default. To turn it on, set `LOG_ENABLED` to `true` in
`utils.ts`; every decision, config warning, granted rule, and doom-loop trigger
then appends a timestamped line to `<agent-dir>/permissions.log`. Writing is
best effort, so a full disk or bad permissions never changes a decision.

### Auto mode

```
pi --auto
```

Turns every remaining `ask` into an `allow`. It does not touch `deny` rules. In
a non-interactive run, `ask` resolves to `deny`, so this flag is the only way to
run unattended.

### Limits

This is a guardrail, not a security boundary. It runs in the same process as the
thing it is watching, with the same operating system permissions.

Command analysis is best-effort. `sh -c '...'`, `eval`, nested quoting, aliases,
and shell functions are not expanded. Anything that hides the real command from
inspection is surfaced as its own pattern so a rule can react to it rather than
being silently skipped:

- `(subshell)` for `$(...)`, backticks, and `${...}`
- `(indirect)` for `find -exec` and `xargs`

An `echo $(date)` will therefore ask under the default rules. Add an `allow` for
`(subshell)` if that gets in the way, and go back to a `deny` when it does not.

Extension-layer enforcement binds only processes that load the extension.
`pi -ne` disables discovered extensions, and a project-local copy does not load
until trust is granted, so an agent that can run shell commands can launch an
ungoverned `pi` unless you also gate that. Use a sandbox, container, or a
dedicated user account when you need a real boundary.

## Development

```bash
npm install
npm run check
npm test
```

`npm test` runs the unit tests with Node's built-in test runner. Type-checking
needs the `@earendil-works/pi-coding-agent` types, which are a dev dependency. At
runtime pi supplies that module itself.

## License

MIT. See [LICENSE](LICENSE).

Portions of the extension structure and defaults are derived from
[pi](https://github.com/earendil-works/pi), Copyright (c) 2025 Mario Zechner,
and from [OpenCode](https://github.com/sst/opencode), both MIT.
