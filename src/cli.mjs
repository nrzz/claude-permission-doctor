// The command line: parse the arguments, run one command, print, return the exit code.
import os from "node:os";
import path from "node:path";
import { buildLint, buildShow, buildSuggest, buildWhy } from "./commands.mjs";
import { applyRemovals, addRules, planRemovals, restoreBackup } from "./fix.mjs";
import { markdownLint, markdownSuggest, palette, renderFixResult, renderLint, renderShow, renderSuggest, renderWhy, renderWrite } from "./report.mjs";
import { VERSION } from "./version.mjs";

const HELP = `claude-permission-doctor ${VERSION}: why Claude Code asked, which permission rules are dead or shadowed, and which rules your history asks for.

Usage: claude-permission-doctor <command> [options]

  show [--project <dir>]
        every permission rule that applies to the project: its file, its kind (allow, ask, deny), and
        whether another rule overrides it
  why "<command>" [--tool Bash|PowerShell] [--project <dir>]
        what happens to a shell command, subcommand by subcommand, and the one rule that would stop the prompt
  why --tool Read|Edit|Write --path <file>      the same for a file
  why --tool WebFetch --url <url>               the same for a URL
  why --tool <name>                             the same for any other tool (mcp__server__tool, WebSearch ...)
  lint [--project <dir>] [--days <n>] [--fail-on error|warn|note] [--fix] [--dry-run]
        dead, duplicate, shadowed and ignored rules; --fail-on exits 1 when findings of that severity or
        worse are present; --fix removes the dead and duplicate ones from your user and local files after a
        backup, --dry-run shows the plan only
  suggest [--project <dir>] [--days <n>] [--min <n>] [--all] [--write user|project|local [--only 1,2]] [--dry-run]
        prefix rules for the shell commands that ran without a rule, from your transcripts
  restore <settings file>
        put the newest backup (<file>.bak-permission-doctor-<timestamp>) back

Options for every command:
  --project <dir>   the folder Claude Code starts in (default: the current folder)
  --json            one JSON document on stdout
  --markdown        (lint, suggest) a short markdown report, for the /permission-doctor:check skill
  --no-color        no colour on a terminal (NO_COLOR does the same)
  -h, --help        this text
  -v, --version     the version

Defaults: --days 90, --min 3. why assumes default (Manual) permission mode.
Environment: CLAUDE_CONFIG_DIR (Claude's config folder), NO_COLOR.
It reads settings files and transcripts, writes only with --fix or --write (after a backup) and never uses the network.
`;

class UsageError extends Error {}

const COMMANDS = new Set(["show", "why", "lint", "suggest", "restore"]);
const FLAGS_WITH_VALUE = new Set(["--project", "--tool", "--path", "--url", "--days", "--min", "--write", "--only", "--fail-on"]);
const FLAGS = new Set([...FLAGS_WITH_VALUE, "--json", "--markdown", "--fix", "--dry-run", "--all", "--no-color", "-h", "--help", "-v", "--version"]);

const toolName = (t) => {
  const known = { bash: "Bash", powershell: "PowerShell", read: "Read", edit: "Edit", write: "Write", webfetch: "WebFetch" };
  return known[String(t).toLowerCase()] || String(t);
};

