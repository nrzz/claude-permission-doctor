// Prefix rules proposed from the shell commands that ran while no rule allowed them.
//
// The transcripts say which commands ran (a tool call with a result that is not a refusal). Each simple
// command in them is judged by the same engine as `why`, against the settings as they are now: when no
// allow rule covers it and it is not a read-only command, it is "a command that ran without a rule".
// That is not the same as "you approved it": in a mode that skips prompts, or in auto mode, nobody was
// asked. Recent transcripts say who answered (permissionDecision.source), and then the report counts
// the runs you approved by hand separately.
import { parseBash } from "./shell.mjs";
import { parsePowerShell } from "./powershell.mjs";
import { decideShell } from "./decide.mjs";
import { loadSettings } from "./settings.mjs";
import { inlineCode, operation, ruleFor } from "./propose.mjs";
import { SAFE_ENV, strippedWords } from "./wrappers.mjs";
import { readRuns, transcriptFiles } from "./transcripts.mjs";

const DAY = 86400000;

/**
 * Which shell commands ran without a rule, grouped by what they do.
 *   settings    loadSettings() for the project (judges every run unless `all`)
 *   all         read every project's transcripts, judging each against that project's own settings
 *   days, min   the window and the count a proposal needs
 *   env, home, platform   to load other projects' settings
 */
export function suggest({ settings, all = false, days = 90, min = 3, now = Date.now(), env, home, platform, managed }) {
  const sinceMs = now - days * DAY;
  const files = transcriptFiles({ configDir: settings.configDir, project: all ? null : settings.project, all, sinceMs });
  const cache = new Map();
  const settingsFor = (cwd) => {
    if (!all) return settings;
    const key = cwd || settings.project;
    if (!cache.has(key)) cache.set(key, loadSettings({ project: key, env, home, platform, managed }));
    return cache.get(key);
  };

  const judged = new Map(); // the same command is judged once
  const stats = { files: files.length, runs: 0, commands: 0, covered: 0, tooComplex: 0, askRule: 0, inline: 0, byHand: 0, skippedAssignments: 0, outside: 0 };
  const groups = new Map();
  for (const t of files) {
    for (const run of readRuns(t.file, { sinceMs })) {
      stats.runs++;
      const st = settingsFor(run.cwd);
      const ps = run.tool === "PowerShell";
      const parsed = ps ? parsePowerShell(run.command) : parseBash(run.command);
      const seen = new Set();
      for (const cmd of parsed.cmds) {
        if (!cmd.argv.length || cmd.inert) continue;
        stats.commands++;
        const cwd = run.cwd || st.project;
        const memoKey = `${run.tool}::${st.project}::${cwd}::${cmd.text}`;
        let dd = judged.get(memoKey);
        if (!dd) {
          const full = decideShell({ tool: run.tool, command: cmd.text, settings: st, cwd, home: st.home, platform: platform || process.platform });
          dd = { verdict: full.verdict, kind: full.kind };
          judged.set(memoKey, dd);
        }
        if (dd.verdict !== "ask") { stats.covered++; continue; }
        if (dd.kind === "path" || dd.kind === "cd") { stats.outside++; continue; }
        if (dd.kind === "ask-rule") { stats.askRule++; continue; }
        if (dd.kind !== "no-rule") { stats.tooComplex++; continue; }
        const words = ps ? cmd.argv.map((w) => w.value) : strippedWords(cmd, "allow");
        if (!ps && cmd.assigns.some((a) => !SAFE_ENV.has(a.raw.slice(0, a.raw.indexOf("="))))) {
          // a variable in front stops an allow rule from matching at all: no prefix rule can fix it
          stats.skippedAssignments++;
          continue;
        }
        if (inlineCode(words)) { stats.inline++; continue; }
        const op = operation(words);
        if (!op) continue;
        const key = `${run.tool}\u0000${ps ? op.key.toLowerCase() : op.key}`;
        if (seen.has(key)) continue;
        seen.add(key);
        let g = groups.get(key);
        if (!g) {
          g = { tool: run.tool, key: op.key, rule: ruleFor(run.tool, op.key), count: 0, byHand: 0, risk: op.risk, examples: [], last: "", projects: new Set() };
          groups.set(key, g);
        }
        g.count++;
        if (run.approved && run.approved.startsWith("user_")) { g.byHand++; }
        if (g.examples.length < 3 && !g.examples.includes(cmd.text)) g.examples.push(cmd.text.length > 90 ? `${cmd.text.slice(0, 87)}...` : cmd.text);
        if (run.ts > g.last) g.last = run.ts;
        g.projects.add(run.cwd || st.project);
      }
      if (run.approved && run.approved.startsWith("user_")) stats.byHand++;
    }
  }
  const proposals = [...groups.values()]
    .filter((g) => g.count >= min)
    .map((g) => ({ ...g, projects: [...g.projects] }))
    .sort((a, b) => b.count - a.count || a.rule.localeCompare(b.rule));
  const below = groups.size - proposals.length;
  return { proposals, stats: { ...stats, below }, window: { days, since: new Date(sinceMs).toISOString().slice(0, 10) } };
}
