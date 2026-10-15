// The four questions, each answered as a plain object that the reports print or serialize:
// show (what rules apply), why (what happens to one command), lint (what is wrong with the rules)
// and suggest (what rules the history asks for). Nothing here prints or writes.
import os from "node:os";
import path from "node:path";
import { loadSettings, shortPath } from "./settings.mjs";
import { decideShell } from "./decide.mjs";
import { decideFetch, decideFile, decideTool } from "./tools.mjs";
import { overriddenBy } from "./overrides.mjs";
import { lintSettings, ruleLine, ruleUsage, withMtimes } from "./lint.mjs";
import { readRuns, transcriptFiles } from "./transcripts.mjs";
import { suggest } from "./suggest.mjs";
import { hasBackslashPath } from "./rule.mjs";
import { VERSION } from "./version.mjs";

const DAY = 86400000;

/** What this tool cannot see, said every time it matters. */
export const NOT_READ = [
  "server-managed settings, macOS profiles and the Windows registry (only managed-settings.json and managed-settings.d are read)",
  "the --settings, --allowedTools and --disallowedTools flags, and rules added during a session",
  "plugins: a plugin cannot add permission rules (its settings take only agent and subagentStatusLine); a skill's allowed-tools only pre-approves tools while that skill runs",
  "hooks, which can allow or block a call at run time",
];

const base = (command) => ({ schema: 1, tool: "claude-permission-doctor", version: VERSION, command });

export function loadFor(opts) {
  const { project = process.cwd(), env = process.env, home = os.homedir(), platform = process.platform, managed } = opts;
  return withMtimes(loadSettings({ project: path.resolve(project), env, home, platform, managed }));
}

const fileLine = (rule, texts) => ruleLine(texts.get(rule.file), rule.behavior, rule.raw, rule.nth ?? 0);

/** Where each rule sits in its file: number identical entries of one list, then look up the line. */
function numberRules(settings) {
  const seen = new Map();
  for (const r of settings.rules) {
    const k = `${r.file}\u0000${r.behavior}\u0000${r.raw}`;
    r.nth = seen.get(k) || 0;
    seen.set(k, r.nth + 1);
  }
  return new Map(settings.files.map((f) => [f.path, f.text]));
}

const describeRule = (settings, r, texts) => ({
  behavior: r.behavior, rule: r.raw, tool: r.tool, content: r.content === undefined ? null : r.content, scope: r.scope, label: r.label,
  file: r.file, display: shortPath(r.file, settings), line: fileLine(r, texts),
});

/** `show`: every rule that applies to the project, where it comes from, and whether another rule overrides it. */
export function buildShow(opts) {
  const settings = loadFor(opts);
  const texts = numberRules(settings);
  const live = settings.rules.filter((r) => !r.problem && !r.ignored);
  const rules = settings.rules.map((r) => {
    const o = !r.problem && !r.ignored ? overriddenBy(r, live) : null;
    return {
      ...describeRule(settings, r, texts),
      valid: !r.problem,
      problem: r.problem ? { code: r.problem.code, message: r.problem.message } : null,
      warnings: r.warnings.map((w) => ({ code: w.code, message: w.message, silent: !!w.silent })),
      ignored: r.ignored || null,
      overriddenBy: o ? describeRule(settings, o, texts) : null,
    };
  });
  const modes = settings.files.filter((f) => f.defaultMode).map((f) => ({ mode: f.defaultMode, file: f.path, display: shortPath(f.path, settings) }));
  const notes = [...settings.notes];
  if (settings.rules.some((r) => r.scope === "project" && r.behavior === "allow")) {
    notes.push("allow rules in the project's .claude/settings.json apply only after you accept the workspace trust dialog for the folder; this tool does not read Claude Code's .claude.json, where that is recorded, so it cannot tell whether you did");
  }
  if (modes.some((m) => m.mode !== "default" && m.mode !== "manual")) notes.push(`defaultMode is ${modes.map((m) => m.mode).join(", ")}: the other permission modes change what prompts, and why assumes default (Manual) mode`);
  const counts = { allow: 0, ask: 0, deny: 0 };
  for (const r of rules) if (r.valid) counts[r.behavior]++;
  return {
    ...base("show"),
    project: settings.project.split(path.sep).join("/"),
    configDir: settings.configDir.split(path.sep).join("/"),
    configDirSource: settings.configSource,
    files: settings.files.map((f) => ({
      scope: f.scope, label: f.label, path: f.path, display: shortPath(f.path, settings), exists: f.exists, valid: f.exists ? !f.error : null, error: f.error,
      counts: f.counts || null, defaultMode: f.defaultMode || null,
    })),
    modes,
    rules,
    summary: { ...counts, overridden: rules.filter((r) => r.overriddenBy).length, invalid: rules.filter((r) => !r.valid).length },
    notes,
    notRead: NOT_READ,
  };
}

