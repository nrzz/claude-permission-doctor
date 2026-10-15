import { sandbox, writeTranscript } from "./helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { buildSuggest } from "../src/commands.mjs";

const perms = (p) => ({ permissions: p });
const run = (s, opts = {}) => buildSuggest({ project: s.proj, env: s.env(), home: s.home, managed: s.managedDir, ...opts });
const times = (command, n, extra = {}) => Array.from({ length: n }, (_, i) => ({ command: `${command}`, daysAgo: 1 + i, ...extra }));
const rules = (m) => m.proposals.map((p) => p.rule);

test("commands that ran three times without a rule become prefix rules, most used first", () => {
  const s = sandbox();
  writeTranscript(s.cfg, s.proj, [
    ...times("git commit -m one", 2), { command: "git commit -m three" },
    ...times("npm test", 5),
    ...times("make build", 3),
    ...times("mytool deploy", 2),
  ]);
  const m = run(s);
  assert.deepEqual(rules(m), ["Bash(npm test *)", "Bash(git commit *)", "Bash(make build *)"]);
  assert.deepEqual(m.proposals.map((p) => p.count), [5, 3, 3]);
  assert.equal(m.stats.runs, 13);
  assert.equal(m.stats.below, 1, "mytool deploy ran twice, below the minimum of 3");
  assert.deepEqual(m.proposals[1].examples, ["git commit -m one", "git commit -m three"], "examples are distinct commands");
  assert.ok(m.proposals[0].last);
});

test("--min changes the bar", () => {
  const s = sandbox();
  writeTranscript(s.cfg, s.proj, [...times("mytool deploy", 2), ...times("npm test", 5)]);
  assert.deepEqual(rules(run(s, { min: 2 })), ["Bash(npm test *)", "Bash(mytool *)"]);
  assert.deepEqual(rules(run(s, { min: 6 })), []);
});

test("a command is counted once per run even when it appears twice in one line", () => {
  const s = sandbox();
  writeTranscript(s.cfg, s.proj, [{ command: "make build && make build" }, { command: "make build; make build; make build" }]);
  const m = run(s, { min: 1 });
  assert.equal(m.proposals[0].count, 2);
});

test("commands an allow rule covers, and commands that only read, are not proposed", () => {
  const s = sandbox({ user: perms({ allow: ["Bash(npm test *)"] }) });
  writeTranscript(s.cfg, s.proj, [...times("npm test", 4), ...times("ls -la", 4), ...times("git status", 4), ...times("cat a.txt", 4), ...times("make build", 3)]);
  const m = run(s);
  assert.deepEqual(rules(m), ["Bash(make build *)"]);
  assert.equal(m.stats.covered, 16);
});

test("compound commands are split: each part is judged by itself", () => {
  const s = sandbox();
  writeTranscript(s.cfg, s.proj, times("cd sub && npm run build | tee out.log", 3));
  const m = run(s);
  assert.deepEqual(rules(m).sort(), ["Bash(npm run build *)", "Bash(tee *)"].sort());
  assert.equal(m.stats.commands, 9, "three parts in each of three runs");
});

test("wrappers are looked through: timeout npm test is npm test", () => {
  const s = sandbox();
  writeTranscript(s.cfg, s.proj, [{ command: "timeout 60 npm test" }, { command: "npm test" }, { command: "NODE_ENV=test npm test" }]);
  assert.deepEqual(rules(run(s)), ["Bash(npm test *)"]);
});

test("a variable the allow rules cannot see past is counted apart: no prefix rule fixes it", () => {
  const s = sandbox();
  writeTranscript(s.cfg, s.proj, times("FOO=bar make build", 4));
  const m = run(s);
  assert.deepEqual(rules(m), []);
  assert.equal(m.stats.skippedAssignments, 4);
});

test("inline code is not turned into a rule", () => {
  const s = sandbox();
  writeTranscript(s.cfg, s.proj, [...times("python3 -c 'print(1)'", 3), ...times("node -e 1", 3)]);
  const m = run(s);
  assert.deepEqual(rules(m), []);
  assert.equal(m.stats.inline, 6);
});

test("a script is grouped by the script, an interpreter alone is a warning", () => {
  const s = sandbox();
  writeTranscript(s.cfg, s.proj, [...times("node scripts/build.js --prod", 3), ...times("python3 tools/gen.py", 3)]);
  const m = run(s);
  assert.deepEqual(rules(m).sort(), ["Bash(node scripts/build.js *)", "Bash(python3 tools/gen.py *)"]);
  assert.ok(m.proposals.every((p) => p.risk), "node and python3 run any code");
});

