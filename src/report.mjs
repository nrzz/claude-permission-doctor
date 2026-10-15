// Plain-text, markdown and JSON reports for the four commands. Text goes to a terminal (colored when
// it is one), markdown is what the skill hands to Claude, JSON is for other tools.
import { VERSION } from "./version.mjs";

export const palette = (on) => {
  const c = (code) => (s) => (on ? `\x1b[${code}m${s}\x1b[0m` : String(s));
  return { red: c(31), green: c(32), yellow: c(33), blue: c(36), dim: c(2), bold: c(1) };
};

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const pad = (s, n) => String(s).padEnd(n);
const trunc = (s, n) => (s.length > n ? `${s.slice(0, n - 3)}...` : s);
const where = (r) => `${r.display}${r.line ? `:${r.line}` : ""}`;

const VERDICT = {
  allow: { word: "runs without a prompt", tone: "green" },
  ask: { word: "prompts", tone: "yellow" },
  deny: { word: "is refused", tone: "red" },
};

// ------------------------------------------------------------------------------------------------
// show
// ------------------------------------------------------------------------------------------------

export function renderShow(m, { color = false } = {}) {
  const p = palette(color);
  const out = [];
  out.push(`${p.bold(`claude-permission-doctor ${VERSION}`)}  the permission rules that apply`);
  out.push(`project   ${m.project}`);
  out.push(`config    ${m.configDir}  ${m.configDirSource === "CLAUDE_CONFIG_DIR" ? "(from CLAUDE_CONFIG_DIR)" : "(the default; CLAUDE_CONFIG_DIR is not set)"}`);
  out.push("");
  out.push("Settings files, highest precedence first (deny beats ask beats allow, in whatever file)");
  const w = Math.max(...m.files.map((f) => f.display.length));
  for (const f of m.files) {
    const state = !f.exists ? p.dim("not found") : f.error ? p.red(f.error) : `${f.counts ? plural(f.counts.allow, "allow", "allow") : "0 allow"}, ${f.counts ? f.counts.ask : 0} ask, ${f.counts ? f.counts.deny : 0} deny`;
    out.push(`  ${pad(f.scope, 8)} ${pad(f.display, w)}  ${state}`);
  }
  const valid = m.rules.filter((r) => r.valid);
  for (const behavior of ["deny", "ask", "allow"]) {
    const list = valid.filter((r) => r.behavior === behavior);
    out.push("");
    out.push(`${p.bold(behavior)} (${list.length})${list.length ? "" : p.dim("  none")}`);
    const rw = Math.min(46, Math.max(10, ...list.map((r) => r.rule.length)));
    for (const r of list) {
      const flag = r.ignored ? p.yellow(`  ignored: ${r.ignored}`) : "";
      out.push(`  ${pad(trunc(r.rule, rw), rw)}  ${pad(r.scope, 8)} ${where(r)}${flag}`);
      if (r.overriddenBy) out.push(p.yellow(`      overridden by ${r.overriddenBy.behavior} ${r.overriddenBy.rule} in ${r.overriddenBy.label} (${where(r.overriddenBy)}): ${behavior === "allow" ? (r.overriddenBy.behavior === "deny" ? "it never allows anything" : "it never skips the prompt") : "it never asks"}`));
      for (const wn of r.warnings) out.push(p.yellow(`      ${wn.silent ? "pitfall" : "Claude Code warns"}: ${wn.message}`));
    }
  }
  const bad = m.rules.filter((r) => !r.valid);
  if (bad.length) {
    out.push("");
    out.push(`${p.bold("skipped by Claude Code")} (${bad.length})`);
    for (const r of bad) out.push(`  ${p.red(r.rule === "" ? "(empty)" : r.rule)}  ${r.scope} ${where(r)}: ${r.problem.message}`);
  }
  out.push("");
  out.push(`${plural(m.summary.deny, "deny rule")}, ${plural(m.summary.ask, "ask rule")}, ${plural(m.summary.allow, "allow rule")}; ${m.summary.overridden} overridden, ${m.summary.invalid} skipped`);
  if (m.notes.length) { out.push(""); for (const n of m.notes) out.push(`note: ${n}`); }
  out.push("");
  out.push("Not read by this tool:");
  for (const n of m.notRead) out.push(`  - ${n}`);
  return `${out.join("\n")}\n`;
}

// ------------------------------------------------------------------------------------------------
// why
// ------------------------------------------------------------------------------------------------