/** `why`: what happens to one command (or file, or URL), and the rules behind it. */
export function buildWhy(opts) {
  const { tool = "Bash", command, target, cwd } = opts;
  const settings = loadFor(opts);
  const texts = numberRules(settings);
  const here = path.resolve(cwd || opts.project || process.cwd());
  const describe = (r) => (r ? describeRule(settings, r, texts) : null);
  let decision;
  let kind = "shell";
  if (tool === "Bash" || tool === "PowerShell") {
    decision = decideShell({ tool, command, settings, cwd: here, home: settings.home });
  } else if (tool === "Read" || tool === "Edit" || tool === "Write") {
    kind = "file";
    decision = decideFile({ tool, file: target, settings, cwd: here, home: settings.home });
  } else if (tool === "WebFetch") {
    kind = "url";
    decision = decideFetch({ url: target, settings });
  } else {
    kind = "tool";
    decision = decideTool({ tool, settings });
  }
  const notes = [...(decision.notes || []), ...settings.notes];
  const slashed = kind === "url" || kind === "tool" ? [] : settings.rules.filter((r) => !r.problem && !r.ignored && hasBackslashPath(r.tool, r.content));
  if (slashed.length) notes.push(`${slashed.map((r) => r.raw).join(", ")} ${slashed.length === 1 ? "has" : "have"} a backslash: Claude Code does not read it as a folder separator and this tool does not model what it does read it as, so a verdict that depends on ${slashed.length === 1 ? "that rule" : "those rules"} may be wrong`);
  const modes = settings.files.filter((f) => f.defaultMode && f.defaultMode !== "default" && f.defaultMode !== "manual").map((f) => f.defaultMode);
  if (modes.length) notes.push(`your settings set defaultMode ${modes.join(", ")}; this verdict is for default (Manual) mode`);
  if (decision.rule && decision.rule.scope === "project" && decision.rule.behavior === "allow") notes.push("this allow rule is in project settings, which Claude Code applies only after you accept the workspace trust dialog");
  const counts = { allow: 0, ask: 0, deny: 0 };
  for (const r of settings.rules) if (!r.problem && !r.ignored) counts[r.behavior]++;
  return {
    ...base("why"),
    toolName: tool,
    kind,
    input: command !== undefined ? command : target,
    project: settings.project.split(path.sep).join("/"),
    cwd: here.split(path.sep).join("/"),
    configDir: settings.configDir.split(path.sep).join("/"),
    configDirSource: settings.configSource,
    rulesRead: { ...counts, files: settings.files.filter((f) => f.exists && !f.error).length },
    decision: {
      verdict: decision.verdict,
      kind: decision.kind,
      summary: decision.summary,
      rule: describe(decision.rule),
      fix: decision.fix ? { rule: decision.fix.rule || null, why: decision.fix.why, risk: decision.fix.risk || null } : null,
      fixes: (decision.fixes || []).map((f) => ({ rule: f.rule, why: f.why, risk: f.risk || null, for: f.part })),
      separators: decision.separators || [],
      issues: (decision.issues || []).map((i) => ({ kind: i.kind, text: i.text })),
      problem: decision.problem || null,
      parts: (decision.parts || []).map((p, i) => ({
        n: i + 1, text: p.text, context: p.ctx, status: p.status, rule: describe(p.rule), stripped: p.via ? p.via.stripped : [], detail: p.detail || "",
        redirect: p.redirect ? { target: p.redirect.target, behavior: p.redirect.behavior } : null, misses: p.misses || [],
      })),
    },
    notes,
    notRead: NOT_READ,
  };
}

/** `lint`: what is wrong with the rules, using the transcripts of the last `days` days to find dead ones. */
export function buildLint(opts) {
  const { days = 90, now = Date.now(), transcripts = true } = opts;
  const settings = loadFor(opts);
  numberRules(settings);
  let usage = null;
  let scanned = { files: 0, runs: 0 };
  if (transcripts) {
    const sinceMs = now - days * DAY;
    const mine = transcriptFiles({ configDir: settings.configDir, project: settings.project, sinceMs });
    const everyone = transcriptFiles({ configDir: settings.configDir, all: true, sinceMs });
    const projectRuns = mine.flatMap((t) => readRuns(t.file, { sinceMs }));
    const allRuns = everyone.length === mine.length ? projectRuns : everyone.flatMap((t) => readRuns(t.file, { sinceMs }));
    scanned = { files: everyone.length, runs: allRuns.length };
    if (everyone.length) {
      // user rules apply in every project, project and local rules in this one
      const forUser = ruleUsage({ rules: settings.rules.filter((r) => r.scope === "user") }, allRuns);
      const forProject = ruleUsage({ rules: settings.rules.filter((r) => r.scope !== "user") }, projectRuns);
      usage = { counted: new Map([...forUser.counted, ...forProject.counted]), note: null };
    } else {
      usage = null;
    }
  }
  const { findings, notes } = lintSettings(settings, { usage, now, days });
  if (transcripts && !usage) notes.push(`no transcripts from the last ${days} days were found under ${settings.configDir.split(path.sep).join("/")}/projects, so dead rules were not checked`);
  const summary = { error: 0, warn: 0, note: 0, fixable: 0 };
  for (const f of findings) { summary[f.severity]++; if (f.autofix) summary.fixable++; }
  return {
    ...base("lint"),
    project: settings.project.split(path.sep).join("/"),
    configDir: settings.configDir.split(path.sep).join("/"),
    configDirSource: settings.configSource,
    days,
    scanned,
    findings: findings.map((f) => ({ ...f, display: f.file ? shortPath(f.file, settings) : null })),
    summary,
    notes,
    files: settings.files.filter((f) => f.exists).map((f) => ({ scope: f.scope, path: f.path, display: shortPath(f.path, settings), valid: !f.error })),
    settings,
  };
}

/** `suggest`: prefix rules for the commands that ran without one. */
export function buildSuggest(opts) {
  const { days = 90, min = 3, all = false, now = Date.now(), env = process.env, home = os.homedir(), platform = process.platform, managed } = opts;
  const settings = loadFor(opts);
  const r = suggest({ settings, all, days, min, now, env, home, platform, managed });
  return {
    ...base("suggest"),
    project: settings.project.split(path.sep).join("/"),
    configDir: settings.configDir.split(path.sep).join("/"),
    configDirSource: settings.configSource,
    all,
    days,
    min,
    window: r.window,
    stats: r.stats,
    proposals: r.proposals,
    settings,
  };
}
