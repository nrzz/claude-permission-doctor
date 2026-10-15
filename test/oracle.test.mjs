// The oracle: the same questions put to the real Claude Code binary.
//
// Runs only when E2E_CLAUDE names the binary (a path, or `claude` when it is on PATH):
//     E2E_CLAUDE=claude node --test test/oracle.test.mjs
//
// A fake model API on 127.0.0.1 makes the binary call one tool with the input of a row of
// test/oracle-table.mjs; `claude -p --permission-mode default` runs it or refuses it, and the refusal
// shows up under permission_denials. No model is reached, nothing leaves the machine, and every run has
// its own throwaway HOME, USERPROFILE and CLAUDE_CONFIG_DIR. The test fails on any row where the binary
// and `why` disagree, or where either disagrees with the row's `expect`. If the binary and the docs
// disagree, the binary is right and the tool is changed (README: "What was verified").
import { tmp } from "./helpers.mjs";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { ask, askAll, bashEnv, prepareCase } from "./oracle-lib.mjs";
import { rows } from "./oracle-table.mjs";
import { describeRow, engineRun } from "./table-lib.mjs";
import { fine, problems, warned } from "./rule-table.mjs";
import { checkRule } from "../src/rule.mjs";
import { readRuns, transcriptFiles } from "../src/transcripts.mjs";

const CLAUDE = process.env.E2E_CLAUDE;
const skip = CLAUDE ? false : "set E2E_CLAUDE to the claude binary to put the table to it";
const BASH = bashEnv();
const totals = { checked: 0, agree: 0, skipped: 0 };

const childEnv = (p, extra = {}) => ({
  ...process.env, CLAUDE_CONFIG_DIR: p.cfg, HOME: p.home, USERPROFILE: p.home, ANTHROPIC_API_KEY: "sk-ant-probe",
  DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", ...extra,
});