const STATUS = {
  deny: ["DENIED", "red"], ask: ["ASKS", "yellow"], allow: ["allowed", "green"], "read-only": ["read-only", "green"], "no-rule": ["NO RULE", "yellow"],
  blocked: ["unchecked", "yellow"], assign: ["fine", "dim"], inert: ["fine", "dim"],
};

export function renderWhy(m, { color = false } = {}) {
  const p = palette(color);
  const d = m.decision;
  const out = [];
  const subject = m.kind === "shell" ? `this ${m.toolName} command` : m.kind === "file" ? `this ${m.toolName === "Read" ? "read" : m.toolName === "Edit" ? "edit" : "write"}` : m.kind === "url" ? "this fetch" : `this ${m.toolName} call`;
  out.push(`${p.bold(`claude-permission-doctor ${VERSION}`)}  why ${subject} ${d.verdict === "allow" ? "runs without a prompt" : d.verdict === "ask" ? "prompts" : "is refused"}`);
  out.push(`${m.kind === "shell" ? "command" : m.kind === "file" ? "file" : m.kind === "url" ? "url" : "tool"}   ${String(m.input).split("\n").join("\n          ")}`);
  out.push(`tool      ${m.toolName}`);
  out.push(`project   ${m.project}${m.cwd !== m.project ? `  (working folder ${m.cwd})` : ""}`);
  out.push(`config    ${m.configDir}  ${m.configDirSource === "CLAUDE_CONFIG_DIR" ? "(from CLAUDE_CONFIG_DIR)" : "(the default)"}`);
  out.push(`rules     ${m.rulesRead.allow} allow, ${m.rulesRead.ask} ask, ${m.rulesRead.deny} deny, from ${plural(m.rulesRead.files, "settings file")}`);
  out.push("");
  if (m.kind === "shell" && d.parts.length) {
    const seps = d.separators.length ? ` at ${[...new Set(d.separators.map((s) => (s === "\n" ? "newline" : s)))].join(", ")}` : "";
    out.push(d.parts.length === 1 ? "One command:" : `Split into ${d.parts.length} commands${seps}:`);
    for (const part of d.parts) {
      const [word, tone] = STATUS[part.status] || [part.status || "?", "dim"];
      const ctx = part.context.length ? p.dim(`  [inside ${part.context.join(" > ")}]`) : "";
      out.push(`  ${pad(part.n, 2)} ${part.text.split("\n").join(" \\n ")}${ctx}`);
      const rule = part.rule ? `${part.rule.rule}  (${part.rule.label}, ${where(part.rule)})` : "";
      const via = part.stripped && part.stripped.length ? `  after taking off ${part.stripped.join(", ")}` : "";
      out.push(`       ${p[tone](pad(word, 9))} ${rule}${via}${part.detail && !rule ? part.detail : ""}`);
      if (part.detail && rule && part.status !== "allow") out.push(`                 ${part.detail}`);
      for (const miss of part.misses) out.push(`                 ${p.dim("-")} ${miss}`);
    }
    out.push("");
  }
  if (d.issues.length) {
    out.push("Claude Code cannot check this line before it runs, so no allow rule can cover it:");
    for (const i of d.issues) out.push(`  - ${i.text}`);
    out.push("");
  }
  const v = VERDICT[d.verdict];
  out.push(`${p.bold("Verdict")}   ${p[v.tone](`${subject} ${v.word}`)}`);
  out.push(`          ${d.summary}`);
  const several = (d.fixes || []).length > 1;
  if (several) {
    out.push("");
    out.push(`${p.bold("To stop the prompt")}   a rule for each command that has none:`);
    const w = Math.max(...d.fixes.map((f) => f.rule.length));
    for (const f of d.fixes) out.push(`          ${p.green(pad(f.rule, w))}  for ${f.for}`);
    for (const f of d.fixes) if (f.risk) out.push(p.yellow(`          careful: ${f.rule} approves every use of it, and it ${f.risk}`));
  } else if (d.fix) {
    out.push("");
    if (d.fix.rule) {
      out.push(`${p.bold(d.verdict === "ask" ? "To stop the prompt" : "Instead")}   ${p.green(d.fix.rule)}`);
      out.push(`          ${d.fix.why}`);
      if (d.fix.risk) out.push(p.yellow(`          careful: ${d.fix.rule} approves every use of it, and it ${d.fix.risk}`));
    } else {
      out.push(`${p.bold("What to change")}   ${d.fix.why}`);
    }
  }
  if (m.notes.length) { out.push(""); for (const n of m.notes) out.push(`note: ${n}`); }
  return `${out.join("\n")}\n`;
}

