# claude-permission-doctor

[![test](https://github.com/nrzz/claude-permission-doctor/actions/workflows/test.yml/badge.svg)](https://github.com/nrzz/claude-permission-doctor/actions/workflows/test.yml) [![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) ![node >= 18](https://img.shields.io/badge/node-%3E%3D18-339933.svg) ![dependencies: none](https://img.shields.io/badge/dependencies-none-brightgreen.svg) [![part of the Claude Code toolkit](https://img.shields.io/badge/Claude%20Code-toolkit-d97757.svg)](https://github.com/nrzz/claude-code-toolkit)

claude-permission-doctor tells you why Claude Code asked. It reads every settings file that applies to a project, splits a command the way Claude Code does, and names the rule that allowed, asked about or denied each part, or says why none matched and which one rule would stop the prompt. It finds the rules that do nothing (dead, repeated, hidden behind a deny or ask rule, or skipped by Claude Code without a word), and it proposes rules from the commands that ran without one in your session transcripts. It is a plain Node program that runs outside Claude, so checking your permissions costs no tokens.

## What you get

- `show`: every permission rule that applies, from the managed, user, project and local settings files, with its file and line, its kind (allow, ask, deny), and whether another rule overrides it. It says which Claude config folder it used.
- `why "<command>"`: what happens to a Bash or PowerShell command, part by part: the rule that allows, asks about or denies each one, or why no rule matched (a `*` in the wrong place, a prefix that stops short, a wrapper or a variable in front, a substitution, a path outside the working folders). It ends with the verdict and the rule that would stop the prompt. Also for a file (`--tool Read|Edit|Write --path`), a URL (`--tool WebFetch --url`) and any other tool by name.
- `lint`: rules Claude Code skips or ignores, duplicates, rules a deny or ask rule overrides, `Bash(ls:*)` next to `Bash(ls *)`, and dead rules (an exact command that was used once or never in the last 90 days). `--fix` removes the dead and duplicate ones after a backup.
- `suggest`: prefix rules for the commands that ran without a rule, grouped by program and subcommand and ordered by count. `--write` adds them to a settings file after a backup.
- `restore`: puts the newest backup of a settings file back.
- `/permission-doctor:check`, a plugin skill that hands Claude the `lint` and `suggest` reports.

## What it costs in tokens

| Part | Tokens | |
| --- | --- | --- |
| The tool: a terminal run, `--json`, `--markdown`, `--fix`, `--write`, `restore` | 0 | It reads files. It never calls Claude, never opens a network connection and starts no process |
| The skill in Claude's skill list | 0 | `/permission-doctor:check` is user-only (`disable-model-invocation: true`) and its description is 44 characters. With the plugin loaded, the request Claude Code sends the model does not mention it at all (checked, see below). `claude plugin details` estimates about 17 tokens always-on for it, which that check does not bear out |
| `/permission-doctor:check` | the two reports, then a reply of at most 10 lines | On this README's fixture (8 findings, 11 proposals) the skill puts 3,398 characters in front of Claude, about 850 tokens by characters / 4. The reports are capped at 24 findings and 14 proposals, each line clipped at 320 characters, so they cannot grow past about 50 lines and 13,000 characters (about 3,000 tokens). The biggest one I could build, with 80 findings and 40 proposals, came to 48 lines and 7,200 characters (about 1,800 tokens). The free route is the same two reports in a terminal |
| Running it in CI | 0 | |

## Install and use

From a terminal, with Node 18 or newer. There is nothing to install and no dependency:

```bash
npx -y github:nrzz/claude-permission-doctor why "git status && npm test"
```

```bash
npx -y github:nrzz/claude-permission-doctor lint
```

```bash
npx -y github:nrzz/claude-permission-doctor suggest
```

As a Claude Code plugin, in Claude Code:

```text
/plugin marketplace add nrzz/claude-code-toolkit
/plugin install permission-doctor@claude-code-toolkit
```

Then type `/permission-doctor:check`. It runs `lint` and `suggest` for the current project and answers in at most 10 lines: the rules worth adding and the rules worth removing, each with the settings file to put it in. It edits nothing until you agree. To try the plugin from a clone before it is in the marketplace: `claude --plugin-dir ./claude-permission-doctor`.

## Use

```text
claude-permission-doctor show    [--project <dir>] [--json]
claude-permission-doctor why     "<command>" [--tool Bash|PowerShell] [--project <dir>] [--json]
claude-permission-doctor why     --tool Read|Edit|Write --path <file> [--project <dir>] [--json]
claude-permission-doctor why     --tool WebFetch --url <url> [--project <dir>] [--json]
claude-permission-doctor why     --tool <name> [--project <dir>] [--json]
claude-permission-doctor lint    [--project <dir>] [--days <n>] [--json] [--markdown] [--fix [--dry-run]]
claude-permission-doctor suggest [--project <dir>] [--days <n>] [--min <n>] [--all] [--json] [--markdown] [--write user|project|local [--only 1,2] [--dry-run]]
claude-permission-doctor restore <settings file> [--json]
```

| Option | What it does |
| --- | --- |
| `--project <dir>` | The folder Claude Code starts in. Default: the current folder |
| `--tool` | `Bash` (the default) or `PowerShell` for a command; `Read`, `Edit` or `Write` with `--path`; `WebFetch` with `--url`; any other name (`WebSearch`, `mcp__server__tool`) alone |
| `--days <n>` | How far back `lint` and `suggest` read the transcripts. Default 90 |
| `--min <n>` | `suggest`: how many times a command must have run before it is proposed. Default 3 |
| `--all` | `suggest`: read every project's transcripts, each judged against that project's own settings |
| `--fix` | `lint`: remove the dead and duplicate rules from your user and local settings files, after a backup. A repeated entry inside one list of the shared project file goes too; any other copy there, and anything in managed settings, is only reported |
| `--write user|project|local` | `suggest`: add the proposed allow rules to the `user`, `project` or `local` settings file, after a backup. Rules that approve more than one command (`rm`, `git push`, `node`) are left out unless you pick them with `--only 1,2` (their numbers in the list) |
| `--dry-run` | With `--fix` or `--write`: print what would change and change nothing |
| `--json` | One JSON document on stdout, schema below |
| `--markdown` | `lint` and `suggest`: a short markdown report for the skill |
| `--no-color` | No colour on a terminal; `NO_COLOR` does the same |

Exit codes: 0 for a normal run, whatever the verdict; 2 for a usage error or a `restore` with nothing to restore. `CLAUDE_CONFIG_DIR` moves Claude's config folder, as it does for Claude Code, and the report says which folder it used. `why` assumes the default (Manual) permission mode.

### `show`

A real run on the fixture used in this README (a user file, a project file and a local file; paths shortened):

```text
$ claude-permission-doctor show
claude-permission-doctor 1.0.0  the permission rules that apply
project   ~/work/shop
config    ~/.claude  (from CLAUDE_CONFIG_DIR)

Settings files, highest precedence first (deny beats ask beats allow, in whatever file)
  managed  C:/Program Files/ClaudeCode/managed-settings.json  not found
  local    .claude/settings.local.json                        1 allow, 0 ask, 0 deny
  project  .claude/settings.json                              2 allow, 0 ask, 1 deny
  user     ~/.claude/settings.json                            12 allow, 1 ask, 2 deny

deny (3)
  Bash(git push --force *)  project  .claude/settings.json:8
  Bash(rm -rf *)            user     ~/.claude/settings.json:21
  Read(./.env)              user     ~/.claude/settings.json:22

ask (1)
  Bash(git push *)  user     ~/.claude/settings.json:18

allow (14)
  Bash(docker compose *)                   local    .claude/settings.local.json:4
  Bash(npm run *)                          project  .claude/settings.json:4
  ...
  Bash(git * main)                         user     ~/.claude/settings.json:12
      Claude Code warns: Bash(git * main) has a * before the rest of the command, so it also matches any options inserted at that position and approves them without a prompt; git options such as -c and --exec-path can run arbitrary commands
  Bash(git push origin main)               user     ~/.claude/settings.json:13
      overridden by ask Bash(git push *) in user settings (~/.claude/settings.json:18): it never skips the prompt
  ...

skipped by Claude Code (1)
  bash(make test)  user ~/.claude/settings.json:15: the tool name bash starts with a lowercase letter

3 deny rules, 1 ask rule, 14 allow rules; 1 overridden, 1 skipped

Not read by this tool:
  - server-managed settings, macOS profiles and the Windows registry (only managed-settings.json and managed-settings.d are read)
  - the --settings, --allowedTools and --disallowedTools flags, and rules added during a session
  - plugins: a plugin cannot add permission rules (its settings take only agent and subagentStatusLine); a skill's allowed-tools only pre-approves tools while that skill runs
  - hooks, which can allow or block a call at run time
```

(`...` marks lines cut from this sample.) The "Not read" list is printed every time, because a rule in one of those places can change what you see in the terminal. A plugin cannot declare permission rules; `show` says so rather than looking for them.

### `why`

```text
$ claude-permission-doctor why "npm test && git push origin main"
claude-permission-doctor 1.0.0  why this Bash command prompts
command   npm test && git push origin main
tool      Bash
project   ~/work/shop
config    ~/.claude  (from CLAUDE_CONFIG_DIR)
rules     14 allow, 1 ask, 3 deny, from 3 settings files

Split into 2 commands at &&:
  1  npm test
       allowed   Bash(npm test)  (project settings, .claude/settings.json:5)
  2  git push origin main
       ASKS      Bash(git push *)  (user settings, ~/.claude/settings.json:18)

Verdict   this Bash command prompts
          Bash(git push *) (user settings) matches git push origin main

What to change   remove Bash(git push *) in user settings
```

When no rule matches, it says what keeps the nearest rules from matching:

```text
$ claude-permission-doctor why "FOO=bar npm run build"
...
One command:
  1  FOO=bar npm run build
       NO RULE   a leading FOO= assignment stops the command from counting as read-only
                 - `Bash(npm run *)` would match without `FOO=` in front, but an allow rule does not match past an assignment of a variable that is not on Claude Code's short safe list (deny and ask rules do)

Verdict   this Bash command prompts
          no allow rule covers FOO=bar npm run build (a leading FOO= assignment stops the command from counting as read-only)

To stop the prompt   Bash(FOO=bar npm run build *)
          a prefix rule for FOO=bar npm run build
```

With several commands that have no rule, each gets its own line under "To stop the prompt", and a rule that approves more than one thing is marked (`careful: Bash(sudo systemctl restart *) approves every use of it, and it changes services`). A command Claude Code cannot check before it runs (a substitution, a variable, a subshell, `&`) lists the reasons and offers the one rule that can cover it: one that spells out the whole line. A path that leaves the working folders names the argument and says to add the folder (`/add-dir`, `permissions.additionalDirectories`) or allow reading it with a `Read(//path/**)` rule. A redirection says it needs an `Edit` rule, not a Bash one.

For a file or a URL the answer is the same shape:

```text
$ claude-permission-doctor why --tool Read --path .env
$ claude-permission-doctor why --tool WebFetch --url https://docs.example.com/page
```

### `lint`

```text
$ claude-permission-doctor lint
claude-permission-doctor 1.0.0  the permission rules, checked
project   ~/work/shop
config    ~/.claude  (from CLAUDE_CONFIG_DIR)
checked   3 settings files; 122 shell commands from 1 transcript in the last 90 days

WARN  duplicate-rule             ~/.claude/settings.json:6  [--fix]
      Bash(npm test) repeats the same rule in project settings (.claude/settings.json:5)
      fix: Remove this copy.

WARN  dead-rule                  ~/.claude/settings.json:7  [--fix]
      Bash(npm run build) matches only that exact command, never used in the last 90 days
      fix: Remove it, or turn it into a prefix rule if you run variants of it.

WARN  dead-rule                  ~/.claude/settings.json:11  [--fix]
      Bash(node scripts/release.js --dry-run) matches only that exact command, used once in the last 90 days, most likely the approval that created it
      fix: Remove it, or turn it into a prefix rule if you run variants of it.

WARN  shadowed-rule              ~/.claude/settings.json:13
      Bash(git push origin main) always prompts: it is asked about by Bash(git push *) in user settings, whichever file it is in
      fix: Delete this rule, or delete Bash(git push *) if you want no prompt.

WARN  malformed-rule             ~/.claude/settings.json:15
      bash(make test): the tool name bash starts with a lowercase letter; Claude Code skips this rule
      fix: Use Bash.

NOTE  mixed-syntax               ~/.claude/settings.json:9  [--fix]
      Bash(ls:*) means the same as Bash(ls *) in the same file (line 10): :* is the older spelling of a trailing " *"
      fix: Remove this copy.

0 errors, 7 warnings, 1 note; 5 can be removed by --fix
```

(Two more findings were cut from this sample.) `[--fix]` marks what `--fix` removes. The checks:

| Finding | What it is |
| --- | --- |
| `settings-unreadable` | A settings file that is not valid JSON. Claude Code skips the whole file, so none of its rules apply (error) |
| `malformed-rule` | A rule Claude Code skips and `claude doctor` lists as invalid: empty, parentheses that do not close, `Bash()`, a lowercase tool name, `WebFetch(example.com)` without `domain:`, `Bash(:*)`, `mcp__server(x)` |
| `unanchored-glob` | An allow rule such as `*` or `mcp__*`, which Claude Code skips; globs are for deny and ask rules, and for `mcp__server__*` |
| `wildcard-before-subcommand` | `Bash(git * main)`: the rule works, and approves any option inserted where the `*` is (`git -c core.pager=x checkout main`). Claude Code warns at startup |
| `raw-field` | A deny or ask rule such as `Bash(command:rm *)` or `Read(file_path:.env)`: it points at a field as a raw string and never matches. Claude Code warns at startup |
| `star-with-prefix`, `colon-star-not-at-end` | `Bash(git * main:*)`, `Bash(npm run test:* x)`: the `:*` prefix syntax works only at the end |
| `file-rule-not-consulted` | `Write(...)`, `Glob(...)`, `NotebookEdit(...)`: file permission checks consult `Edit(path)` and `Read(path)` rules only |
| `unknown-tool` | A deny or ask rule for a tool Claude Code does not have: probably a typo (a note, because the list of tools is a snapshot) |
| `backslash-in-path` | `Read(sub\a.txt)`: a backslash is not a folder separator in a path rule, and Claude Code says nothing. Write forward slashes. A Windows drive path (`C:\Users\me\x`) is the exception and works |
| `raw-field-allow`, `empty-prefix` | `Bash(command:x)` as an allow rule and `PowerShell(:*)`: accepted without a word and they match nothing |
| `duplicate-rule`, `mixed-syntax` | The same rule twice, in one file or two; the same rule in both spellings, `Bash(ls:*)` and `Bash(ls *)`. The copy in the more shared file stays |
| `shadowed-rule` | An allow or ask rule that a deny or ask rule covers completely, in whatever file: it never allows (or asks) anything |
| `dead-rule` | An allow rule for one exact command that ran once or never in the last `--days` days. A rule used once is most likely the approval that created it. Not reported while the file or the one use is under 14 days old, and only for exact rules: a prefix rule is never called dead |
| `managed-only` | Managed settings set `allowManagedPermissionRulesOnly`, so Claude Code ignores every rule in your own files |

Each finding is an `error`, a `warn` or a `note`. `show` marks the warnings Claude Code itself prints at startup ("Claude Code warns") and the ones it keeps quiet about ("pitfall").

`--fix --dry-run` prints the plan and writes nothing:

```text
$ claude-permission-doctor lint --fix --dry-run
...
Dry run: nothing was written. Without --dry-run, --fix would:
  ~/.claude/settings.json: would remove 5 rules
      allow Bash(npm test)  (duplicate)
      allow Bash(npm run build)  (dead literal rule)
      allow Bash(npm run lint)  (dead literal rule)
      allow Bash(node scripts/release.js --dry-run)  (dead literal rule)
      allow Bash(ls:*)  (duplicate)
```

Without `--dry-run`, each file is copied to `<file>.bak-permission-doctor-<timestamp>` (for example `settings.json.bak-permission-doctor-20261015-153012`, with `-1`, `-2` added when the name is taken), the entries are cut out of their list, and nothing else in the file changes: key order, indentation, tabs, CRLF, a byte-order mark and every other byte stay. A file that is not valid JSON is left alone and the report says so. `restore <file>` puts the newest backup back and keeps the file it replaces as a backup of its own, so a restore can be undone with another restore.

### `suggest`

```text
$ claude-permission-doctor suggest
claude-permission-doctor 1.0.0  rules for the commands that ran without one
project   ~/work/shop
window    the last 90 days (since 2026-07-17); 122 shell commands in 1 transcript

1.  11x   Bash(git commit *)   11 recorded as approved by you
          e.g. git commit -m wip
2.  9x    Bash(git add *)   9 recorded as approved by you
          e.g. git add -A
...
9.  3x    Bash(npm install *)   3 recorded as approved by you
          e.g. npm install
          careful: this rule approves every use of npm install, and it installs and runs third-party code
10. 3x    Bash(python3 manage.py *)   3 recorded as approved by you
          e.g. python3 manage.py migrate
          careful: this rule approves every use of python3 manage.py, and it runs any code
11. 3x    Bash(sudo systemctl restart *)   3 recorded as approved by you
          e.g. sudo systemctl restart nginx
          careful: this rule approves every use of sudo systemctl restart, and it changes services

These ran without a rule. That is not the same as a prompt you approved: a mode that skips prompts runs commands too. 82 of the 122 are recorded as approved by a person.
Left out: 2 that an ask rule wants to prompt for.
```

How it works: every simple command in a transcript that ran (a Bash or PowerShell call with a result that is not a refusal) is judged by the same engine as `why`, against the settings as they are now. If an allow rule covers it, it only reads, or a deny rule refuses it, it is not counted. What is left is grouped by program and subcommand (`git commit`, `npm run build`, `gh pr view`, a script by its name) and a group seen at least `--min` times becomes a prefix rule. A wrapper that allow rules do not look through is part of the rule (`sudo systemctl restart *`, `FOO=1 make build *`). Inline code (`python3 -c`, `node -e`, `bash -c`) is never turned into a prefix rule. Commands that reach outside the working folders need a `Read` or `Edit` rule or `/add-dir`, not a Bash rule, and are counted apart.

The wording is deliberate: these are commands that **ran without a rule**, not prompts you approved. In a mode that skips prompts, or with a hook, nobody was asked. Recent transcripts record who answered, and then the report counts the runs recorded as approved by a person separately. The `user_` names in that record come from Claude Code's permission results; only `config` and `reject` were seen in real transcripts when this was written (see "Not verified").

`--write user` appends the safe proposals to `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR/settings.json`) after a backup, skipping rules already there and the ones marked `careful`; `--write project` and `--write local` do the same for `.claude/settings.json` and `.claude/settings.local.json`; a file that does not exist is created. `--only 1,3` writes exactly those numbers, `careful` ones included. `--all` reads every project's transcripts and only works with `--write user`.

### The JSON documents

`--json` prints one document. Within `"schema": 1`, fields are only ever added.

```text
show     { schema, tool, version, command, project, configDir, configDirSource,
           files:   [ { scope, label, path, display, exists, valid, error, counts, defaultMode } ],
           rules:   [ { behavior, rule, tool, content, scope, label, file, display, line, valid, problem, warnings, ignored, overriddenBy } ],
           summary: { allow, ask, deny, overridden, invalid }, modes, notes, notRead }
why      { schema, tool, version, command, toolName, kind, input, project, cwd, configDir, configDirSource, rulesRead,
           decision: { verdict: "allow"|"ask"|"deny", kind, summary, rule, fix, fixes, separators, issues, problem,
                       parts: [ { n, text, context, status, rule, stripped, detail, redirect, misses } ] },
           notes, notRead }
lint     { schema, tool, version, command, project, configDir, configDirSource, days, scanned, files,
           findings: [ { id, severity, scope, file, label, behavior, rule, index, line, message, fix, autofix, display, ... } ],
           summary: { error, warn, note, fixable }, notes, fix }
suggest  { schema, tool, version, command, project, configDir, configDirSource, all, days, min, window,
           stats:     { files, runs, commands, covered, tooComplex, askRule, inline, byHand, skippedAssignments, outside, below },
           proposals: [ { tool, key, rule, count, byHand, risk, examples, last, projects } ], write }
```

- `decision.kind` says why: `deny-rule`, `ask-rule`, `tool-denied`, `allow-rule`, `read-only`, `inside` (a read in the working folders), `no-rule`, `cannot-check`, `unparseable`, `path` or `cd`. `parts[].status` is `allow`, `read-only`, `ask`, `deny`, `no-rule`, `assign` or `inert`.
- `rule` objects name the file (`file`, and `display` with `~/` and project-relative forms) and the line.
- Paths in the documents use forward slashes on every system.

## How it works

It reads, on your machine only:

- the settings files that apply: `managed-settings.json` (and `managed-settings.d/*.json`) in the system folder, `<config folder>/settings.json`, `<project>/.claude/settings.json` and `<project>/.claude/settings.local.json` (in a git repository, the local file at the repository root as Claude Code does, except on Windows);
- for `lint` and `suggest`, the session transcripts under `<config folder>/projects/<project>/`. It scans them line by line for Bash and PowerShell calls and for whether each was refused, and keeps nothing else: no chat text is printed, copied or stored.

It writes only with `lint --fix`, `suggest --write` and `restore`, as described above: a backup next to the file first, only the `allow`, `ask` or `deny` list it is there for, never a file that is not valid JSON, never managed settings, never a transcript. It makes no network request, starts no process and has no telemetry or account. The tests check the first two: a test fails if any file of the package imports anything but `node:fs`, `node:os` and `node:path`, opens a socket or starts a process.

What it assumes about Claude Code is in "What was verified" below, with how each point was checked. `why` is a prediction of the default (Manual) permission mode, from the files only; it does not know about `--allowedTools`, rules you added during a session, hooks, or an organization's server-managed settings.

## What was verified, and how

Checked on 2026-10-15 on Windows 11 with Node 24.19.0, git 2.55 and Claude Code 2.1.295. CI runs the unit tests on Linux, macOS and Windows with Node 20, 22 and 24 and on Linux with Node 18, and the oracle on Linux and macOS against the npm release of Claude Code; the badge at the top shows the latest run.

- **1,927 automated tests** (`npm test`, Node's own runner, no dependencies, about 20 seconds; on Node 20 and newer `node --test` also reports each of the six helper files under `test/` as a passing test, which is not counted here). 1,843 passed here; 83 are the oracle's and run only when `E2E_CLAUDE` names a Claude Code binary, and one (a symlink test) is skipped on Windows. They cover the rule parser and the matching forms, the Bash reader (separators, quotes, substitutions, subshells, loops, heredocs, redirections) and the PowerShell reader, the wrappers, the read-only list, the path rules, the settings loader (precedence, drop-in folders, git roots and worktrees, files of the wrong shape or not JSON), the decision and its explanations, `lint`, `suggest`, the transcript reader, the writing code (backups, formatting, symlinks, restore), the command line (every usage error), the report sizes, the package files, and random input.
- **The oracle: 1,045 pairs put to the real Claude Code binary, and all agree.** `test/oracle.test.mjs` starts a fake Messages API on 127.0.0.1, makes the real binary (`claude -p --permission-mode default`) call one tool with the input of a row of `test/oracle-table.mjs`, and reads whether the call ran, was refused by a rule or needed approval (the refusal shows up under `permission_denials`). No model is reached, no token is spent, and every run has its own throwaway `HOME`, `USERPROFILE` and `CLAUDE_CONFIG_DIR` and its own working folder. The test fails on any row where the binary and `why` disagree. The 948 rows (723 Bash, 101 Read, 12 Edit, 7 Write, 14 WebFetch, 91 PowerShell) cover: allow rules as exact, prefix (`:*`), wildcard (leading, middle, trailing, escaped); compound commands with each separator and an operator with nothing after it; deny and ask rules against every part, inside substitutions, subshells and loops, and behind each wrapper; the wrappers an allow rule looks through and the 39 environment variables it tolerates, one at a time; substitutions, variables and quoting; the read-only commands and their flags; folders, `--add-dir` and Read rules; `cd`; redirections; rules Claude Code skips; bare tool rules; Read, Edit, Write and WebFetch rules; and PowerShell (91 rows, Windows only). The same 97 rule strings that Claude Code validates are checked against `claude doctor` (which lists the skipped ones) and the startup debug log (which holds the warnings).
- **Precedence.** A user deny rule beats a project allow rule (and the project allow rule alone allows it); a local allow rule does not outrank a project ask rule (and alone it allows); a user ask rule beats a project allow rule, a local deny a user allow, a project deny a user ask, and a rule in one file covers a part of a command and a rule in another file the other part. The same for Read rules.
- **Random pairs.** Besides the table, two batches of 1,200 random rule-and-command pairs each (from a generator that is not part of this repository: one to three allow rules, sometimes a deny or an ask rule, and a command built from about 120 shapes with wrappers, separators, substitutions, loops and redirections) were run through the binary and `why`. The first agreed on 1,197, the second, with another seed and after the fixes the first one led to, on 1,198. Every disagreement is now a row of the table and is fixed.
- **Real transcripts.** The shape `suggest` reads was taken from transcripts the real binary wrote: a command that ran carries `permissionDecision` with `decision: accept` and a `source`; a refused one carries `toolDenialKind` and `decision: reject`. `test/oracle.test.mjs` generates one of each with the fake API and checks that the reader counts the first and not the second, and that the project's transcript folder is found by the name this tool computes. Transcripts from older versions, which have neither field, are recognized by the refusal sentences (`test/transcripts.test.mjs`).
- **The settings files.** Writing is tested on files with two spaces, four spaces, tabs and CRLF, with and without a byte-order mark: everything outside the edited list is byte for byte what it was, the backup is the file as it was, a second run changes nothing, a file that is not valid JSON is left alone, a symlinked settings file stays a symlink and keeps its mode, and `restore` can itself be undone. Nothing reads or writes outside temporary folders: `test/helpers.mjs` points `HOME`, `USERPROFILE`, `CLAUDE_CONFIG_DIR` and the managed-settings folder at a throwaway folder before any test runs.
- **Robustness.** 1,500 random command lines (made of shell and PowerShell fragments) go through both readers and the decision without a throw, and so do deeply nested and very long inputs (5,000 open parentheses, 20,000 pipes, a 300,000-character word), random rule strings and settings files with the wrong types everywhere. A pathological character class in a path rule (`[}-)]`) found by that fuzz test used to throw; it now matches nothing.
- **The plugin.** `claude plugin validate .claude-plugin/plugin.json` and `claude plugin validate .` pass, also with `--strict`, with Claude Code 2.1.295 and a throwaway config folder. Loaded with `--plugin-dir`, `/permission-doctor:check` ran in the real binary against the fake API: both `!` commands expanded with `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_PROJECT_DIR}` and their output was in the message the model received (3,285 characters in the skill's block, 113 in the command block). In a normal session with the plugin loaded, the request to the model contained the string `permission-doctor` zero times, in the system prompt, the tool list and the skill list alike.
- **Timings** on this machine, for a heavy user's files (300 rules, 40,000 shell commands in 400 session files, 60 MB): `show` 0.13 s, `why` 0.1 s, `lint` 1.1 s, `suggest` 5.3 s. The README's own fixture (122 commands) takes about 0.1 s for each.

### Found by the oracle, not in the docs

The permissions documentation does not say these; the binary did, and this tool follows the binary.

- A path with a `..` after a directory name (`sub/../x`) or a `//` inside it (`a//b`, `.//x`) is asked about for the commands that take file names (`ls`, `cat`, `head`, `grep`, `find`, `sed`, `rm`, `cp`, `mkdir`, `cd` ...) and for redirection targets, **whatever the rules say**: `Bash(cat *)` does not help, and neither does a rule that spells out the whole line. A leading `..` (`../work`) is judged by where it lands. A trailing `//` and the `//` of a URL are fine. A `//` anywhere in an `echo` or a `git` command stops it counting as read-only. In PowerShell any `//` or `\\` in the command is asked about, with or without a rule.
- `Bash(git * main)` is accepted and works: the `*` also matches git options. A trailing `|` is not a parse failure.
- `./.env` in a Read or Edit rule is not tied to the working folder: with the `./` off it is a bare name, which matches at any depth. `./sub/a.txt` is tied.
- A path character class has no negation: `[!t]` and `[^t]` match `!`, `^` and `t`. A drive path in a rule (`C:\Users\me\x`) works with either slash, and `//` followed by a third slash is the same as `//`. A backslash anywhere else in a path rule is not a folder separator.
- `$'...'` and `$"..."` in a Bash command always make it ask. In PowerShell every variable does, `$true`, `$false` and `$null` included, and so does a double-quoted string with a variable in it.
- `$HOME` is the one variable Bash tolerates; `$((1 + 2))` is fine.
- Which commands take file names is a fixed list: `cat head tail wc stat file strings hexdump od nl tac rev fold fmt expand unexpand column paste comm cmp diff cut pr md5sum sha1sum sha256sum base64 tsort ls jq grep egrep fgrep rg sed sort uniq find` read files, and `cp mv touch mkdir rm rmdir` write them. Their arguments get the folder, `..`, `//` and Read-deny checks. `du`, `df`, `tree`, `realpath`, `readlink`, `dirname`, `basename` and `test` are read-only and their arguments are never looked at, so `du ../x` runs without a prompt. Claude Code finds the files a command names through `env`, variables and the short list of wrappers, not through `sudo`, `xargs` or `exec`.
- A `Read(./sub/**)` deny rule also refuses the folder itself (`ls sub`, a Read of `sub`), but `./**` never matches the working folder. `find` is checked on its starting points and on the file after `-newer`, not on a `-name` pattern.
- A `cd` with an input redirection (`cd . < a.txt`) asks. A `cd` with a variable in front (`TZ=UTC cd .`) alone is fine, but next to `git` it counts as a move into another folder, and `git` after one asks.
- A command that is only assignments: one alone (`x=1`) is fine; two in one command (`A=1 B=2`), or one inside an `if`, `for` or `while`, asks. `[` and `jq` lose their read-only status behind a variable (`NODE_ENV=test [ -f a ]` asks, `NODE_ENV=test test -f a` does not), and `fd -x` and `fd -X` ask while `fd x` does not.
- A bare `Bash` allow rule skips the substitution and variable checks, and the path checks, but a line with `&` still asks when the read-only list or a prefix rule would have allowed it.
- An edit that fails Claude Code's own validation (the string is not in the file) never reaches the permission check, so a table row for Edit has to use a string that is there.

## Not verified

- **Other permission modes.** `why` assumes default (Manual) mode; `acceptEdits`, `plan`, `auto` and `bypassPermissions` were not put to the binary. `show` and `why` say when `defaultMode` is something else.
- **The read-only list is a subset.** Claude Code's own list of commands that run without a prompt is longer and decides on flags this tool does not know; a command missing from the table is reported as "not known to be read-only", never as "will prompt". The ones in the table were each run.
- **Layers that are not files.** Managed settings are read from `managed-settings.json` and its drop-in folder and tested, but not against the binary (that needs a system folder this test does not write to). Server-managed settings, macOS profiles, the Windows registry, `--settings`, `--allowedTools`, `--disallowedTools`, rules added during a session, and hooks are not read.
- **MCP tools, `Agent(...)` and `Skill(...)` rules.** `why --tool <name>` follows the documented matching and was not put to the binary.
- **Workspace trust.** The oracle accepts the trust dialog for its folder. A project allow rule in a folder you have not trusted does nothing in Claude Code; `show` and `why` say so, and cannot tell whether you accepted it.
- **Windows-only checks on other systems.** The PowerShell rows and a few Windows path rows ran on Windows only. PowerShell `&&` and `||` exist only in PowerShell 7; whether Claude Code used 5.1 or 7 on the test machine was not recorded, so no row depends on it.
- **Backslashes in path rules** other than a Windows drive path: `why` adds a note to the verdict when a rule has one, because how Claude Code reads them (a rule written as `sub\*` matched like `sub*`, `a.\txt` and `\a.txt` matched nothing) was not worked out.
- **The recorded approver.** Only `source: "config"` was seen in real transcripts. The `user_` names that `suggest` counts as "approved by you" come from Claude Code's permission result types, not from a transcript of a live prompt.
- **Other versions.** Everything above is Claude Code 2.1.295. CI runs the oracle with the latest npm release on Linux and macOS, so a later version that behaves differently shows up there as a red job.
- **The skill with a model.** It was run through the real binary at zero tokens, as above; what Claude then says about the reports was not checked.

## Files

| Path | What it is |
| --- | --- |
| `bin/claude-permission-doctor.mjs` | The command |
| `src/cli.mjs`, `src/commands.mjs` | Option parsing and exit codes; the four questions as plain objects |
| `src/settings.mjs`, `src/rule.mjs` | Finding and reading the settings files; reading one rule and the warnings Claude Code gives |
| `src/shell.mjs`, `src/powershell.mjs` | The Bash and PowerShell readers: commands, separators, and what cannot be checked |
| `src/decide.mjs`, `src/filechecks.mjs`, `src/tools.mjs` | The decision for a command, for files and redirections, and for files, URLs and other tools |
| `src/pattern.mjs`, `src/pathrules.mjs`, `src/wrappers.mjs`, `src/readonly.mjs`, `src/paths.mjs`, `src/psknow.mjs` | Rule matching; path rules; wrappers and safe variables; the read-only list; path helpers; PowerShell aliases and cmdlets |
| `src/explain.mjs`, `src/propose.mjs`, `src/overrides.mjs` | Why a near miss missed; the rule that would fix it; which rule overrides which |
| `src/lint.mjs`, `src/suggest.mjs`, `src/transcripts.mjs` | The checks; rules from history; reading transcripts |
| `src/fix.mjs`, `src/jsonedit.mjs` | The only code that writes: backups, editing one list, restore |
| `src/report.mjs` | The text, markdown and JSON reports |
| `skills/check/` | `/permission-doctor:check`, the user-only skill |
| `.claude-plugin/plugin.json` | The plugin manifest |
| `test/` | `npm test`; `oracle-table.mjs` is the table of pairs, `oracle.test.mjs` puts it to the binary |

Related: [claude-code-guardrails](https://github.com/nrzz/claude-code-guardrails) adds safety presets that stop risky commands and edits, and [claude-md-doctor](https://github.com/nrzz/claude-md-doctor) measures what your `CLAUDE.md` files cost.

## Contributing

Issues and pull requests are welcome: start with [CONTRIBUTING.md](CONTRIBUTING.md) and the [good first issues](https://github.com/nrzz/claude-permission-doctor/issues?q=is%3Aopen+label%3A%22good+first+issue%22). For a wrong verdict, send the rule and the command; that pair becomes a row of the table. Questions go to [Discussions](https://github.com/nrzz/claude-permission-doctor/discussions); security reports go through [SECURITY.md](SECURITY.md).

## Part of the Claude Code toolkit

Small, dependency-free tools that make Claude Code cheaper, safer and easier to share, all in the [Claude Code toolkit](https://github.com/nrzz/claude-code-toolkit):

- [claude-code-handover](https://github.com/nrzz/claude-code-handover): short sessions with a handover file every new session loads by itself
- [claude-code-team-sync](https://github.com/nrzz/claude-code-team-sync): share sessions, notes and team context with coworkers
- [claude-code-glow](https://github.com/nrzz/claude-code-glow): themes for the whole interface, a status line and a live HUD
- [claude-code-guardrails](https://github.com/nrzz/claude-code-guardrails): safety presets that stop risky commands and edits
- [claude-code-notify](https://github.com/nrzz/claude-code-notify): a ping when Claude needs you or finishes
- [claude-md-doctor](https://github.com/nrzz/claude-md-doctor): what your CLAUDE.md costs every session, and how to slim it
- [claude-code-starter-kits](https://github.com/nrzz/claude-code-starter-kits): a lean, safe .claude/ for your stack in one command
- [claude-session-replay](https://github.com/nrzz/claude-session-replay): search past sessions and export one as an HTML replay
- [claude-chat-ferry](https://github.com/nrzz/claude-chat-ferry): continue a Cursor or Antigravity chat in Claude Code, or hand a session to them
- [claude-cost-guard](https://github.com/nrzz/claude-cost-guard): daily and weekly token budgets with zero-token warnings
- [claude-permission-doctor](https://github.com/nrzz/claude-permission-doctor): why a permission prompt appeared, dead rules, rules from your history
- [claude-session-tidy](https://github.com/nrzz/claude-session-tidy): list, delete, keep and restore your sessions before the 30-day sweep

Set up any of them, or all of them, from one page: `npx -y github:nrzz/claude-code-toolkit` opens it with the recommended tools switched on.

If one of them saves you tokens, a star on its repository helps other people find it, and following [@nrzz](https://github.com/nrzz) on GitHub shows you new tools and releases.

## License

MIT
