// The oracle: ask the real Claude Code binary what it does with a tool call, at zero tokens.
//
// A fake Messages API listens on 127.0.0.1. The first request of a run is answered with one tool
// call (the command or path under test); the next request carries the result Claude Code got for it,
// which tells us whether the call ran, was refused by a rule, or needed approval. `claude -p` cannot
// ask anyone, so a call that would prompt is refused and listed under `permission_denials`. Nothing
// leaves this machine and the model is never reached.
//
// Every run gets its own throwaway HOME, USERPROFILE and CLAUDE_CONFIG_DIR and its own working
// folder, so nothing in the real ~/.claude is read or written. A call that the rules allow really
// runs, in that folder: the cases must only use commands that do no harm.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const USAGE = { input_tokens: 1, output_tokens: 1 };
const IS_WIN = process.platform === "win32";

function sse(res, events) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const [event, data] of events) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  res.end();
}

const messageStart = (id, model) => ["message_start", { type: "message_start", message: { id, type: "message", role: "assistant", model: model || "x", content: [], stop_reason: null, usage: USAGE } }];

function toolUseEvents(id, model, tool, input) {
  return [
    messageStart(id, model),
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: tool, input: {} } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 1 } }],
    ["message_stop", { type: "message_stop" }],
  ];
}

function textEvents(id, model, text) {
  return [
    messageStart(id, model),
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }],
    ["message_stop", { type: "message_stop" }],
  ];
}

/** A path as Claude Code writes it in a // rule: forward slashes, and /c/Users/... for C:\Users\... on Windows. */
export const posix = (p) => String(p).replace(/^([A-Za-z]):/, (m, d) => `/${d.toLowerCase()}`).split(String.fromCharCode(92)).join("/");

/** Replace {WORK}, {HOME}, {CFG}, {ROOT} (and their _POSIX forms) in every string of a case. */
function fill(value, dirs) {
  if (typeof value === "string") {
    return value.replace(/\{(WORK|HOME|CFG|ROOT)(_POSIX)?\}/g, (m, k, p) => (p ? posix(dirs[k]) : dirs[k]));
  }
  if (Array.isArray(value)) return value.map((v) => fill(v, dirs));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [fill(k, dirs), fill(v, dirs)]));
  return value;
}

/** The tool_result for the call we made, if the request carries one. */
function findToolResult(body) {
  for (const m of body.messages || []) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) if (b && b.type === "tool_result" && b.tool_use_id === "toolu_1") return b;
  }
  return null;
}

const resultText = (tr) => (!tr ? "" : Array.isArray(tr.content) ? tr.content.map((b) => b.text || "").join("") : String(tr.content ?? ""));

const writeFile = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value, null, 2));
};

function killTree(child) {
  try {
    if (IS_WIN) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
    else process.kill(-child.pid, "SIGKILL");
  } catch {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }
}

/**
 * The environment that makes the shell tool the Bash tool. On Linux and macOS that is the default;
 * on Windows Claude Code offers PowerShell instead, unless it is turned off and Git Bash is found.
 * Returns null when no Bash tool can be had (Windows without Git for Windows).
 */
export function bashEnv() {
  if (!IS_WIN) return {};
  const candidates = [];
  const where = spawnSync("where", ["git"], { encoding: "utf8", windowsHide: true });
  for (const line of (where.stdout || "").split(/\r?\n/).filter(Boolean)) {
    candidates.push(path.join(path.dirname(line), "..", "bin", "bash.exe"), path.join(path.dirname(line), "bash.exe"));
  }
  candidates.push("C:/Program Files/Git/bin/bash.exe", "C:/Program Files (x86)/Git/bin/bash.exe");
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      return { CLAUDE_CODE_USE_POWERSHELL_TOOL: "0", CLAUDE_CODE_GIT_BASH_PATH: path.resolve(c).split(String.fromCharCode(92)).join("/") };
    }
  }
  return null;
}

/**
 * Lay a case out on disk: a fresh root with home, cfg (Claude's config folder) and work (the folder
 * Claude starts in), the settings files and the extra files of the case, and the trust that project
 * allow rules wait for. Returns { root, home, cfg, work, c } where c is the case with its {WORK},
 * {HOME}, {CFG} and {ROOT} placeholders filled in. The caller removes root.
 */
export function prepareCase(c0) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pd-oracle-")));
  const home = path.join(root, "home");
  const cfg = path.join(root, "cfg");
  const work = path.join(root, "work");
  for (const d of [home, cfg, work]) fs.mkdirSync(d, { recursive: true });
  const c = fill(c0, { WORK: work, HOME: home, CFG: cfg, ROOT: root });

  const s = c.settings || {};
  if (s.user) writeFile(path.join(cfg, "settings.json"), s.user);
  if (s.project) writeFile(path.join(work, ".claude", "settings.json"), s.project);
  if (s.local) writeFile(path.join(work, ".claude", "settings.local.json"), s.local);
  for (const [rel, text] of Object.entries(c.files || {})) writeFile(path.isAbsolute(rel) ? rel : path.join(work, rel), text);

  // Trust the working folder (project allow rules wait for that) and skip onboarding.
  const trusted = { hasTrustDialogAccepted: true, allowedTools: [] };
  writeFile(path.join(cfg, ".claude.json"), {
    hasCompletedOnboarding: true,
    projects: { [work]: trusted, [work.split(String.fromCharCode(92)).join("/")]: trusted },
  });
  return { root, home, cfg, work, c };
}

