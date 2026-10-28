# Changelog

All notable changes to claude-permission-doctor are written here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

- `lint`: `--fail-on error|warn|note` exits 1 when findings of that severity or worse are present.

## [1.0.1] - 2026-10-28

- `why`, `lint` and `suggest` follow Claude Code 2.1.309 and newer: a deny or ask rule also matches a program given by its path by its name. `Bash(rm *)` now refuses `/bin/rm x`, `/usr/bin/rm x` and `./rm x`, also behind `sudo` and in a compound line, where 2.1.308 and older asked about them (bisected with 2.1.302, 2.1.307, 2.1.308, 2.1.309, 2.1.310, 2.1.311 and 2.1.312). An allow rule still matches the path as written, and a rule that names the path (`Bash(/bin/rm *)`) does not catch `rm x`. When an allow rule misses only because of the path, `why` says so. The oracle's table holds 11 new rows for it, and its row for `/bin/rm nothing` under `deny Bash(rm *)` now expects deny; CI's oracle had turned red on it with 2.1.312.
- The Windows test jobs pass again: the skill test read SKILL.md with the line endings of a Windows checkout (CRLF) since `.gitattributes` was dropped for the plugin directory.
- README: the oracle re-run on Windows with Claude Code 2.1.312, and the three Windows-only rows it disagrees on (see "What was verified").

## [1.0.0] - 2026-10-15

- First release. `show` lists every permission rule that applies (managed, user, project, local settings) with its file, line and kind, and which rule overrides it. `why` takes a command and says, part by part, which rule allows, asks or denies it or why none matched, and the one rule that would stop the prompt. `lint` finds rules Claude Code skips or ignores, duplicates, shadowed rules, dead literal rules and the `ls:*` / `ls *` mix; `--fix` removes dead and duplicate rules after a backup, `--dry-run` shows the plan. `suggest` proposes prefix rules from the commands that ran without a rule in your transcripts; `--write` adds them after a backup. `restore` puts a backup back. `--json` everywhere, `--markdown` for the skill.
- `why` also answers for Read, Edit and Write on a file, WebFetch on a URL and any other tool by name, and for PowerShell commands.
- A plugin with one user-only skill, `/permission-doctor:check`.
- Every verdict was put to Claude Code 2.1.295 through its own binary: a table of rule-and-command pairs is run against it by `test/oracle.test.mjs` (CI runs it on Linux and macOS with the npm package). Where the binary and the docs differ, the binary was followed and the README says where.

[1.0.1]: https://github.com/nrzz/claude-permission-doctor/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/nrzz/claude-permission-doctor/releases/tag/v1.0.0