// ------------------------------------------------------------------------------------------------
// lint
// ------------------------------------------------------------------------------------------------

const SEV = { error: "ERROR", warn: "WARN ", note: "NOTE " };

export function renderLint(m, { color = false, fixed = null } = {}) {
  const p = palette(color);
  const out = [];
  out.push(`${p.bold(`claude-permission-doctor ${VERSION}`)}  the permission rules, checked`);
  out.push(`project   ${m.project}`);
  out.push(`config    ${m.configDir}  ${m.configDirSource === "CLAUDE_CONFIG_DIR" ? "(from CLAUDE_CONFIG_DIR)" : "(the default)"}`);
  out.push(`checked   ${plural(m.files.length, "settings file")}; ${m.scanned.runs} shell commands from ${plural(m.scanned.files, "transcript")} in the last ${m.days} days`);
  out.push("");
  if (!m.findings.length) out.push("No findings.");
  for (const f of m.findings) {
    const tone = f.severity === "error" ? "red" : f.severity === "warn" ? "yellow" : "dim";
    const at = f.display ? `${f.display}${f.line ? `:${f.line}` : ""}` : "";
    out.push(`${p[tone](SEV[f.severity])} ${pad(f.id, 26)} ${at}${f.autofix ? "  [--fix]" : ""}`);
    out.push(`      ${f.message}`);
    out.push(`      fix: ${f.fix}`);
    out.push("");
  }
  out.push(`${plural(m.summary.error, "error")}, ${plural(m.summary.warn, "warning")}, ${plural(m.summary.note, "note")}${m.summary.fixable ? `; ${m.summary.fixable} can be removed by --fix` : ""}`);
  for (const n of m.notes) out.push(`note: ${n}`);
  if (fixed) out.push("", renderFixResult(fixed, p));
  return `${out.join("\n")}\n`;
}

export function renderFixResult(result, p = palette(false)) {
  const out = [];
  if (result.dryRun) out.push(p.bold("Dry run: nothing was written. Without --dry-run, --fix would:"));
  else out.push(p.bold("Fix:"));
  if (!result.files.length) out.push("  nothing to remove");
  for (const f of result.files) {
    if (f.skipped) { out.push(`  ${f.display}: left alone (${f.skipped})`); continue; }
    out.push(`  ${f.display}: ${result.dryRun ? "would remove" : "removed"} ${plural(f.removed.length, "rule")}`);
    for (const r of f.removed) out.push(`      ${r.behavior} ${r.rule}  (${r.why})`);
    if (f.backup && !result.dryRun) out.push(`      backup: ${f.backup}`);
    if (f.backup && !result.dryRun) out.push(`      undo:   claude-permission-doctor restore "${f.path}"`);
  }
  for (const s of result.left) out.push(`  not touched: ${s}`);
  return out.join("\n");
}

// ------------------------------------------------------------------------------------------------
// suggest
// ------------------------------------------------------------------------------------------------

export function renderSuggest(m, { color = false, written = null } = {}) {
  const p = palette(color);
  const out = [];
  out.push(`${p.bold(`claude-permission-doctor ${VERSION}`)}  rules for the commands that ran without one`);
  out.push(`project   ${m.all ? "every project" : m.project}`);
  out.push(`window    the last ${m.days} days (since ${m.window.since}); ${m.stats.runs} shell commands in ${plural(m.stats.files, "transcript")}`);
  out.push("");
  if (!m.proposals.length) out.push(`No command ran ${m.min} or more times without a rule.`);
  m.proposals.forEach((g, i) => {
    out.push(`${pad(`${i + 1}.`, 4)}${pad(`${g.count}x`, 5)} ${p.green(g.rule)}${g.byHand ? p.dim(`   ${g.byHand} recorded as approved by you`) : ""}`);
    out.push(`          e.g. ${g.examples.join("  |  ")}`);
    if (g.risk) out.push(p.yellow(`          careful: this rule approves every use of ${g.key}, and it ${g.risk}`));
  });
  out.push("");
  const s = m.stats;
  out.push(`These ran without a rule. That is not the same as a prompt you approved: a mode that skips prompts runs commands too. ${s.byHand ? `${s.byHand} of the ${s.runs} are recorded as approved by a person.` : "None is recorded as approved by a person (older transcripts do not say who answered)."}`);
  const extra = [];
  if (s.below) extra.push(`${plural(s.below, "more command shape")} below the minimum of ${m.min}`);
  if (s.askRule) extra.push(`${s.askRule} that an ask rule wants to prompt for`);
  if (s.tooComplex) extra.push(`${s.tooComplex} too complex for a prefix rule (substitutions, subshells ...)`);
  if (s.outside) extra.push(`${s.outside} reaching outside the working folders (a Read or Edit rule, not a Bash one)`);
  if (s.inline) extra.push(`${s.inline} inline code (python -c, node -e)`);
  if (s.skippedAssignments) extra.push(`${s.skippedAssignments} behind a variable assignment that stops any allow rule`);
  if (extra.length) out.push(`Left out: ${extra.join("; ")}.`);
  if (written) out.push("", renderWrite(written, p));
  return `${out.join("\n")}\n`;
}

