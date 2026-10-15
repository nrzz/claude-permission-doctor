// Findings about the permission rules themselves. Each has an id, a severity, the rule and the file it
// lives in, one line of message and a fix. The checks are the ones the docs and Claude Code's own
// startup warnings describe, so they lean towards staying quiet:
//
//   settings-unreadable        a settings file that is not valid JSON: Claude Code skips the whole file
//   managed-only               managed settings ignore every rule in the user, project and local files
//   malformed-rule             a rule Claude Code skips (empty, malformed, empty parentheses, lowercase tool ...)
//   unanchored-glob            an allow rule such as "*" or "mcp__*": Claude Code skips it
//   wildcard-before-subcommand an allow rule with a * where the subcommand would be (git * main)
//   raw-field                  a deny or ask rule such as Bash(command:rm *): Claude Code ignores it
//   star-with-prefix           Bash(git * main:*): the * is taken literally and the rule never matches
//   colon-star-not-at-end      Bash(git:* push): the colon is literal and the rule matches no git command
//   file-rule-not-consulted    Write(...), NotebookEdit(...), Glob(...): only Edit and Read rules count
//   unknown-tool               a deny or ask rule for a tool Claude Code does not have: a typo
//   dead-rule                  an allow rule for one exact command that was used at most once in the window
//   duplicate-rule             the same rule twice, in one file or in several
//   shadowed-rule              a rule that a deny or ask rule completely overrides
//   mixed-syntax               the same rule spelled both ways, Bash(ls:*) and Bash(ls *)
import fs from "node:fs";
import { overriddenBy, ruleKey } from "./overrides.mjs";
import { shortPath } from "./settings.mjs";
import { candidates } from "./wrappers.mjs";
import { parseBash } from "./shell.mjs";
import { parsePowerShell } from "./powershell.mjs";
import { canonicalText } from "./psknow.mjs";
import { matches, parseContent } from "./pattern.mjs";

const DAY = 86400000;
const QUIET_DAYS = 14; // a rule is not called dead while its file or its one use is younger than this

export const SEVERITY_ORDER = { error: 0, warn: 1, note: 2 };

/** Line number of a rule inside its file's text (best effort: the n-th identical entry of that list). */
export function ruleLine(text, behavior, raw, nth = 0) {
  if (!text) return null;
  const lines = text.split(/\r?\n/);
  const quoted = JSON.stringify(raw);
  let inList = false;
  let seen = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!inList) {
      if (new RegExp(`"${behavior}"\\s*:\\s*\\[`).test(l)) {
        inList = true;
        const after = l.slice(l.indexOf("[") + 1);
        if (after.includes(quoted)) { if (seen === nth) return i + 1; seen++; }
        if (after.includes("]")) inList = false;
      }
      continue;
    }
    if (l.includes(quoted)) { if (seen === nth) return i + 1; seen++; }
    if (l.includes("]")) inList = false;
  }
  return null;
}

function finding(rule, id, severity, message, fix, extra = {}) {
  return {
    id, severity, scope: rule.scope, file: rule.file, label: rule.label, behavior: rule.behavior, rule: rule.raw, index: rule.index,
    message, fix, autofix: false, ...extra,
  };
}

/**
 * Lint the rules of loaded settings.
 *   settings  loadSettings() result
 *   usage     null, or the result of ruleUsage(): how often each exact allow rule was used
 *   now       the current time (ms), injectable
 * Returns { findings, notes }.
 */
