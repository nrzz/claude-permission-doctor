import { BIN, ROOT, runCli, runMain, sandbox, tmp, writeTranscript } from "./helpers.mjs";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { main, parseArgs } from "../src/cli.mjs";
import { VERSION } from "../src/version.mjs";

const perms = (p) => ({ permissions: p });
const cli = (s, argv, extra = {}) => runMain(main, argv, s.io(extra));
const NOW = new Date(2026, 9, 15, 15, 30, 12).getTime();

/** Every file under a folder with its bytes, to see that nothing was written. */
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[p] = fs.readFileSync(p, "utf8");
    }
  };
  walk(dir);
  return out;
}

test("parseArgs: flags, values, defaults", () => {
  const o = parseArgs(["why", "git status", "--tool", "powershell", "--project", "x", "--json"]);
  assert.equal(o.command, "why");
  assert.deepEqual(o.positional, ["git status"]);
  assert.equal(o.tool, "PowerShell", "the tool name is accepted in any case");
  assert.equal(o.project, "x");
  assert.equal(o.json, true);
  assert.equal(o.days, 90);
  assert.equal(o.min, 3);
  const e = parseArgs(["suggest", "--days=30", "--min=5", "--write=user", "--only=1,3"]);
  assert.deepEqual([e.days, e.min, e.write, e.only], [30, 5, "user", [1, 3]]);
  assert.equal(parseArgs(["lint", "--fix", "--dry-run"]).dryRun, true);
  assert.equal(parseArgs(["-h"]).help, true);
  assert.equal(parseArgs(["--version"]).version, true);
});

test("parseArgs: a command can come after its flags, and a lone dash is a word", () => {
  assert.equal(parseArgs(["--json", "show"]).command, "show");
  assert.deepEqual(parseArgs(["why", "-"]).positional, ["-"]);
});

const bad = [
  [[], /a command is needed/],
  [["frobnicate"], /unknown command frobnicate/],
  [["show", "--nope"], /unknown option --nope/],
  [["show", "extra"], /show takes no arguments/],
  [["why"], /why needs the command in quotes/],
  [["why", "a", "b"], /why needs the command in quotes/],
  [["why", "--tool", "Read"], /--tool Read needs --path/],
  [["why", "--tool", "Edit"], /--tool Edit needs --path/],
  [["why", "--tool", "WebFetch"], /--tool WebFetch needs --url/],
  [["why", "--tool", "WebSearch", "x"], /takes no command text/],
  [["lint", "--days", "abc"], /--days needs a whole number/],
  [["lint", "--days", "0"], /--days needs a whole number of at least 1/],
  [["lint", "--days"], /--days needs a value/],
  [["suggest", "--min", "-1"], /--min needs a whole number/],
  [["lint", "--dry-run"], /--dry-run only works together with --fix/],
  [["suggest", "--dry-run"], /--dry-run only works together with --write/],
  [["suggest", "--only", "1"], /--only only works together with --write/],
  [["suggest", "--write", "nowhere"], /--write needs user, project or local/],
  [["suggest", "--write", "user", "--only", "x"], /--only needs rule numbers/],
  [["suggest", "--all", "--write", "project"], /only --write user makes sense/],
  [["lint", "--json", "--markdown"], /--json and --markdown cannot be combined/],
  [["show", "--json=1"], /--json does not take a value/],
  [["restore"], /restore needs the settings file/],
  [["lint", "extra"], /lint takes no arguments/],
  [["suggest", "extra"], /suggest takes no arguments/],
];
for (const [argv, pattern] of bad) {
  test(`bad usage: ${JSON.stringify(argv)} exits 2 and says why`, async () => {
    const r = await cli(sandbox(), argv);
    assert.equal(r.code, 2);
    assert.equal(r.out, "");
    assert.match(r.err, pattern);
    assert.match(r.err, /Try: claude-permission-doctor --help/);
  });
}

test("--help and --version", async () => {
  const s = sandbox();
  const h = await cli(s, ["--help"]);
  assert.equal(h.code, 0);
  for (const word of ["show", "why", "lint", "suggest", "restore", "--fix", "--dry-run", "--write", "--markdown", "--json", "CLAUDE_CONFIG_DIR"]) assert.ok(h.out.includes(word), word);
  assert.match(h.out, /never uses the network/);
  assert.equal((await cli(s, ["-h"])).out, h.out);
  const v = await cli(s, ["--version"]);
  assert.equal(v.out, `${VERSION}\n`);
  assert.equal(v.code, 0);
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
});