test("the binary starts and tells its version", { skip }, (t) => {
  const p = prepareCase({});
  try {
    const r = spawnSync(CLAUDE, ["--version"], { env: childEnv(p), encoding: "utf8", timeout: 60000, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    assert.equal(r.status, 0, r.stderr);
    t.diagnostic(`Claude Code ${r.stdout.trim()} on ${process.platform}, Node ${process.version}`);
    assert.match(r.stdout, /\d+\.\d+\.\d+/);
  } finally {
    fs.rmSync(p.root, { recursive: true, force: true });
  }
});

// --- the table: one test per group of rows -------------------------------------------------------------------------------------

const groups = new Map();
for (const row of rows) {
  if (!groups.has(row.group)) groups.set(row.group, []);
  groups.get(row.group).push(row);
}

for (const [group, all] of groups) {
  test(`the binary and why agree: ${group} (${all.length})`, { skip }, async (t) => {
    const runnable = all.filter((r) => (!r.platform || r.platform === process.platform) && (r.tool === "PowerShell" || BASH !== null));
    totals.skipped += all.length - runnable.length;
    if (!runnable.length) {
      t.diagnostic(`no row of ${group} can run on ${process.platform}${BASH === null ? " (no Git Bash for the Bash tool)" : ""}`);
      return;
    }
    const cases = runnable.map((r) => ({ ...r, env: r.tool === "PowerShell" ? {} : BASH }));
    // PowerShell is parsed by running PowerShell, which times out when many run at once
    const results = await askAll(CLAUDE, cases, { limit: runnable.some((r) => r.tool === "PowerShell") ? 2 : 4 });
    const wrong = [];
    runnable.forEach((row, i) => {
      const got = results[i];
      const mine = engineRun(row).decision.verdict;
      totals.checked++;
      if (got.outcome === row.expect && mine === row.expect) totals.agree++;
      else wrong.push(`${row.id} ${describeRow(row)}\n    expect ${row.expect}, binary ${got.outcome}, why ${mine}: ${JSON.stringify(String(got.text).slice(0, 140))}`);
    });
    assert.deepEqual(wrong, [], `${wrong.length} of ${runnable.length} rows disagree:\n${wrong.join("\n")}`);
  });
}

// --- the rules Claude Code skips or warns about ----------------------------------------------------------------------------------

test("rules: what claude doctor skips and what the startup log warns about is what rule.mjs says", { skip }, (t) => {
  // every string rule of the shared table, once per behavior, in one user settings file
  const perm = { allow: [], ask: [], deny: [] };
  const expected = [];
  for (const [rule, behavior] of [...problems.map(([r, b]) => [r, b]), ...fine, ...warned.map(([r, b]) => [r, b])]) {
    if (typeof rule !== "string" || rule.trim() === "") continue; // doctor words an empty or non-string entry differently; rule.test.mjs covers them
    if (perm[behavior].includes(rule)) continue;
    perm[behavior].push(rule);
    expected.push({ rule, behavior, check: checkRule(rule, behavior) });
  }
  const p = prepareCase({ settings: { user: { permissions: perm } } });
  const log = path.join(tmp(), "debug.log");
  try {
    // the startup warnings are in the debug log of any session
    const doctor = spawnSync(CLAUDE, ["doctor"], { cwd: p.work, env: childEnv(p, BASH || {}), encoding: "utf8", timeout: 120000, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const skippedText = `${doctor.stdout}\n${doctor.stderr}`;
    return ask(CLAUDE, { tool: "Bash", input: { command: "echo hi" }, settings: { user: { permissions: perm } }, env: BASH || {} }, { debugFile: log }).then(() => {
      const warnLines = (fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "").split(/\r?\n/).filter((l) => l.includes("[WARN] [permissions]"));
      const wrong = [];
      for (const { rule, behavior, check } of expected) {
        const listed = skippedText.includes(`permissions.${behavior}: Invalid permission rule "${rule}" was skipped`);
        if (check.problem && !listed) wrong.push(`${behavior} ${JSON.stringify(rule)}: rule.mjs says Claude Code skips it (${check.problem.code}), doctor does not list it`);
        if (!check.problem && listed) wrong.push(`${behavior} ${JSON.stringify(rule)}: doctor skips it, rule.mjs accepts it`);
        // a warning either quotes the rule (Permission deny rule "Bash(x)" ...) or names the file and then the rule (Permission allow rule (file): Bash(x) has ...)
        const mentions = (l) => l.includes(`Permission ${behavior} rule`) && (l.includes(`): ${rule} `) || l.includes(`rule "${rule}" `));
        const warned = warnLines.some(mentions);
        const loud = check.warnings.some((w) => !w.silent);
        if (!check.problem && loud && !warned) wrong.push(`${behavior} ${JSON.stringify(rule)}: rule.mjs says Claude Code warns (${check.warnings.map((w) => w.code)}), the log has no warning`);
        if (!check.problem && !loud && warned) wrong.push(`${behavior} ${JSON.stringify(rule)}: the log warns, rule.mjs does not (${warnLines.find(mentions)})`);
      }
      t.diagnostic(`${expected.length} rules checked: ${expected.filter((e) => e.check.problem).length} skipped, ${expected.filter((e) => !e.check.problem && e.check.warnings.some((w) => !w.silent)).length} warned about, ${expected.filter((e) => !e.check.problem && !e.check.warnings.some((w) => !w.silent)).length} quiet`);
      totals.checked += expected.length;
      totals.agree += expected.length - wrong.length;
      assert.deepEqual(wrong, [], wrong.join("\n"));
    });
  } finally {
    // the files are left for the OS to remove when the promise above has settled; the throwaway root is small
    setTimeout(() => { try { fs.rmSync(p.root, { recursive: true, force: true }); } catch { /* temp */ } }, 5000).unref();
  }
});

// --- what the transcript of a real run looks like ---------------------------------------------------------------------------------

test("transcripts: a command that ran is read as a run, a command that was refused is not", { skip: skip || (BASH === null ? "no Bash tool on this machine" : false) }, async (t) => {
  const ran = await ask(CLAUDE, { tool: "Bash", input: { command: "echo transcript-ran" }, env: BASH }, { keep: true });
  const refused = await ask(CLAUDE, { tool: "Bash", input: { command: "mytool transcript-refused" }, env: BASH }, { keep: true });
  assert.equal(ran.outcome, "allow");
  assert.equal(refused.outcome, "ask");
  try {
    const read = (r) => {
      const cfg = path.join(r.root, "cfg");
      const work = path.join(r.root, "work");
      const found = transcriptFiles({ configDir: cfg, project: work });
      assert.ok(found.length >= 1, `a transcript under ${cfg}/projects for ${work} (this checks the folder naming too)`);
      return { files: found.map((f) => f.file), runs: found.flatMap((f) => readRuns(f.file)), raw: found.map((f) => fs.readFileSync(f.file, "utf8")).join("\n") };
    };
    const a = read(ran);
    assert.deepEqual(a.runs.map((x) => x.command), ["echo transcript-ran"]);
    t.diagnostic(`a run is stamped: ${/"permissionDecision":\{[^}]*\}/.exec(a.raw)?.[0] || "no permissionDecision in the transcript"}`);
    const b = read(refused);
    assert.deepEqual(b.runs.map((x) => x.command), [], "the refused command is not a run");
    t.diagnostic(`a refusal is stamped: ${/"toolDenialKind":"[^"]*"/.exec(b.raw)?.[0] || "no toolDenialKind in the transcript"}; ${/"permissionDecision":\{[^}]*\}/.exec(b.raw)?.[0] || "no permissionDecision"}`);
    assert.ok(/toolDenialKind|permissionDecision|This command requires approval|Claude requested permissions/.test(b.raw), "a refusal leaves a trace this tool can recognize");
  } finally {
    for (const r of [ran, refused]) if (r.root) fs.rmSync(r.root, { recursive: true, force: true });
  }
});

after(() => {
  if (!CLAUDE) return;
  // eslint-disable-next-line no-console
  console.log(`# oracle: ${totals.checked} pairs checked against the binary, ${totals.agree} agree, ${totals.skipped} rows not run on ${process.platform}`);
});

test("every pair that could run was checked, and every one agreed", { skip }, () => {
  assert.ok(totals.checked >= 40, `${totals.checked} pairs checked`);
  assert.equal(totals.agree, totals.checked);
});