/**
 * Run one case against the real binary.
 *
 * c = {
 *   tool: "Bash" | "PowerShell" | "Read" | ...,   the tool the fake model calls
 *   input: { command } | { file_path } | ...,      its input
 *   settings: { user, project, local },            each a settings object (or raw text), optional
 *   files: { "rel/path": "text" },                 extra files in the working folder
 *   env: {}, args: [], mode: "default",            extra environment variables, claude arguments, permission mode
 * }
 *
 * Returns { outcome, text, isError, denials, tools, code, stderr, resultJson }:
 *   outcome "allow"  the call ran without a prompt
 *           "ask"    it needed approval (refused only because -p cannot ask)
 *           "deny"   a deny rule refused it, or removed the tool
 *           "none"   the binary never made the call (see stderr)
 */
async function askOnce(claude, c0, { timeoutMs = 120000, keep = false, debugFile = null } = {}) {
  const { root, home, cfg, work, c } = prepareCase(c0);

  let requests = 0;
  let seen = null;
  let toolNames = null;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      if (!req.url.includes("/v1/messages")) { res.writeHead(404); res.end("{}"); return; }
      let j = {};
      try { j = JSON.parse(body); } catch { /* not JSON: answer anyway */ }
      const tr = findToolResult(j);
      if (!toolNames && Array.isArray(j.tools) && j.tools.length) toolNames = j.tools.map((t) => t.name);
      if (tr) seen = tr;
      const id = `msg_${++requests}`;
      const asked = (j.messages || []).some((m) => Array.isArray(m.content) && m.content.some((b) => b && b.type === "tool_use"));
      const wantsCall = !tr && !asked && Array.isArray(j.tools) && j.tools.length > 0;
      if (j.stream === false) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id, type: "message", role: "assistant", model: j.model || "x", content: [{ type: "text", text: "done" }], stop_reason: "end_turn", usage: USAGE }));
      } else {
        sse(res, wantsCall ? toolUseEvents(id, j.model, c.tool, c.input) : textEvents(id, j.model, "done"));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  const env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: cfg,
    HOME: home,
    USERPROFILE: home,
    ANTHROPIC_API_KEY: "sk-ant-probe",
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    DISABLE_AUTOUPDATER: "1",
    DISABLE_TELEMETRY: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    ...(c.env || {}),
  };
  delete env.CLAUDE_PROJECT_DIR;
  const args = ["-p", "run it", "--max-turns", "2", "--output-format", "json", "--permission-mode", c.mode || "default", ...(debugFile ? ["--debug-file", debugFile] : []), ...(c.args || [])];

  const out = await new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let child;
    try {
      child = spawn(claude, args, { cwd: work, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], detached: !IS_WIN });
    } catch (e) {
      resolve({ stdout, stderr: String(e), code: null });
      return;
    }
    child.on("error", (e) => { stderr += String(e); });
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    const timer = setTimeout(() => killTree(child), timeoutMs);
    child.on("close", (code) => { clearTimeout(timer); resolve({ stdout, stderr, code }); });
  });
  await new Promise((resolve) => server.close(resolve));

  let resultJson = null;
  try { resultJson = JSON.parse(out.stdout); } catch { /* not JSON, e.g. the run failed early */ }
  const denials = (resultJson && resultJson.permission_denials) || [];
  const text = resultText(seen);
  const refused = denials.some((d) => d.tool_use_id === "toolu_1");

  let outcome;
  if (!seen) outcome = "none";
  else if (/No such tool available/.test(text)) outcome = "deny"; // a bare deny rule removes the tool
  else if (refused) outcome = DENIED.test(text) ? "deny" : "ask";
  else outcome = "allow";

  if (!keep) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* the OS cleans the temp folder eventually */ }
  }
  return { outcome, text, isError: !!(seen && seen.is_error), tools: toolNames || [], denials, code: out.code, stderr: out.stderr, resultJson, root: keep ? root : null };
}

// What Claude Code says when a deny rule refused the call (an ask is "Claude requested permissions ...").
const DENIED = /has been denied|is denied by your permission|covered by a \w+ deny rule|denied access to/i;

// Claude Code parses PowerShell by running PowerShell; on a busy machine that times out and the
// call is refused for that reason. Such a run says nothing about the rules, so it is repeated.
const FLAKY = /timed out after \d+ms/;

export async function ask(claude, c, opts = {}) {
  let r;
  for (let attempt = 0; attempt < 4; attempt++) {
    r = await askOnce(claude, c, opts);
    // a run that never reached the call (the binary did not start in time) says nothing either
    const again = FLAKY.test(r.text) || (r.outcome === "none" && attempt < 2);
    if (!again) break;
    if (r.root) { try { fs.rmSync(r.root, { recursive: true, force: true }); } catch { /* left for the OS */ } }
  }
  return r;
}

/** Run `cases` with at most `limit` binaries at once; results come back in order. */
export async function askAll(claude, cases, { limit = 4, ...opts } = {}) {
  const results = new Array(cases.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= cases.length) return;
      results[i] = await ask(claude, cases[i], opts);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, cases.length) }, worker));
  return results;
}
