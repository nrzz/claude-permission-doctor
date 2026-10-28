# Roadmap

What could come next. None of it is promised; all of it is open to contributors. Comment on an issue or start a [discussion](https://github.com/nrzz/claude-permission-doctor/discussions) before a large change.

- `lint --fail-on` says why the run failed, and `--json` carries the verdict (`failOn`), so a red build explains itself. This is the open good first issue: [#4](https://github.com/nrzz/claude-permission-doctor/issues/4).
- `suggest` proposes shell rules only. The transcripts also show which hosts `WebFetch` fetched and which files outside the working folders were read, so it could propose `WebFetch(domain:...)` and `Read(//...)` rules too.
- Put MCP tool rules, `Agent(...)` and `Skill(...)` rules to the real binary the way the Bash, PowerShell, Read, Edit and WebFetch rules are, and add them to `why` as verified.
