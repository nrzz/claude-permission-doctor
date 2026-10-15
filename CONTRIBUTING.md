# Contributing to claude-permission-doctor

Thanks for helping. claude-permission-doctor is a CLI and a Claude Code plugin with one user-only skill, part of the [Claude Code toolkit](https://github.com/nrzz/claude-code-toolkit). The bar for a change is the bar the code already meets: it works on Windows, macOS and Linux, it is tested, and it never wastes anyone's tokens.

## Start here

- **Good first issues:** [the issues labelled good first issue](https://github.com/nrzz/claude-permission-doctor/issues?q=is%3Aopen+label%3A%22good+first+issue%22), and the ideas in [ROADMAP.md](ROADMAP.md).
- **Questions and ideas:** [Discussions](https://github.com/nrzz/claude-permission-doctor/discussions).
- **Bugs:** [open an issue](https://github.com/nrzz/claude-permission-doctor/issues/new/choose) with the Claude Code version (`claude --version`), your OS, `node --version`, and the exact command and output. For a wrong verdict from `why`, add the rule and the command; that pair is the test case.

## Set up

There is nothing to install: the project has no dependencies.

```bash
git clone https://github.com/nrzz/claude-permission-doctor
cd claude-permission-doctor
npm test
```

- `node bin/claude-permission-doctor.mjs why "git status && npm test" --project <a project>` explains one command.
- `E2E_CLAUDE=claude npm test` also puts the whole table of rule-and-command pairs to the real Claude Code binary (see below).

## Where things are

| Path | What it holds |
| --- | --- |
| `bin/claude-permission-doctor.mjs` | the CLI |
| `src/` | reading the settings (`settings.mjs`, `rule.mjs`), the Bash and PowerShell readers (`shell.mjs`, `powershell.mjs`), the decision (`decide.mjs`, `readonly.mjs`, `wrappers.mjs`, `filechecks.mjs`, `pathrules.mjs`), `lint.mjs`, `suggest.mjs`, the only code that writes (`fix.mjs`, `jsonedit.mjs`) and the reports |
| `test/oracle-table.mjs` | the table of rule-and-command pairs: one row is one tool call under one set of settings, with the answer Claude Code gives |
| `test/*.test.mjs` | unit tests; `table.test.mjs` runs the table through `why`, `oracle.test.mjs` through the real binary |

## House rules

1. **No dependencies.** Node built-ins only, Node 18 or newer, ES modules (`.mjs`). A pull request that adds a package to `dependencies` will not be merged. The source imports `node:fs`, `node:os` and `node:path` and nothing else; a test fails if it opens a network connection or starts a process.
2. **Every change comes with a test**, and `npm test` passes. CI runs the suite on Windows, macOS and Linux with Node 20, 22 and 24, and on Linux with Node 18, and the oracle test on Linux and macOS with the real binary; a change that only works on one of them is not done.
3. **The binary is right.** `why` predicts what Claude Code does. When it is wrong, add the pair to `test/oracle-table.mjs` with the answer the binary gives, fix `why`, and say so in the README's "What was verified". Do not change a row to make a test pass without running it against the binary.
4. **Token cost is a feature.** It runs outside Claude; the optional skill is user-only and its report is capped. If your change puts anything new in front of Claude, say how many tokens in the pull request and update the README's "What it costs in tokens".
5. **Never touch real user data in tests.** Use a temporary folder and point `CLAUDE_CONFIG_DIR`, `HOME` and `USERPROFILE` at it, in the same command, whenever you run this tool, `claude` or anything else that reads them. Tests never read the real `~/.claude`; `test/helpers.mjs` points every way the tool finds a config folder at a throwaway one the moment it loads. Build transcripts and settings in temp folders.
6. **Settings files are the user's.** If your change writes one: back it up first, change only the list you are there for, leave a file that is not valid JSON alone, and give it a `--dry-run`.
7. **Keep the README honest.** Its "What was verified, and how" section says what was checked and what was not. If your change affects either, update it in the same pull request.

## The oracle

`test/oracle.test.mjs` starts a fake Messages API on 127.0.0.1, makes the real Claude Code binary call one tool with the input of a table row, and reads whether it ran, was refused by a rule or needed approval. No model is reached and nothing leaves your machine; every run has its own throwaway `HOME`, `USERPROFILE` and `CLAUDE_CONFIG_DIR`. Rows that run use harmless commands in a temporary folder. On Windows the Bash tool needs Git for Windows (the test finds it), and the PowerShell rows run only there.

```bash
E2E_CLAUDE=/path/to/claude node --test test/oracle.test.mjs
```

## Pull requests

- One logical change per pull request, with its test. Commit messages in the imperative mood ("Add a rule for gem push").
- Fill in the pull request template; CI must be green on every job.
- Signed commits are welcome but not required.
- Plain, specific writing in docs, messages and comments.

## Releases (maintainers)

Bump the version in `src/version.mjs`, `package.json` and `.claude-plugin/plugin.json` (`npm test` fails until every copy agrees), add a section to [CHANGELOG.md](CHANGELOG.md), tag `vX.Y.Z` and publish a GitHub release with the changelog section as its notes.

## Conduct and security

This project follows the [Code of Conduct](CODE_OF_CONDUCT.md). Report security problems privately, as [SECURITY.md](SECURITY.md) describes, never in a public issue.
