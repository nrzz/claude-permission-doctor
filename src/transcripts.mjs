// Read the shell commands Claude ran from its transcripts: <config>/projects/<slug>/<session>.jsonl.
// A run is a Bash or PowerShell tool_use followed by its tool_result. Claude Code 2.1.295 stamps the
// result record with what was decided, which is what makes the detection exact:
//
//   toolDenialKind     "permission-rule", "user-rejected", "cancelled" or "interrupted" on a call that did not run
//   permissionDecision { decision: "accept" | "reject", source, reasonType }: where the answer came
//                      from. "config" is the rules, the read-only list or a permission mode; the
//                      "user_*" sources are a person answering a prompt.
//
// Transcripts from older versions have neither field, so a result that is an error and starts with one
// of the refusal sentences counts as a refusal too (a command that fails starts with "Exit code").
// Nothing here is ever sent anywhere, and nothing is written.
import fs from "node:fs";
import path from "node:path";

const REFUSALS = [
  "Permission to use", "Permission for this", "The user doesn't want to proceed with this tool use", "This command requires approval",
  "Claude requested permissions to use", "[Request interrupted",
];

/** The folder name Claude Code uses under projects/ for a working directory. */
export function projectSlug(p) {
  const s = String(p).replace(/[^a-zA-Z0-9]/g, "-");
  if (s.length <= 200) return s;
  let h = 0;
  for (let i = 0; i < p.length; i++) h = ((h << 5) - h + p.charCodeAt(i)) | 0;
  return `${s.slice(0, 200)}-${Math.abs(h).toString(36)}`;
}

const lower = (p) => (process.platform === "win32" ? p.toLowerCase() : p);

/** Call fn(line) for each line of a file without reading it all into memory. Stop when fn returns false. */
export function forEachLine(file, fn) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return;
  }
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    let carry = "";
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      const parts = (carry + buf.toString("utf8", 0, n)).split("\n");
      carry = parts.pop();
      for (const line of parts) if (fn(line.endsWith("\r") ? line.slice(0, -1) : line) === false) return;
    }
    if (carry) fn(carry);
  } finally {
    fs.closeSync(fd);
  }
}

const listDir = (dir) => {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
};

/**
 * The transcript files to read.
 *   project  a folder: its own sessions, and those of folders below it (same slug prefix, recorded
 *            working directory inside it); ignored with all
 *   all      every project
 *   sinceMs  skip files not touched since then
 */
export function transcriptFiles({ configDir, project, all = false, sinceMs = 0 }) {
  const base = path.join(configDir, "projects");
  const slug = project ? projectSlug(path.resolve(project)).toLowerCase() : "";
  const out = [];
  for (const d of listDir(base)) {
    if (!d.isDirectory()) continue;
    const name = d.name.toLowerCase();
    if (!all && name !== slug && !name.startsWith(`${slug}-`)) continue;
    const dir = path.join(base, d.name);
    const consider = (file) => {
      let st;
      try { st = fs.statSync(file); } catch { return; }
      if (!st.isFile() || st.mtimeMs < sinceMs) return;
      out.push({ file, slug: d.name, mtimeMs: st.mtimeMs });
    };
    for (const f of listDir(dir)) {
      if (f.isFile() && f.name.endsWith(".jsonl")) consider(path.join(dir, f.name));
      // the transcripts of the subagents a session started
      if (f.isDirectory()) for (const s of listDir(path.join(dir, f.name, "subagents"))) if (s.isFile() && s.name.endsWith(".jsonl")) consider(path.join(dir, f.name, "subagents", s.name));
    }
  }
  if (!all && project) {
    // a folder that only shares the slug prefix is another project unless its working directory is inside this one
    const root = lower(path.resolve(project));
    return out.filter((t) => {
      if (t.slug.toLowerCase() === slug) return true;
      const cwd = firstCwd(t.file);
      if (!cwd) return false;
      const c = lower(path.resolve(cwd));
      const rel = path.relative(root, c);
      return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
    });
  }
  return out;
}

function firstCwd(file) {
  let cwd = "";
  let seen = 0;
  forEachLine(file, (line) => {
    if (!line.includes('"cwd"')) return ++seen < 100;
    try {
      const j = JSON.parse(line);
      if (typeof j.cwd === "string") { cwd = j.cwd; return false; }
    } catch { /* not JSON */ }
    return ++seen < 100;
  });
  return cwd;
}

const textOf = (content) => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((b) => (b && typeof b.text === "string" ? b.text : "")).join("");
  return "";
};

/** Is this tool_result record a refusal (the command did not run)? */
export function refusal(record, block) {
  if (record.toolDenialKind) return { denied: true, by: "stamp", kind: String(record.toolDenialKind) };
  const pd = record.permissionDecision;
  if (pd && pd.decision === "reject") return { denied: true, by: "stamp", kind: "rejected" };
  if (pd && pd.decision === "accept") return { denied: false };
  if (block.is_error === true) {
    const text = textOf(block.content).trimStart();
    if (REFUSALS.some((r) => text.startsWith(r))) return { denied: true, by: "text", kind: "refused" };
  }
  return { denied: false };
}

/**
 * Every shell command that ran in a transcript file, as
 *   { tool, command, id, ts, cwd, session, approved } where approved is where the answer came from
 *   ("config", "user_temporary", "user_permanent", "hook" ...) or null when the transcript does not say.
 * Refused commands are not returned. `sinceMs` drops older records.
 */
export function readRuns(file, { sinceMs = 0 } = {}) {
  const pending = new Map();
  const runs = [];
  forEachLine(file, (line) => {
    if (!line) return true;
    if (line.includes('"tool_use"') && (line.includes('"name":"Bash"') || line.includes('"name":"PowerShell"'))) {
      let j;
      try { j = JSON.parse(line); } catch { return true; }
      if (j.type !== "assistant" || !j.message || !Array.isArray(j.message.content)) return true;
      for (const b of j.message.content) {
        if (b && b.type === "tool_use" && (b.name === "Bash" || b.name === "PowerShell") && b.input && typeof b.input.command === "string") {
          pending.set(b.id, { tool: b.name, command: b.input.command, id: b.id, ts: j.timestamp || "", cwd: j.cwd || "", session: j.sessionId || "" });
        }
      }
      return true;
    }
    if (pending.size && line.includes('"tool_result"')) {
      const m = /"tool_use_id":"([^"]+)"/.exec(line);
      if (!m || !pending.has(m[1])) return true;
      let j;
      try { j = JSON.parse(line); } catch { return true; }
      const blocks = j.message && Array.isArray(j.message.content) ? j.message.content : [];
      const block = blocks.find((b) => b && b.type === "tool_result" && b.tool_use_id === m[1]);
      const run = pending.get(m[1]);
      pending.delete(m[1]);
      if (!block) return true;
      const r = refusal(j, block);
      if (r.denied) return true;
      run.approved = j.permissionDecision && j.permissionDecision.decision === "accept" ? String(j.permissionDecision.source || "") || null : null;
      if (sinceMs && run.ts && Date.parse(run.ts) < sinceMs) return true;
      runs.push(run);
    }
    return true;
  });
  return runs;
}