test("risky programs are proposed with a warning, not hidden", () => {
  const s = sandbox();
  writeTranscript(s.cfg, s.proj, [...times("rm -rf build", 3), ...times("git push origin main", 3), ...times("npm install", 3), ...times("make", 3)]);
  const m = run(s);
  const by = Object.fromEntries(m.proposals.map((p) => [p.rule, p.risk]));
  assert.equal(by["Bash(rm *)"], "deletes files");
  assert.equal(by["Bash(git push *)"], "publishes commits");
  assert.equal(by["Bash(npm install *)"], "installs and runs third-party code");
  assert.equal(by["Bash(make *)"], null);
});

test("refused commands do not count; commands a person approved are counted apart", () => {
  const s = sandbox();
  writeTranscript(s.cfg, s.proj, [
    { command: "make build", source: "user_temporary" }, { command: "make build", source: "user_permanent" }, { command: "make build", source: "config" },
    { command: "make build", denial: "user-rejected" }, { command: "make build", denial: "permission-rule" },
  ]);
  const m = run(s);
  assert.equal(m.proposals[0].count, 3);
  assert.equal(m.proposals[0].byHand, 2);
  assert.equal(m.stats.byHand, 2);
});

test("old transcripts without the decision stamp are still read", () => {
  const s = sandbox();
  writeTranscript(s.cfg, s.proj, times("make build", 3, { old: true }));
  const m = run(s);
  assert.equal(m.proposals[0].count, 3);
  assert.equal(m.proposals[0].byHand, 0);
});

test("commands a deny rule refuses are covered, commands an ask rule prompts for are left to it", () => {
  const s = sandbox({ user: perms({ deny: ["Bash(rm *)"], ask: ["Bash(git push *)"] }) });
  writeTranscript(s.cfg, s.proj, [...times("rm -rf x", 3), ...times("git push", 3)]);
  const m = run(s);
  assert.deepEqual(rules(m), []);
  assert.equal(m.stats.askRule, 3);
  assert.equal(m.stats.covered, 3);
});

test("commands that reach outside the working folders need a Read or Edit rule, not a Bash one", () => {
  const s = sandbox();
  writeTranscript(s.cfg, s.proj, [...times("cat ../x.txt", 3), ...times("cd ..", 3)]);
  const m = run(s);
  assert.deepEqual(rules(m), []);
  assert.equal(m.stats.outside, 6);
});

test("the window is --days: older runs are not read", () => {
  const s = sandbox();
  writeTranscript(s.cfg, s.proj, [{ command: "make build", daysAgo: 100 }, { command: "make build", daysAgo: 95 }, { command: "make build", daysAgo: 91 }, { command: "make build", daysAgo: 5 }]);
  assert.equal(run(s, { days: 90 }).stats.runs, 1);
  assert.equal(run(s, { days: 200 }).stats.runs, 4);
  assert.match(run(s, { days: 90 }).window.since, /^\d{4}-\d{2}-\d{2}$/);
});

test("PowerShell commands are grouped without regard to case", () => {
  const s = sandbox();
  writeTranscript(s.cfg, s.proj, [
    { command: "Get-Process -Name a", tool: "PowerShell" }, { command: "get-process -Name b", tool: "PowerShell" }, { command: "GET-PROCESS", tool: "PowerShell" },
  ]);
  const m = run(s);
  assert.equal(m.proposals.length, 1);
  assert.equal(m.proposals[0].tool, "PowerShell");
  assert.match(m.proposals[0].rule, /^PowerShell\(get-process \*\)$/i);
  assert.equal(m.proposals[0].count, 3);
});

test("--all reads every project and judges each run against the settings of its own project", () => {
  const s = sandbox({ user: perms({ allow: ["Bash(npm test *)"] }) });
  const other = `${s.base}/other-project`;
  writeTranscript(s.cfg, s.proj, [...times("make build", 2), ...times("npm test", 3)], { session: "mine" });
  writeTranscript(s.cfg, other, [...times("make build", 2)], { session: "theirs" });
  assert.deepEqual(rules(run(s)), [], "this project alone: make build ran twice");
  const all = run(s, { all: true });
  assert.deepEqual(rules(all), ["Bash(make build *)"]);
  assert.equal(all.proposals[0].count, 4);
  assert.equal(all.proposals[0].projects.length, 2);
  assert.equal(all.all, true);
});

test("no transcripts: no proposals and no crash", () => {
  const m = run(sandbox());
  assert.deepEqual(m.proposals, []);
  assert.equal(m.stats.files, 0);
});