/** Parse argv into { command, args, flags }. */
export function parseArgs(argv) {
  const o = { command: null, positional: [], project: null, tool: null, path: null, url: null, days: 90, min: 3, write: null, only: null, failOn: null, json: false, markdown: false, fix: false, dryRun: false, all: false, help: false, version: false, noColor: false };
  const int = (name, v, lo) => {
    if (!/^\d+$/.test(String(v ?? "")) || Number(v) < lo) throw new UsageError(`${name} needs a whole number of at least ${lo}, such as ${name} ${lo === 0 ? 30 : lo}`);
    return Number(v);
  };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    let inline = null;
    if (a.startsWith("--") && a.includes("=")) { inline = a.slice(a.indexOf("=") + 1); a = a.slice(0, a.indexOf("=")); }
    if (a.startsWith("-") && a !== "-") {
      if (!FLAGS.has(a)) throw new UsageError(`unknown option ${a}`);
      let value = null;
      if (FLAGS_WITH_VALUE.has(a)) {
        value = inline !== null ? inline : argv[++i];
        if (value === undefined) throw new UsageError(`${a} needs a value`);
      } else if (inline !== null) throw new UsageError(`${a} does not take a value`);
      switch (a) {
        case "--project": o.project = value; break;
        case "--tool": o.tool = toolName(value); break;
        case "--path": o.path = value; break;
        case "--url": o.url = value; break;
        case "--days": o.days = int("--days", value, 1); break;
        case "--min": o.min = int("--min", value, 1); break;
        case "--fail-on":
          if (!["error", "warn", "note"].includes(value)) throw new UsageError("--fail-on needs error, warn or note");
          o.failOn = value;
          break;
        case "--write":
          if (!["user", "project", "local"].includes(value)) throw new UsageError("--write needs user, project or local");
          o.write = value;
          break;
        case "--only":
          if (!/^\d+(,\d+)*$/.test(value)) throw new UsageError("--only needs rule numbers from the list, such as --only 1,3");
          o.only = value.split(",").map(Number);
          break;
        case "--json": o.json = true; break;
        case "--markdown": o.markdown = true; break;
        case "--fix": o.fix = true; break;
        case "--dry-run": o.dryRun = true; break;
        case "--all": o.all = true; break;
        case "--no-color": o.noColor = true; break;
        case "-h": case "--help": o.help = true; break;
        case "-v": case "--version": o.version = true; break;
        default:
      }
      continue;
    }
    if (o.command === null && COMMANDS.has(a)) o.command = a;
    else o.positional.push(a);
  }
  if (o.json && o.markdown) throw new UsageError("--json and --markdown cannot be combined");
  return o;
}

/**
 * Run the tool. `io` lets tests capture output and fake the machine: { stdout, stderr, env, cwd, home, now }.
 * Returns the exit code: 0, or 2 for bad usage or an error.
 */
