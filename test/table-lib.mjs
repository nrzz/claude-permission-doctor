// Run one row of test/oracle-table.mjs through this tool (no Claude Code binary involved).
import fs from "node:fs";
import path from "node:path";
import { buildWhy } from "../src/commands.mjs";
import { prepareCase } from "./oracle-lib.mjs";

/** The row's tool input as the one string `why` takes: a command, a file or a URL. */
export const inputOf = (row) => row.input.command ?? row.input.file_path ?? row.input.url;

/** One line for a test title or a failure message: the rules, then the call. */
export function describeRow(row) {
  const rules = [];
  for (const [where, s] of Object.entries(row.settings || {})) {
    const p = (s && s.permissions) || {};
    for (const b of ["deny", "ask", "allow"]) for (const r of p[b] || []) rules.push(`${where} ${b} ${r}`);
    for (const d of p.additionalDirectories || []) rules.push(`${where} dir ${d}`);
  }
  const call = JSON.stringify(inputOf(row));
  return `${row.group}: ${rules.length ? `[${rules.join(" | ")}] ` : ""}${row.tool} ${call}`;
}

/** What `why` says for the row: the whole report (report.decision.verdict is allow, ask or deny). */
export function engineRun(row) {
  const p = prepareCase(row);
  try {
    const shell = p.c.tool === "Bash" || p.c.tool === "PowerShell";
    return buildWhy({
      tool: p.c.tool,
      command: shell ? inputOf(p.c) : undefined,
      target: shell ? undefined : inputOf(p.c),
      project: p.work,
      cwd: p.work,
      home: p.home,
      env: { CLAUDE_CONFIG_DIR: p.cfg },
      managed: path.join(p.root, "no-managed-settings"),
    });
  } finally {
    try { fs.rmSync(p.root, { recursive: true, force: true }); } catch { /* the OS cleans the temp folder eventually */ }
  }
}