export function lintSettings(settings, { usage = null, now = Date.now(), days = 90 } = {}) {
  const findings = [];
  const notes = [...settings.notes];
  const texts = new Map(settings.files.map((f) => [f.path, f.text]));

  for (const f of settings.files) {
    if (f.exists && f.error) {
      findings.push({
        id: "settings-unreadable", severity: "error", scope: f.scope, file: f.path, label: f.label, behavior: null, rule: null, index: null,
        message: `${f.label} ${f.error}, so Claude Code skips the whole file and none of its rules apply`, fix: "Fix the JSON (settings files are strict: no comments, no trailing commas).", autofix: false,
      });
    }
  }
  if (settings.managedOnly) {
    findings.push({
      id: "managed-only", severity: "note", scope: "managed", file: settings.files.find((f) => f.scope === "managed" && f.data && f.data.allowManagedPermissionRulesOnly)?.path || null, label: "managed settings", behavior: null, rule: null, index: null,
      message: "managed settings set allowManagedPermissionRulesOnly, so Claude Code ignores every permission rule in the user, project and local files", fix: "Ask whoever manages the policy; rules in your own files have no effect.", autofix: false,
    });
  }

  const byFileKind = new Map();
  for (const r of settings.rules) {
    const k = `${r.file}\u0000${r.behavior}`;
    const n = (byFileKind.get(`${k}\u0000${r.raw}`) || 0);
    byFileKind.set(`${k}\u0000${r.raw}`, n + 1);
    r.nth = n; // which identical entry of this list it is, for the line number
  }
  const lineOf = (r) => ruleLine(texts.get(r.file), r.behavior, r.raw, r.nth);

  // 1. rules Claude Code skips or warns about
  for (const r of settings.rules) {
    if (r.problem) {
      const id = r.problem.code === "allow-glob" ? "unanchored-glob" : "malformed-rule";
      findings.push(finding(r, id, "warn", `${r.raw === "" ? "(empty)" : r.raw}: ${r.problem.message}; Claude Code skips this rule`, r.problem.fix, { line: lineOf(r), code: r.problem.code }));
      continue;
    }
    for (const w of r.warnings) {
      const severity = w.code === "unknown-tool" ? "note" : "warn";
      findings.push(finding(r, w.code, severity, w.message, w.fix, { line: lineOf(r), code: w.code, silent: !!w.silent }));
    }
  }

  const live = settings.rules.filter((r) => !r.problem && !r.ignored);

  // 2. duplicates: the same rule more than once, spelled the same way or as ls:* and ls *. Keep the copy in the
  //    file that is shared or highest (and the "ls *" spelling over "ls:*"); remove the personal one.
  const keepOrder = { managed: 0, project: 1, user: 2, local: 3 };
  const styleOrder = (r) => (r.parsed && r.parsed.type === "prefix" ? 1 : 0);
  const groups = new Map();
  for (const r of live) {
    const k = ruleKey(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const duplicateOf = new Map();
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const sorted = [...list].sort((a, b) => keepOrder[a.scope] - keepOrder[b.scope] || styleOrder(a) - styleOrder(b) || a.index - b.index);
    const keep = sorted[0];
    for (const r of sorted.slice(1)) {
      duplicateOf.set(r, keep);
      const same = r.file === keep.file;
      const removable = r.scope === "user" || r.scope === "local" || (same && r.scope === "project");
      const at = keep.file === r.file ? `line ${lineOf(keep) ?? "?"}` : `${shortPath(keep.file, settings)}${lineOf(keep) ? ":" + lineOf(keep) : ""}`;
      const respelled = r.raw !== keep.raw;
      const message = respelled
        ? `${r.raw} means the same as ${keep.raw} ${same ? "in the same file" : `in ${keep.label}`} (${at}): :* is the older spelling of a trailing " *"`
        : `${r.raw} repeats ${same ? "an earlier entry of the same list" : `the same rule in ${keep.label}`} (${at})`;
      findings.push(finding(r, respelled ? "mixed-syntax" : "duplicate-rule", respelled ? "note" : "warn", message, removable ? "Remove this copy." : "Remove one of the two copies.", { line: lineOf(r), autofix: removable, duplicateOf: keep.file }));
    }
  }

  // 3. rules a deny or ask rule completely overrides
  for (const r of live) {
    if (duplicateOf.has(r)) continue;
    const o = overriddenBy(r, live);
    if (!o) continue;
    const what = o.behavior === "deny" ? "never allows anything: it is denied" : "always prompts: it is asked about";
    findings.push(finding(r, "shadowed-rule", "warn", `${r.raw} ${what} by ${o.raw} in ${o.label}${o.file === r.file ? "" : ` (${shortPath(o.file, settings)}${lineOf(o) ? ":" + lineOf(o) : ""})`}, whichever file it is in`, r.behavior === "allow" && o.behavior === "ask" ? `Delete this rule, or delete ${o.raw} if you want no prompt.` : `Delete this rule, or narrow ${o.raw}.`, { line: lineOf(r), overriddenBy: o.raw }));
  }

  // 4. dead literal rules, when the transcripts were read (not for a copy that is already reported as a duplicate, or an overridden rule)
  if (usage) {
    const overridden = new Set(findings.filter((x) => x.id === "shadowed-rule").map((x) => `${x.file}::${x.behavior}::${x.index}`));
    for (const r of live) {
      if (r.behavior !== "allow" || !usage.counted.has(r)) continue;
      if (overridden.has(`${r.file}::${r.behavior}::${r.index}`) || duplicateOf.has(r)) continue;
      const u = usage.counted.get(r);
      if (u.count > 1) continue;
      const recentUse = u.last && now - u.last < QUIET_DAYS * DAY;
      const f = settings.files.find((x) => x.path === r.file);
      const recentFile = f && f.mtimeMs && now - f.mtimeMs < QUIET_DAYS * DAY;
      if (u.count === 1 && recentUse) continue;
      if (u.count === 0 && recentFile) continue;
      const when = u.count === 1 ? `used once in the last ${days} days, most likely the approval that created it` : `never used in the last ${days} days`;
      const removable = r.scope === "user" || r.scope === "local";
      findings.push(finding(r, "dead-rule", "warn", `${r.raw} matches only that exact command, ${when}`, "Remove it, or turn it into a prefix rule if you run variants of it.", { line: lineOf(r), uses: u.count, autofix: removable }));
    }
    if (usage.note) notes.push(usage.note);
  }

  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || String(a.file).localeCompare(String(b.file)) || (a.line || 0) - (b.line || 0));
  return { findings, notes };
}

