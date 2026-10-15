// Find and read every settings file that applies to a project, and list their permission rules.
//
// Files, from the highest precedence down (docs: "Settings files and who they affect"):
//   managed   managed-settings.json (+ managed-settings.d/*.json) in the system folder. Server-managed
//             settings, macOS profiles and the Windows registry are not files and are not read.
//   local     <project>/.claude/settings.local.json (in a git repository Claude Code keeps it at the
//             repository root, except on Windows and in a few other cases)
//   project   <project>/.claude/settings.json
//   user      <config folder>/settings.json, where the config folder is $CLAUDE_CONFIG_DIR or ~/.claude
// Permission rules from all of them are combined: deny beats ask beats allow, whatever the file.
//
// Nothing here writes. A file that is not valid JSON is reported and left out, as Claude Code does.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkRule, KINDS, SHELL_TOOLS } from "./rule.mjs";
import { parseContent } from "./pattern.mjs";
import { toPosix } from "./paths.mjs";

export const SCOPES = ["managed", "local", "project", "user"];

/** The folder Claude Code keeps its user settings, transcripts and plugins in. */
export function configDir(env = process.env, home = os.homedir()) {
  if (env.CLAUDE_CONFIG_DIR) return { dir: path.resolve(env.CLAUDE_CONFIG_DIR), source: "CLAUDE_CONFIG_DIR" };
  return { dir: path.join(home, ".claude"), source: "default" };
}

/** Where a machine-wide managed-settings.json lives on this system. */
export function managedDir(platform = process.platform) {
  if (platform === "win32") return "C:\\Program Files\\ClaudeCode";
  if (platform === "darwin") return "/Library/Application Support/ClaudeCode";
  return "/etc/claude-code";
}

function readJson(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT" || e.code === "ENOTDIR") return { exists: false };
    return { exists: true, error: `cannot be read (${e.code || e.message})` };
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (text.trim() === "") return { exists: true, error: "is empty", text };
  try {
    const data = JSON.parse(text);
    if (data === null || typeof data !== "object" || Array.isArray(data)) return { exists: true, error: "is not a JSON object", text };
    return { exists: true, data, text };
  } catch (e) {
    return { exists: true, error: `is not valid JSON (${String(e.message).replace(/\s+/g, " ").slice(0, 120)})`, text };
  }
}

/** The git repository root above `dir` (a worktree resolves to its main checkout), or null. */
export function gitRoot(dir) {
  let d = path.resolve(dir);
  for (let i = 0; i < 64; i++) {
    const dotgit = path.join(d, ".git");
    let st = null;
    try { st = fs.statSync(dotgit); } catch { /* not here */ }
    if (st) {
      if (st.isFile()) {
        try {
          const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotgit, "utf8"));
          if (m) {
            const gd = path.resolve(d, m[1].trim());
            const w = gd.split(path.sep).lastIndexOf("worktrees");
            if (w > 0) return path.dirname(gd.split(path.sep).slice(0, w).join(path.sep));
          }
        } catch { /* use d */ }
      }
      return d;
    }
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
  return null;
}

/**
 * Where the local settings file is, for a session started in `project`: the repository root in a git
 * repository, else the folder itself. Not at the root on Windows, when the root is the home folder, or when
 * the folder's owner is someone else. Claude Code also still reads a file older versions left in the folder.
 */
export function localSettingsPaths(project, { home = os.homedir(), platform = process.platform } = {}) {
  const own = path.join(project, ".claude", "settings.local.json");
  if (platform === "win32") return [own];
  const root = gitRoot(project);
  if (!root || path.resolve(root) === path.resolve(home)) return [own];
  try {
    const me = typeof process.getuid === "function" ? process.getuid() : null;
    if (me !== null && fs.statSync(root).uid !== me) return [own];
  } catch { /* cannot tell: use the root */ }
  const atRoot = path.join(root, ".claude", "settings.local.json");
  return atRoot === own ? [own] : [atRoot, own];
}

/** One permission rule with everything a report needs to say where it came from. */
function makeEntry(raw, behavior, file, index) {
  const check = checkRule(raw, behavior);
  const r = check.rule;
  const entry = {
    raw: typeof raw === "string" ? raw : String(raw),
    behavior,
    tool: r.tool,
    content: r.content,
    shape: r.shape,
    problem: check.problem,
    warnings: check.warnings,
    scope: file.scope,
    file: file.path,
    label: file.label,
    index,
    bare: false,
    parsed: null,
  };
  if (!check.problem) {
    if (SHELL_TOOLS.has(r.tool) && r.content !== undefined) {
      // PowerShell(:*) is accepted and matches nothing; Bash(:*) is skipped (a problem)
      entry.parsed = r.content === ":*" ? null : parseContent(r.content);
      if (r.content === "*") entry.bare = true; // Bash(*) is the same as Bash; Bash(* ) and Bash(**) are ordinary wildcard rules
    }
    if (r.content === undefined) entry.bare = true;
  }
  return entry;
}

