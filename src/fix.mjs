// The only code that writes. A settings file is the user's: back it up first (next to it, named
// <file>.bak-permission-doctor-<timestamp>), change only the list we are there for, keep every other
// byte, leave a file that is not valid JSON alone, and print what changed. `restore` puts a backup back.
import fs from "node:fs";
import path from "node:path";
import { detectIndent, editList } from "./jsonedit.mjs";
import { shortPath } from "./settings.mjs";

const two = (n) => String(n).padStart(2, "0");

/** 20261015-153012 in local time, used in backup names. */
export function stamp(d = new Date()) {
  return `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
}

const exists = (p) => {
  try { fs.statSync(p); return true; } catch { return false; }
};

/** <file>.bak-permission-doctor-<timestamp>, or with -1, -2 ... when that name is taken. */
export function backupPath(file, now = new Date()) {
  const base = `${file}.bak-permission-doctor-${stamp(now)}`;
  if (!exists(base)) return base;
  for (let i = 1; i < 1000; i++) if (!exists(`${base}-${i}`)) return `${base}-${i}`;
  return `${base}-${Date.now()}`;
}

const stripBom = (t) => (t.charCodeAt(0) === 0xfeff ? t.slice(1) : t);

function writeAtomic(file, text) {
  // a settings file that is a symlink (dotfiles managers do that) stays one: the target is replaced
  let target = file;
  let mode = null;
  try { target = fs.realpathSync(file); mode = fs.statSync(target).mode & 0o777; } catch { /* a new file */ }
  const tmp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text);
  if (mode !== null) { try { fs.chmodSync(tmp, mode); } catch { /* the file system has no modes */ } }
  try {
    fs.renameSync(tmp, target);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ }
    throw e;
  }
}

/** What --fix would remove: the findings marked as removable, grouped by file. */
export function planRemovals(findings) {
  const files = new Map();
  const left = [];
  for (const f of findings) {
    if (!f.autofix) continue;
    if (!files.has(f.file)) files.set(f.file, { path: f.file, scope: f.scope, items: [] });
    const entry = files.get(f.file);
    if (entry.items.some((i) => i.behavior === f.behavior && i.index === f.index)) continue;
    entry.items.push({ behavior: f.behavior, index: f.index, rule: f.rule, id: f.id, why: f.id === "dead-rule" ? "dead literal rule" : "duplicate" });
  }
  const removed = new Set();
  for (const entry of files.values()) for (const i of entry.items) removed.add(`${entry.path}::${i.behavior}::${i.index}`);
  for (const f of findings) {
    if (f.autofix || (f.id !== "dead-rule" && f.id !== "duplicate-rule" && f.id !== "mixed-syntax")) continue;
    if (removed.has(`${f.file}::${f.behavior}::${f.index}`)) continue; // another finding already removes this entry
    if (f.scope === "project") left.push(`${f.rule} in ${f.display || f.file}: not removed automatically, the shared project file belongs to the team`);
    else if (f.scope === "managed") left.push(`${f.rule} in ${f.display || f.file}: managed settings are not ours to edit`);
  }
  return { files: [...files.values()], left };
}

/** Remove the planned rules from their files. With dryRun nothing is written. */
export function applyRemovals(plan, { dryRun = false, now = new Date(), settings = null } = {}) {
  const result = { dryRun, files: [], left: plan.left };
  for (const f of plan.files) {
    const display = settings ? shortPath(f.path, settings) : f.path;
    const entry = { path: f.path, display, removed: f.items.map((i) => ({ behavior: i.behavior, rule: i.rule, why: i.why })), backup: null, skipped: null };
    result.files.push(entry);
    let text;
    try { text = fs.readFileSync(f.path, "utf8"); } catch (e) { entry.skipped = `cannot be read (${e.code || e.message})`; entry.removed = []; continue; }
    try { JSON.parse(stripBom(text)); } catch { entry.skipped = "it is not valid JSON, so it is left alone"; entry.removed = []; continue; }
    let next = text;
    let failed = null;
    for (const behavior of ["deny", "ask", "allow"]) {
      const idx = f.items.filter((i) => i.behavior === behavior).map((i) => i.index);
      if (!idx.length) continue;
      const edited = editList(next, ["permissions", behavior], idx);
      if (edited === null) { failed = `permissions.${behavior} is not a list it can edit`; break; }
      next = edited;
    }
    if (failed) { entry.skipped = failed; entry.removed = []; continue; }
    try { JSON.parse(stripBom(next)); } catch { entry.skipped = "the edit would not leave valid JSON, so nothing was written"; entry.removed = []; continue; }
    if (dryRun) continue;
    const backup = backupPath(f.path, now);
    fs.copyFileSync(f.path, backup);
    writeAtomic(f.path, next);
    entry.backup = backup;
  }
  return result;
}

/**
 * Append allow rules to a settings file (created when missing). Rules already in the file are not
 * added twice. Returns what happened; with dryRun nothing is written.
 */
export function addRules(file, rules, { scope, dryRun = false, now = new Date(), settings = null } = {}) {
  const out = { scope, path: file, display: settings ? shortPath(file, settings) : file, added: [], already: [], backup: null, skipped: null, dryRun };
  let text = null;
  try { text = fs.readFileSync(file, "utf8"); } catch (e) { if (e.code !== "ENOENT") { out.skipped = `cannot be read (${e.code || e.message})`; return out; } }
  let data = {};
  if (text !== null) {
    if (stripBom(text).trim() === "") { text = null; } else {
      try { data = JSON.parse(stripBom(text)); } catch { out.skipped = "it is not valid JSON, so it is left alone"; return out; }
      if (data === null || typeof data !== "object" || Array.isArray(data)) { out.skipped = "it is not a JSON object, so it is left alone"; return out; }
    }
  }
  const have = new Set(data.permissions && Array.isArray(data.permissions.allow) ? data.permissions.allow : []);
  for (const r of rules) (have.has(r) ? out.already : out.added).push(r);
  if (!out.added.length || dryRun) return out;

  let next = null;
  if (text !== null && data.permissions && Array.isArray(data.permissions.allow)) next = editList(text, ["permissions", "allow"], [], out.added);
  if (next === null) {
    // the list is not there yet: add it with the file's own indentation
    if (data.permissions === undefined) data.permissions = {};
    if (data.permissions === null || typeof data.permissions !== "object" || Array.isArray(data.permissions)) { out.skipped = '"permissions" is not an object, so it is left alone'; out.added = []; return out; }
    data.permissions.allow = [...(Array.isArray(data.permissions.allow) ? data.permissions.allow : []), ...out.added];
    const eol = text && text.includes("\r\n") ? "\r\n" : "\n";
    const bom = text && text.charCodeAt(0) === 0xfeff ? "\ufeff" : "";
    next = `${bom}${JSON.stringify(data, null, text ? detectIndent(text) : 2).replace(/\n/g, eol)}${eol}`;
  }
  try { JSON.parse(stripBom(next)); } catch { out.skipped = "the edit would not leave valid JSON, so nothing was written"; out.added = []; return out; }
  if (text !== null) {
    out.backup = backupPath(file, now);
    fs.copyFileSync(file, out.backup);
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  writeAtomic(file, next);
  return out;
}

/** Put the newest backup of a settings file back. The file as it is now is backed up first, so this can be undone too. */
export function restoreBackup(file, { now = new Date() } = {}) {
  const dir = path.dirname(file);
  const prefix = `${path.basename(file)}.bak-permission-doctor-`;
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.startsWith(prefix)).sort(); } catch { /* no folder */ }
  if (!names.length) return { restored: false, path: file, reason: "there is no backup of it (they are named <file>.bak-permission-doctor-<timestamp>)" };
  const from = path.join(dir, names[names.length - 1]);
  let current = null;
  if (exists(file)) { current = backupPath(file, now); fs.copyFileSync(file, current); }
  fs.copyFileSync(from, file);
  return { restored: true, path: file, from, savedCurrent: current, others: names.length - 1 };
}