test("show: files, rules, counts, what is not read; --json has the same facts", async () => {
  const s = sandbox({ user: perms({ allow: ["Bash(ls *)"], deny: ["Read(./.env)"] }), project: perms({ allow: ["Bash(ls *)", "bash(x)"] }) });
  const t = await cli(s, ["show"]);
  assert.equal(t.code, 0);
  assert.match(t.out, /\(from CLAUDE_CONFIG_DIR\)/);
  assert.match(t.out, /1 deny rule, 0 ask rules, 2 allow rules; 0 overridden, 1 skipped/);
  assert.match(t.out, /skipped by Claude Code/);
  assert.match(t.out, /Not read by this tool:/);
  assert.match(t.out, /plugins: a plugin cannot add permission rules/);
  assert.doesNotMatch(t.out, /\x1b\[/);
  const j = JSON.parse((await cli(s, ["show", "--json"])).out);
  assert.equal(j.schema, 1);
  assert.equal(j.command, "show");
  assert.equal(j.version, VERSION);
  assert.equal(j.configDirSource, "CLAUDE_CONFIG_DIR");
  assert.deepEqual(j.summary, { allow: 2, ask: 0, deny: 1, overridden: 0, invalid: 1 });
  assert.equal(j.rules.length, 4);
  assert.equal(j.rules.find((r) => r.rule === "bash(x)").valid, false);
  assert.ok(j.notRead.length >= 4);
});

test("show: a rule that another rule overrides says which", async () => {
  const s = sandbox({ user: perms({ allow: ["Bash(git push origin main)"] }), project: perms({ deny: ["Bash(git push *)"] }) });
  const t = await cli(s, ["show"]);
  assert.match(t.out, /overridden by deny Bash\(git push \*\) in project settings/);
  assert.match(t.out, /it never allows anything/);
  const j = JSON.parse((await cli(s, ["show", "--json"])).out);
  assert.equal(j.rules.find((r) => r.behavior === "allow").overriddenBy.rule, "Bash(git push *)");
});

test("show names a project allow rule's trust caveat, and managed settings when present", async () => {
  const s = sandbox({ project: perms({ allow: ["Bash(ls *)"] }), managed: perms({ deny: ["Bash(rm *)"] }) });
  const t = await cli(s, ["show"]);
  assert.match(t.out, /workspace trust dialog/);
  assert.match(t.out, /managed .*managed-settings\.json/);
  assert.match(t.out, /1 deny/);
});

test("why: text and JSON, for a command, a file and a URL", async () => {
  const s = sandbox({ user: perms({ allow: ["Bash(mytool *)"], deny: ["Read(./.env)"] }) });
  const a = await cli(s, ["why", "mytool a && othertool b"]);
  assert.equal(a.code, 0, "the exit code is 0 whatever the verdict");
  assert.match(a.out, /why this Bash command prompts/);
  assert.match(a.out, /Split into 2 commands at &&:/);
  assert.match(a.out, /To stop the prompt {3}Bash\(othertool \*\)/);
  const j = JSON.parse((await cli(s, ["why", "mytool a", "--json"])).out);
  assert.equal(j.command, "why");
  assert.equal(j.decision.verdict, "allow");
  assert.equal(j.decision.parts[0].rule.rule, "Bash(mytool *)");
  const f = await cli(s, ["why", "--tool", "Read", "--path", ".env"]);
  assert.match(f.out, /why this read is refused/);
  assert.match(f.out, /Read\(\.\/\.env\)/);
  const u = await cli(s, ["why", "--tool", "WebFetch", "--url", "https://example.com/x"]);
  assert.match(u.out, /why this fetch prompts/);
  assert.match(u.out, /WebFetch\(domain:example\.com\)/);
  const m = await cli(s, ["why", "--tool", "mcp__srv__tool"]);
  assert.match(m.out, /why this mcp__srv__tool call prompts/);
});

test("why --project judges against that folder's settings, and --tool PowerShell reads PowerShell", async () => {
  const s = sandbox({ project: perms({ allow: ["PowerShell(Get-Process *)"] }) });
  const other = tmp();
  const here = await runMain(main, ["why", "gps x", "--tool", "PowerShell", "--project", s.proj], { env: s.env(), home: s.home, cwd: other, managed: s.managedDir });
  assert.match(here.out, /runs without a prompt/);
  const elsewhere = await runMain(main, ["why", "gps x", "--tool", "PowerShell"], { env: s.env(), home: s.home, cwd: other, managed: s.managedDir });
  assert.match(elsewhere.out, /prompts/);
});

test("lint: findings, summary, --json, --markdown", async () => {
  const s = sandbox({ user: perms({ allow: ["bash(x)", "Bash(a *)", "Bash(a *)"] }) });
  const t = await cli(s, ["lint"]);
  assert.equal(t.code, 0);
  assert.match(t.out, /malformed-rule/);
  assert.match(t.out, /duplicate-rule +\S*settings\.json:6 {2}\[--fix\]/);
  assert.match(t.out, /0 errors, 2 warnings, 0 notes; 1 can be removed by --fix/);
  const j = JSON.parse((await cli(s, ["lint", "--json"])).out);
  assert.equal(j.command, "lint");
  assert.equal(j.summary.warn, 2);
  assert.equal(j.findings[0].file.endsWith("settings.json"), true);
  const md = await cli(s, ["lint", "--markdown"]);
  assert.match(md.out, /^## permission-doctor lint:/);
  assert.match(md.out, /- WARN `duplicate-rule`/);
});

test("lint --fix --dry-run shows the plan and writes nothing; --fix backs up and edits; restore undoes it", async () => {
  const s = sandbox({ user: perms({ allow: ["Bash(a *)", "Bash(a *)", "Bash(b *)"] }) });
  const before = snapshot(s.base);
  const dry = await cli(s, ["lint", "--fix", "--dry-run"], { now: NOW });
  assert.match(dry.out, /Dry run: nothing was written/);
  assert.match(dry.out, /would remove 1 rule/);
  assert.deepEqual(snapshot(s.base), before);

  const done = await cli(s, ["lint", "--fix"], { now: NOW });
  assert.match(done.out, /removed 1 rule/);
  assert.match(done.out, /allow Bash\(a \*\)  \(duplicate\)/);
  assert.match(done.out, /backup: .*settings\.json\.bak-permission-doctor-20261015-153012/);
  assert.match(done.out, /undo: {3}claude-permission-doctor restore/);
  assert.deepEqual(JSON.parse(fs.readFileSync(s.userFile, "utf8")).permissions.allow, ["Bash(a *)", "Bash(b *)"]);
  assert.equal(s.backups(s.userFile).length, 1);

  const back = await cli(s, ["restore", s.userFile], { now: NOW + 60000 });
  assert.equal(back.code, 0);
  assert.match(back.out, /^Restored /);
  assert.equal(fs.readFileSync(s.userFile, "utf8"), before[s.userFile]);
});

test("lint --fix --json carries what was done", async () => {
  const s = sandbox({ user: perms({ allow: ["Bash(a *)", "Bash(a *)"] }) });
  const j = JSON.parse((await cli(s, ["lint", "--fix", "--dry-run", "--json"])).out);
  assert.equal(j.fix.dryRun, true);
  assert.equal(j.fix.files[0].removed[0].rule, "Bash(a *)");
});

test("lint reads the transcripts of the project and finds dead rules", async () => {
  const s = sandbox({ user: perms({ allow: ["Bash(make deploy)"] }) });
  const old = new Date(Date.now() - 60 * 86400000);
  fs.utimesSync(s.userFile, old, old);
  writeTranscript(s.cfg, s.proj, [{ command: "make deploy", daysAgo: 40 }]);
  const t = await cli(s, ["lint"]);
  assert.match(t.out, /dead-rule/);
  assert.match(t.out, /used once in the last 90 days, most likely the approval that created it/);
  assert.match(t.out, /1 shell commands from 1 transcript in the last 90 days/);
  assert.doesNotMatch((await cli(s, ["lint", "--days", "10"])).out, /used once/);
});

function withHistory() {
  const s = sandbox({ user: perms({ allow: ["Bash(existing *)"] }) });
  const day = (n) => ({ daysAgo: n });
  writeTranscript(s.cfg, s.proj, [
    ...[1, 2, 3, 4].map((n) => ({ command: "npm test", ...day(n) })),
    ...[1, 2, 3].map((n) => ({ command: "git commit -m x", ...day(n) })),
    ...[1, 2, 3].map((n) => ({ command: "rm -rf build", ...day(n) })),
    ...[1, 2].map((n) => ({ command: "make build", ...day(n) })),
  ]);
  return s;
}

test("suggest: ranked proposals, honest wording, --json and --markdown", async () => {
  const s = withHistory();
  const t = await cli(s, ["suggest"]);
  assert.equal(t.code, 0);
  assert.match(t.out, /1\. +4x +Bash\(npm test \*\)/);
  assert.match(t.out, /careful: this rule approves every use of rm, and it deletes files/);
  assert.match(t.out, /These ran without a rule\. That is not the same as a prompt you approved/);
  assert.match(t.out, /None is recorded as approved by a person/);
  assert.match(t.out, /Left out: 1 more command shape below the minimum of 3/);
  const j = JSON.parse((await cli(s, ["suggest", "--json"])).out);
  assert.deepEqual(j.proposals.map((p) => p.rule), ["Bash(npm test *)", "Bash(git commit *)", "Bash(rm *)"]);
  assert.equal(j.min, 3);
  const md = await cli(s, ["suggest", "--markdown"]);
  assert.match(md.out, /^## permission-doctor suggest: commands that ran without a rule/);
  assert.match(md.out, /Counts are commands that ran without a rule, not prompts you approved\./);
});

test("suggest --write user adds the safe proposals after a backup, and --dry-run only says what it would do", async () => {
  const s = withHistory();
  const before = snapshot(s.base);
  const dry = await cli(s, ["suggest", "--write", "user", "--dry-run"], { now: NOW });
  assert.match(dry.out, /Dry run: nothing was written. Without --dry-run, --write user would add to/);
  assert.match(dry.out, /\+ Bash\(npm test \*\)/);
  assert.deepEqual(snapshot(s.base), before);

  const real = await cli(s, ["suggest", "--write", "user"], { now: NOW });
  assert.match(real.out, /Wrote to /);
  assert.match(real.out, /Not written, because they approve more than one command: Bash\(rm \*\)/);
  assert.deepEqual(JSON.parse(fs.readFileSync(s.userFile, "utf8")).permissions.allow, ["Bash(existing *)", "Bash(npm test *)", "Bash(git commit *)"]);
  assert.equal(s.backups(s.userFile).length, 1);

  // after that nothing is proposed any more for those two; --only picks by number from the new list
  const again = JSON.parse((await cli(s, ["suggest", "--json"])).out);
  assert.deepEqual(again.proposals.map((p) => p.rule), ["Bash(rm *)"]);
  const only = await cli(s, ["suggest", "--write", "user", "--only", "1"], { now: NOW + 5000 });
  assert.match(only.out, /\+ Bash\(rm \*\)/);
  assert.ok(JSON.parse(fs.readFileSync(s.userFile, "utf8")).permissions.allow.includes("Bash(rm *)"));
});

test("suggest --write rejects a number that is not in the list, and writes to the project or local file when asked", async () => {
  const s = withHistory();
  const r = await cli(s, ["suggest", "--write", "user", "--only", "9"]);
  assert.equal(r.code, 2);
  assert.match(r.err, /rule number that is not in the list \(there are 3\)/);
  await cli(s, ["suggest", "--write", "local"], { now: NOW });
  assert.deepEqual(JSON.parse(fs.readFileSync(s.localFile, "utf8")).permissions.allow, ["Bash(npm test *)", "Bash(git commit *)"]);
  // the two rules written to the local file are no longer proposed, so the first proposal is now the third
  await cli(s, ["suggest", "--write", "project", "--only", "1"], { now: NOW });
  assert.deepEqual(JSON.parse(fs.readFileSync(s.projectFile, "utf8")).permissions.allow, ["Bash(rm *)"]);
});

test("suggest --all reads every project", async () => {
  const s = withHistory();
  writeTranscript(s.cfg, `${s.base}/other`, [{ command: "make build" }, { command: "make build" }], { session: "o" });
  const j = JSON.parse((await cli(s, ["suggest", "--all", "--json"])).out);
  assert.equal(j.all, true);
  assert.ok(j.proposals.some((p) => p.rule === "Bash(make build *)" && p.count === 4));
});

test("restore: nothing to restore exits 2 and says so", async () => {
  const s = sandbox({ user: perms({ allow: [] }) });
  const r = await cli(s, ["restore", s.userFile]);
  assert.equal(r.code, 2);
  assert.match(r.out, /there is no backup of it/);
});

test("the read commands never write a byte", async () => {
  const s = withHistory();
  const before = snapshot(s.base);
  for (const argv of [["show"], ["show", "--json"], ["why", "npm test"], ["why", "--tool", "Read", "--path", "a"], ["lint"], ["lint", "--markdown"], ["suggest"], ["suggest", "--json"], ["suggest", "--all"], ["lint", "--fix", "--dry-run"], ["suggest", "--write", "user", "--dry-run"]]) {
    await cli(s, argv);
    assert.deepEqual(snapshot(s.base), before, argv.join(" "));
  }
});

test("colour only on a terminal, and never with NO_COLOR or --no-color", async () => {
  const s = sandbox({ user: perms({ allow: ["Bash(a *)"] }) });
  const tty = (extra = {}, argv = ["show"]) => runMain(main, argv, { ...s.io(), env: { ...s.env(), NO_COLOR: "", ...extra }, stdout: { write: () => {}, isTTY: true } });
  let out = "";
  const r = await main(["show"], { ...s.io(), env: { ...s.env(), NO_COLOR: "" }, stdout: { write: (x) => { out += x; }, isTTY: true }, stderr: { write: () => {} } });
  assert.equal(r, 0);
  assert.match(out, /\x1b\[/);
  out = "";
  await main(["show", "--no-color"], { ...s.io(), env: { ...s.env(), NO_COLOR: "" }, stdout: { write: (x) => { out += x; }, isTTY: true }, stderr: { write: () => {} } });
  assert.doesNotMatch(out, /\x1b\[/);
  out = "";
  await main(["show"], { ...s.io(), env: { ...s.env(), NO_COLOR: "1" }, stdout: { write: (x) => { out += x; }, isTTY: true }, stderr: { write: () => {} } });
  assert.doesNotMatch(out, /\x1b\[/);
  void tty;
});

test("an unexpected error is reported as an error with exit 2, not a stack trace", async () => {
  const s = sandbox();
  const r = await runMain(main, ["show"], { ...s.io(), managed: 42 });
  assert.ok(r.code === 0 || r.code === 2);
  assert.doesNotMatch(r.err, /\n\s+at /);
});

// --- as a process -------------------------------------------------------------------------------------------------------------

test("the bin runs as a process: --version, a verdict, the exit codes and stdout/stderr", () => {
  const s = sandbox({ user: perms({ allow: ["Bash(mytool *)"] }) });
  const v = runCli(["--version"], { cwd: s.proj, env: s.env() });
  assert.deepEqual([v.code, v.out.trim(), v.err], [0, VERSION, ""]);
  const w = s.cli(["why", "mytool a"]);
  assert.equal(w.code, 0);
  assert.match(w.out, /runs without a prompt/);
  assert.equal(w.err, "");
  const e = s.cli(["why"]);
  assert.equal(e.code, 2);
  assert.equal(e.out, "");
  assert.match(e.err, /why needs the command in quotes/);
  const j = JSON.parse(s.cli(["show", "--json"]).out);
  assert.equal(j.rules[0].rule, "Bash(mytool *)");
});

test("the bin uses CLAUDE_CONFIG_DIR and the current folder", () => {
  const s = sandbox({ user: perms({ allow: ["Bash(mytool *)"] }) });
  assert.match(s.cli(["show"]).out, new RegExp(s.cfg.split(path.sep).join("/").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const other = tmp();
  const r = runCli(["why", "mytool a"], { cwd: other, env: s.env() });
  assert.match(r.out, /runs without a prompt/, "a user rule applies in every folder");
  assert.match(r.out, new RegExp(path.basename(other)));
});

test("the entry point is executable on its own and imports nothing outside the package", () => {
  const text = fs.readFileSync(BIN, "utf8");
  assert.match(text, /^#!\/usr\/bin\/env node/);
  assert.ok(fs.existsSync(path.join(ROOT, "src", "cli.mjs")));
});
