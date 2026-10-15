# Changelog

All notable changes to claude-permission-doctor are written here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-10-15

- First release. `show` lists every permission rule that applies (managed, user, project, local settings) with its file, line and kind, and which rule overrides it. `why` takes a command and says, part by part, which rule allows, asks or denies it or why none matched, and the one rule that would stop the prompt. `lint` finds rules Claude Code skips or ignores, duplicates, shadowed rules, dead literal rules and the `ls:*` / `ls *` mix; `--fix` removes dead and duplicate rules after a backup, `--dry-run` shows the plan. `suggest` proposes prefix rules from the commands that ran without a rule in your transcripts; `--write` adds them after a backup. `restore` puts a backup back. `--json` everywhere, `--markdown` for the skill.
- `why` also answers for Read, Edit and Write on a file, WebFetch on a URL and any other tool by name, and for PowerShell commands.
- A plugin with one user-only skill, `/permission-doctor:check`.
- Every verdict was put to Claude Code 2.1.295 through its own binary: a table of rule-and-command pairs is run against it by `test/oracle.test.mjs` (CI runs it on Linux and macOS with the npm package). Where the binary and the docs differ, the binary was followed and the README says where.

[1.0.0]: https://github.com/nrzz/claude-permission-doctor/releases/tag/v1.0.0
