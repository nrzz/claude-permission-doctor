---
name: check
description: Review permission rules and suggest changes.
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/claude-permission-doctor.mjs" *) Bash(node ${CLAUDE_PLUGIN_ROOT}/bin/claude-permission-doctor.mjs *)
---

!`node "${CLAUDE_PLUGIN_ROOT}/bin/claude-permission-doctor.mjs" lint --project "${CLAUDE_PROJECT_DIR}" --markdown`

!`node "${CLAUDE_PLUGIN_ROOT}/bin/claude-permission-doctor.mjs" suggest --project "${CLAUDE_PROJECT_DIR}" --markdown`

In at most 10 lines: the rules worth adding and the rules worth removing, each with the settings file to put it in. Counts are commands that ran without a rule, not prompts the user approved. Edit nothing until the user agrees.
