# Security policy

## Supported versions

Security fixes go into the latest release on `main`.

## Reporting a vulnerability

Please do not report a vulnerability in a public issue. Use GitHub's private reporting: [https://github.com/nrzz/claude-permission-doctor/security/advisories/new](https://github.com/nrzz/claude-permission-doctor/security/advisories/new), or the contact in the [nrzz security policy](https://github.com/nrzz/.github/blob/master/SECURITY.md). You can expect a first answer within 72 hours, and credit in the release notes if you want it.

## What this tool can and cannot protect

It reads the Claude Code settings files that apply to a project (`managed-settings.json`, the user `settings.json`, the project's `.claude/settings.json` and `.claude/settings.local.json`) and the shell commands recorded in your session transcripts under the Claude config folder (`$CLAUDE_CONFIG_DIR` or `~/.claude`). It opens no network connection, starts no process, and sends nothing anywhere: the only output is what it prints.

It writes in two places and only when you ask. `lint --fix` removes dead and duplicate rules from your user and local settings files (and a repeated entry inside one list of the shared project file), and `suggest --write` adds allow rules to the settings file you name. Both copy the file to `<file>.bak-permission-doctor-<timestamp>` first, change only the `allow`, `ask` or `deny` list they are there for, leave a file that is not valid JSON alone and say so, and have a `--dry-run`. `restore <file>` puts the newest backup back and keeps the file it replaces as a backup of its own. It never edits managed settings, never deletes a backup, and never touches a transcript.

Two limits matter. `show` and `why` explain Claude Code's rules as they were observed (see "What was verified" in the README); a verdict is a prediction, not a guard, and the tool cannot see policy that is not a file (server-managed settings, macOS profiles, the Windows registry), flags such as `--allowedTools`, or hooks. And a rule it proposes is only as safe as you make it: it marks the ones that approve more than one command (`rm`, `git push`, `node`), and `--write` leaves those out unless you pick them with `--only`.
