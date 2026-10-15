// Shared test helpers. Nothing here, and nothing in the tests, touches the real Claude config: the
// moment this file loads, every way the tool can find a config, home or managed-settings folder is
// pointed at a throwaway folder, and every project the tests build lives under the OS temp folder.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const made = [];
const cleanup = () => {
  for (const dir of made) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* the OS cleans the temp folder eventually */ }
  }
};
process.on("exit", cleanup);

/** A fresh temp folder (real path, short name). */
export function tmp(prefix = "pd-") {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  made.push(dir);
  return dir;
}

// The safety net: this process's own idea of "home", "the Claude config" and "the managed settings" is a temp folder.
const SAFE = tmp("pd-safe-");
fs.mkdirSync(path.join(SAFE, ".claude"));
Object.assign(process.env, {
  HOME: SAFE,
  USERPROFILE: SAFE,
  CLAUDE_CONFIG_DIR: path.join(SAFE, ".claude"),
  CLAUDE_PERMISSION_DOCTOR_MANAGED_DIR: path.join(SAFE, "no-managed-settings"),
  NO_COLOR: "1",
});
delete process.env.CLAUDE_PROJECT_DIR;

export const BIN = fileURLToPath(new URL("../bin/claude-permission-doctor.mjs", import.meta.url));
export const ROOT = fileURLToPath(new URL("..", import.meta.url));

const write = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value, null, 2));
  return file;
};

/**
 * A sandbox: base/proj (the project), base/cfg (Claude's config folder), base/home, base/managed.
 * Settings files are written from the options: user, project, local, managed (objects or raw text).
 * s.env() gives the environment that points everything at the sandbox.
 */
export function sandbox({ user, project, local, managed, files = {} } = {}) {
  const base = tmp();
  const s = { base, proj: path.join(base, "proj"), cfg: path.join(base, "cfg"), home: path.join(base, "home"), managedDir: path.join(base, "managed") };
  for (const d of [s.proj, s.cfg, s.home]) fs.mkdirSync(d, { recursive: true });
  s.userFile = path.join(s.cfg, "settings.json");
  s.projectFile = path.join(s.proj, ".claude", "settings.json");
  s.localFile = path.join(s.proj, ".claude", "settings.local.json");
  s.managedFile = path.join(s.managedDir, "managed-settings.json");
  if (user !== undefined) write(s.userFile, user);
  if (project !== undefined) write(s.projectFile, project);
  if (local !== undefined) write(s.localFile, local);
  if (managed !== undefined) write(s.managedFile, managed);
  for (const [rel, text] of Object.entries(files)) write(path.join(s.proj, rel), text);
  s.write = (rel, value) => write(path.join(s.proj, rel), value);
  s.read = (file) => fs.readFileSync(file, "utf8");
  s.env = (extra = {}) => ({ HOME: s.home, USERPROFILE: s.home, CLAUDE_CONFIG_DIR: s.cfg, CLAUDE_PERMISSION_DOCTOR_MANAGED_DIR: s.managedDir, NO_COLOR: "1", ...extra });
  s.io = (extra = {}) => ({ env: s.env(), home: s.home, cwd: s.proj, managed: s.managedDir, ...extra });
  s.cli = (args, extra = {}) => runCli(args, { cwd: s.proj, env: s.env(extra) });
  s.backups = (file) => fs.readdirSync(path.dirname(file)).filter((n) => n.startsWith(`${path.basename(file)}.bak-permission-doctor-`));
  return s;
}

/** Run the CLI as a separate process. */
export function runCli(args, { cwd, env = {}, input } = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd, input, encoding: "utf8", windowsHide: true, timeout: 60000,
    env: { ...process.env, NO_COLOR: "1", ...env },
  });
  return { code: r.status, out: r.stdout || "", err: r.stderr || "" };
}

/** Run main() in this process with captured output. */
export async function runMain(main, argv, io) {
  let out = "";
  let err = "";
  const code = await main(argv, { stdout: { write: (x) => { out += x; }, isTTY: false }, stderr: { write: (x) => { err += x; } }, ...io });
  return { code, out, err };
}

const DAY = 86400000;

/**
 * Write a session transcript in the shape Claude Code 2.1.295 records: each run is a tool_use record
 * and a tool_result record, the latter stamped with permissionDecision and, for a refusal, toolDenialKind.
 *   runs  [{ command, tool = "Bash", daysAgo = 1, source = "config", denial = null, failed = false, old = false }]
 *         old: leave out both stamps, as a transcript from an older version does
 */
export function writeTranscript(cfg, project, runs, { session = "s1", folder } = {}) {
  const slug = folder || project.replace(/[^a-zA-Z0-9]/g, "-");
  const dir = path.join(cfg, "projects", slug);
  fs.mkdirSync(dir, { recursive: true });
  const now = Date.now();
  const lines = [];
  let n = 0;
  for (const r of runs) {
    const id = `toolu_${session}_${++n}`;
    const ts = new Date(now - (r.daysAgo ?? 1) * DAY).toISOString();
    const tool = r.tool || "Bash";
    lines.push(JSON.stringify({ type: "assistant", timestamp: ts, cwd: project, sessionId: session, message: { role: "assistant", content: [{ type: "tool_use", id, name: tool, input: { command: r.command } }] } }));
    const denial = r.denial || null;
    const text = denial === "user-rejected" ? "This command requires approval" : denial === "permission-rule" ? `Permission to use ${tool} with command ${r.command} has been denied.` : r.failed ? "Exit code 1\nboom" : "ok";
    const rec = { type: "user", timestamp: ts, cwd: project, sessionId: session, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: !!(denial || r.failed), content: text }] } };
    if (!r.old) {
      if (denial) rec.toolDenialKind = denial;
      rec.permissionDecision = { decision: denial ? "reject" : "accept", source: r.source || "config" };
    }
    lines.push(JSON.stringify(rec));
  }
  const file = path.join(dir, `${session}.jsonl`);
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
}