export function renderWrite(w, p = palette(false)) {
  const out = [];
  out.push(w.dryRun ? p.bold(`Dry run: nothing was written. Without --dry-run, --write ${w.scope} would add to ${w.display}:`) : p.bold(`Wrote to ${w.display}:`));
  for (const r of w.added) out.push(`  + ${r}`);
  for (const r of w.already) out.push(`  = ${r}  (already there)`);
  if (w.skipped) out.push(`  left alone: ${w.skipped}`);
  if (w.backup && !w.dryRun) { out.push(`  backup: ${w.backup}`); out.push(`  undo:   claude-permission-doctor restore "${w.path}"`); }
  return out.join("\n");
}

// ------------------------------------------------------------------------------------------------
// markdown, for the skill: short, capped, one report per command
// ------------------------------------------------------------------------------------------------

const BT = "`";

// one line of the skill's report is never longer than this, whatever a rule or a command looks like
const clip = (s, n = 320) => (s.length > n ? `${s.slice(0, n - 3)}...` : s);

/** lint as markdown, at most about `max` finding lines. */
export function markdownLint(m, { max = 24 } = {}) {
  const out = [];
  const counts = m.settings.rules.reduce((a, r) => { if (!r.problem) a[r.behavior]++; return a; }, { allow: 0, ask: 0, deny: 0 });
  out.push(`## permission-doctor lint: ${m.project}`);
  out.push(`${counts.allow} allow, ${counts.ask} ask, ${counts.deny} deny rules in ${plural(m.files.length, "settings file")}; ${m.scanned.runs} shell commands in the last ${m.days} days of transcripts.`);
  if (!m.findings.length) out.push("No findings.");
  const shown = m.findings.slice(0, max);
  for (const f of shown) {
    const at = f.display ? ` ${f.display}${f.line ? `:${f.line}` : ""}` : "";
    out.push(clip(`- ${f.severity.toUpperCase()} ${BT}${f.id}${BT}${at}: ${f.message}${f.autofix ? " (removable with --fix)" : ""}`));
  }
  if (m.findings.length > shown.length) out.push(`- ... and ${m.findings.length - shown.length} more (run ${BT}claude-permission-doctor lint${BT})`);
  for (const n of m.notes.slice(0, 3)) out.push(`- note: ${n}`);
  return `${out.join("\n")}\n`;
}

/** suggest as markdown, at most about `max` proposal lines. */
export function markdownSuggest(m, { max = 14 } = {}) {
  const out = [];
  out.push("## permission-doctor suggest: commands that ran without a rule");
  out.push(`Last ${m.days} days (since ${m.window.since}): ${m.stats.runs} shell commands; rules shown for commands seen at least ${m.min} times.`);
  if (!m.proposals.length) out.push("None.");
  const top = m.proposals.slice(0, max);
  for (const g of top) {
    out.push(clip(`- ${g.count}x ${BT}${g.rule}${BT}${g.risk ? ` (careful: ${g.risk})` : ""}${g.byHand ? `, ${g.byHand} recorded as approved by you` : ""}; e.g. ${BT}${g.examples[0]}${BT}`));
  }
  if (m.proposals.length > top.length) out.push(`- ... and ${m.proposals.length - top.length} more (run ${BT}claude-permission-doctor suggest${BT})`);
  out.push("Counts are commands that ran without a rule, not prompts you approved.");
  return `${out.join("\n")}\n`;
}