export async function main(argv, io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const env = io.env || process.env;
  const home = io.home || os.homedir();
  const cwd = io.cwd || process.cwd();
  const now = io.now ?? Date.now();

  let o;
  try {
    o = parseArgs(argv);
    if (!o.help && !o.version && o.command === null) {
      throw new UsageError(argv.length ? `unknown command ${o.positional[0] || argv[0]}` : "a command is needed");
    }
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    stderr.write(`claude-permission-doctor: ${e.message}\nTry: claude-permission-doctor --help\n`);
    return 2;
  }
  if (o.help) { stdout.write(HELP); return 0; }
  if (o.version) { stdout.write(`${VERSION}\n`); return 0; }

  const color = !!stdout.isTTY && !env.NO_COLOR && !o.noColor;
  const p = palette(color);
  const common = { project: path.resolve(cwd, o.project || "."), env, home, platform: io.platform || process.platform, managed: io.managed };
  const emit = (model, text) => stdout.write(o.json ? `${JSON.stringify(strip(model), null, 2)}\n` : text);

  try {
    if (o.failOn && o.command !== "lint") throw new UsageError("--fail-on only works with lint");
    switch (o.command) {
      case "show": {
        if (o.positional.length) throw new UsageError(`show takes no arguments (got "${o.positional[0]}")`);
        const m = buildShow(common);
        emit(m, renderShow(m, { color }));
        return 0;
      }
      case "why": {
        const tool = o.tool || "Bash";
        const shell = tool === "Bash" || tool === "PowerShell";
        let target;
        let command;
        if (shell) {
          if (o.positional.length !== 1) throw new UsageError('why needs the command in quotes, as in: why "git status && npm test"');
          command = o.positional[0];
        } else if (tool === "Read" || tool === "Edit" || tool === "Write") {
          if (!o.path) throw new UsageError(`--tool ${tool} needs --path <file>`);
          target = o.path;
        } else if (tool === "WebFetch") {
          if (!o.url) throw new UsageError("--tool WebFetch needs --url <url>");
          target = o.url;
        }
        if (!shell && o.positional.length) throw new UsageError(`why --tool ${tool} takes no command text`);
        const m = buildWhy({ ...common, tool, command, target, cwd: common.project });
        emit(m, renderWhy(m, { color }));
        return 0;
      }
      case "lint": {
        if (o.positional.length) throw new UsageError(`lint takes no arguments (got "${o.positional[0]}")`);
        if (o.dryRun && !o.fix) throw new UsageError("--dry-run only works together with --fix");
        if (o.failOn && o.fix) throw new UsageError("--fail-on and --fix cannot be combined");
        const m = buildLint({ ...common, days: o.days, now });
        let fixed = null;
        if (o.fix) {
          fixed = applyRemovals(planRemovals(m.findings), { dryRun: o.dryRun, now: new Date(now), settings: m.settings });
        }
        if (o.json) stdout.write(`${JSON.stringify(strip({ ...m, fix: fixed }), null, 2)}\n`);
        else if (o.markdown) stdout.write(markdownLint(m));
        else stdout.write(renderLint(m, { color, fixed }));
        if (o.failOn) {
          const fail =
            (o.failOn === "error" && m.summary.error > 0) ||
            (o.failOn === "warn" && (m.summary.error > 0 || m.summary.warn > 0)) ||
            (o.failOn === "note" && (m.summary.error > 0 || m.summary.warn > 0 || m.summary.note > 0));
          if (fail) return 1;
        }
        return 0;
      }
      case "suggest": {
        if (o.positional.length) throw new UsageError(`suggest takes no arguments (got "${o.positional[0]}")`);
        if (o.dryRun && !o.write) throw new UsageError("--dry-run only works together with --write");
        if (o.only && !o.write) throw new UsageError("--only only works together with --write");
        if (o.write && o.all && o.write !== "user") throw new UsageError("with --all the rules come from several projects, so only --write user makes sense");
        const m = buildSuggest({ ...common, days: o.days, min: o.min, all: o.all, now });
        let written = null;
        if (o.write) {
          const chosen = o.only ? o.only.map((n) => m.proposals[n - 1]) : m.proposals.filter((g) => !g.risk);
          if (chosen.some((g) => !g)) throw new UsageError(`--only names a rule number that is not in the list (there are ${m.proposals.length})`);
          const file = settingsPathFor(m.settings, o.write);
          written = addRules(file, chosen.map((g) => g.rule), { scope: o.write, dryRun: o.dryRun, now: new Date(now), settings: m.settings });
          written.skippedRisky = o.only ? [] : m.proposals.filter((g) => g.risk).map((g) => g.rule);
        }
        if (o.json) stdout.write(`${JSON.stringify(strip({ ...m, write: written }), null, 2)}\n`);
        else if (o.markdown) stdout.write(markdownSuggest(m));
        else {
          stdout.write(renderSuggest(m, { color }));
          if (written) {
            stdout.write(`\n${renderWrite(written, p)}\n`);
            if (written.skippedRisky.length) stdout.write(`Not written, because they approve more than one command: ${written.skippedRisky.join(", ")} (pick them with --only to write them anyway)\n`);
          }
        }
        return 0;
      }
      case "restore": {
        if (o.positional.length !== 1) throw new UsageError("restore needs the settings file to restore");
        const file = path.resolve(cwd, o.positional[0]);
        const r = restoreBackup(file, { now: new Date(now) });
        if (o.json) stdout.write(`${JSON.stringify(r, null, 2)}\n`);
        else if (!r.restored) stdout.write(`${file}: ${r.reason}\n`);
        else stdout.write(`Restored ${file} from ${r.from}${r.savedCurrent ? `\nThe file as it was is saved in ${r.savedCurrent}; run restore again to switch back.` : ""}\n`);
        return r.restored ? 0 : 2;
      }
      default:
        throw new UsageError(`unknown command ${o.command}`);
    }
  } catch (e) {
    if (e instanceof UsageError) {
      stderr.write(`claude-permission-doctor: ${e.message}\nTry: claude-permission-doctor --help\n`);
      return 2;
    }
    stderr.write(`claude-permission-doctor: ${e && e.message ? e.message : e}\n`);
    return 2;
  }
}

/** The settings file --write adds to: the user file, the project file, or the local file. */
function settingsPathFor(settings, scope) {
  // for local settings the first path listed is where Claude Code keeps the file (the repository root in a git repository)
  const file = settings.files.find((f) => f.scope === scope);
  if (!file) throw new UsageError(`no ${scope} settings file is known`);
  return file.path;
}

/** Drop the loaded settings (a large object with rule internals) before a model is written as JSON. */
function strip(model) {
  const { settings, ...rest } = model;
  void settings;
  return rest;
}