/**
 * Read all settings that apply.
 *   project   the folder Claude Code starts in
 *   env, home, platform   injectable so tests never touch the real machine
 *   managed   override the folder searched for managed settings (tests)
 */
export function loadSettings({ project, env = process.env, home = os.homedir(), platform = process.platform, managed } = {}) {
  const cfg = configDir(env, home);
  const proj = path.resolve(project || process.cwd());
  const files = [];
  const add = (scope, label, file) => {
    const r = readJson(file);
    const f = { scope, label, path: file, exists: r.exists, error: r.error || null, data: r.data || null, text: r.text };
    files.push(f);
    return f;
  };

  const mdir = managed || env.CLAUDE_PERMISSION_DOCTOR_MANAGED_DIR || managedDir(platform);
  add("managed", "managed settings", path.join(mdir, "managed-settings.json"));
  try {
    const drop = path.join(mdir, "managed-settings.d");
    for (const name of fs.readdirSync(drop).filter((n) => n.endsWith(".json") && !n.startsWith(".")).sort()) {
      add("managed", `managed settings (${name})`, path.join(drop, name));
    }
  } catch { /* no drop-in folder */ }
  for (const p of localSettingsPaths(proj, { home, platform })) add("local", "local settings", p);
  add("project", "project settings", path.join(proj, ".claude", "settings.json"));
  add("user", "user settings", path.join(cfg.dir, "settings.json"));

  const rules = [];
  const dirs = [];
  const notes = [];
  let managedOnly = false;
  for (const f of files) {
    if (!f.data) continue;
    const perm = f.data.permissions;
    if (perm !== undefined && (perm === null || typeof perm !== "object" || Array.isArray(perm))) {
      f.error = 'has "permissions" that is not an object';
      continue;
    }
    if (f.scope === "managed" && f.data.allowManagedPermissionRulesOnly === true) managedOnly = true;
    f.defaultMode = perm && typeof perm.defaultMode === "string" ? perm.defaultMode : null;
    f.additionalDirectories = perm && Array.isArray(perm.additionalDirectories) ? perm.additionalDirectories.filter((d) => typeof d === "string") : [];
    f.counts = { allow: 0, ask: 0, deny: 0 };
    for (const behavior of KINDS) {
      const list = perm ? perm[behavior] : undefined;
      if (list === undefined) continue;
      if (!Array.isArray(list)) {
        notes.push(`${f.label}: permissions.${behavior} is not a list, so Claude Code skips it`);
        continue;
      }
      list.forEach((raw, i) => {
        const entry = makeEntry(raw, behavior, f, i);
        rules.push(entry);
        f.counts[behavior]++;
      });
    }
    for (const d of f.additionalDirectories) dirs.push(resolveDir(d, f, { cfgDir: cfg.dir, proj, home }));
  }
  if (managedOnly) {
    notes.push("managed settings set allowManagedPermissionRulesOnly: rules in the user, project and local files are ignored by Claude Code");
    for (const r of rules) if (r.scope !== "managed") r.ignored = "allowManagedPermissionRulesOnly";
  }
  return { configDir: cfg.dir, configSource: cfg.source, project: proj, home, files, rules, additionalDirectories: dirs, notes, managedOnly };
}

function resolveDir(d, file, { cfgDir, proj, home }) {
  if (d === "~" || d.startsWith("~/") || d.startsWith("~\\")) return path.join(home, d.slice(1));
  if (d.startsWith("//")) return path.resolve(d.slice(1));
  return path.resolve(file.scope === "user" ? cfgDir : proj, d);
}

/** The rules that Claude Code really applies, grouped by what they do. */
export function activeRules(settings, { tool } = {}) {
  // the rules of a loaded settings object do not change, and a history of thousands of commands asks again and again
  let byTool = ACTIVE.get(settings);
  if (!byTool) ACTIVE.set(settings, (byTool = new Map()));
  const key = tool || "";
  if (byTool.has(key)) return byTool.get(key);
  const out = { deny: [], ask: [], allow: [] };
  for (const r of settings.rules) {
    if (r.problem || r.ignored) continue;
    if (tool && r.tool !== tool) continue;
    out[r.behavior].push(r);
  }
  byTool.set(key, out);
  return out;
}

const ACTIVE = new WeakMap();

/** Display form of a settings file path: ~/... under the home folder, project-relative inside the project. */
export function shortPath(file, { home, project }) {
  const f = path.resolve(file);
  const within = (base) => {
    const rel = path.relative(base, f);
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : null;
  };
  const p = project ? within(project) : null;
  if (p) return toPosix(p);
  const h = home ? within(home) : null;
  if (h) return `~/${toPosix(h)}`;
  return toPosix(f);
}