/**
 * How often was each exact allow rule used? Counts the runs in `runs` (from the transcripts) whose
 * commands one of the exact Bash or PowerShell allow rules matches.
 * Returns { counted: Map(rule -> { count, last }), note }.
 */
export function ruleUsage(settings, runs) {
  const exact = settings.rules.filter((r) => !r.problem && !r.ignored && r.behavior === "allow" && !r.bare && r.parsed && r.parsed.type === "exact");
  const counted = new Map(exact.map((r) => [r, { count: 0, last: 0 }]));
  for (const run of runs) {
    const ps = run.tool === "PowerShell";
    const mine = exact.filter((r) => r.tool === run.tool);
    if (!mine.length) continue;
    const parsed = ps ? parsePowerShell(run.command) : parseBash(run.command);
    const texts = new Set([run.command.trim()]);
    for (const cmd of parsed.cmds) {
      if (ps) { texts.add(cmd.text); texts.add(cmd.argv.map((w) => w.value).join(" ")); continue; }
      for (const c of candidates(cmd, "allow")) texts.add(c.text);
    }
    const when = run.ts ? Date.parse(run.ts) || 0 : 0;
    for (const r of mine) {
      const p = ps ? parseContent(canonicalText(r.content)) : r.parsed;
      let hit = false;
      for (const t of texts) if (matches(p, ps ? canonicalText(t) : t, { ignoreCase: ps })) { hit = true; break; }
      if (!hit) continue;
      const u = counted.get(r);
      u.count++;
      u.last = Math.max(u.last, when);
    }
  }
  return { counted, note: null };
}

/** mtime of each settings file, for the "recently written" guard. */
export function withMtimes(settings) {
  for (const f of settings.files) {
    try { f.mtimeMs = fs.statSync(f.path).mtimeMs; } catch { f.mtimeMs = 0; }
  }
  return settings;
}
