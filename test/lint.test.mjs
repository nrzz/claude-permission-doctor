import { sandbox, writeTranscript } from "./helpers.mjs";
import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { buildLint } from "../src/commands.mjs";
import { loadSettings } from "../src/settings.mjs";
import { lintSettings, ruleLine, ruleUsage } from "../src/lint.mjs";

const DAY = 86400000;
const perms = (p) => ({ permissions: p });
const lint = (s, extra = {}) => buildLint({ project: s.proj, env: s.env(), home: s.home, managed: s.managedDir, transcripts: false, ...extra });
const ids = (m) => m.findings.map((f) => f.id).sort();
const find = (m, id, rule) => m.findings.find((f) => f.id === id && (rule === undefined || f.rule === rule));

test("a clean set of rules has no findings", () => {
  const m = lint(sandbox({ user: perms({ allow: ["Bash(npm test)", "Bash(git status *)"], deny: ["Read(./.env)"] }) }));
  assert.deepEqual(m.findings, []);
  assert.deepEqual(m.summary, { error: 0, warn: 0, note: 0, fixable: 0 });
});

test("each way a rule goes wrong has its own finding", () => {
  const s = sandbox({
    user: perms({
      allow: ["bash(ls)", "*", "Bash(git * main)", "Bash(git * main:*)", "Bash(npm run test:* x)", "Write(src/**)", "Bash(command:mytool *)"],
      deny: ["Bash(command:rm *)", "Terminal"],
      ask: ["Bash(", "Bsh(x)"],
    }),
  });
  const m = lint(s);
  assert.equal(find(m, "malformed-rule", "bash(ls)").severity, "warn");
  assert.equal(find(m, "unanchored-glob", "*").code, "allow-glob");
  assert.ok(find(m, "wildcard-before-subcommand", "Bash(git * main)"));
  assert.ok(find(m, "star-with-prefix", "Bash(git * main:*)"));
  assert.ok(find(m, "colon-star-not-at-end", "Bash(npm run test:* x)"));
  assert.ok(find(m, "file-rule-not-consulted", "Write(src/**)"));
  assert.ok(find(m, "raw-field-allow", "Bash(command:mytool *)").silent);
  assert.ok(find(m, "raw-field", "Bash(command:rm *)"));
  assert.equal(find(m, "unknown-tool", "Terminal").severity, "note", "a typo is a note: the tool list is a snapshot");
  assert.equal(find(m, "malformed-rule", "Bash(").code, "malformed");
  assert.ok(find(m, "unknown-tool", "Bsh(x)"));
  for (const f of m.findings) {
    assert.ok(f.message.length > 15 && f.fix.length > 5, `${f.id} says what and how to fix`);
    assert.equal(f.file, s.userFile);
    assert.ok(f.line >= 1, `${f.id} has a line number`);
    assert.ok(f.display, "and a display name for the file");
  }
});

test("findings are ordered errors first, then warnings, then notes", () => {
  const s = sandbox({ user: perms({ allow: ["bash(x)"], deny: ["Terminal"] }), project: "{ nope" });
  const m = lint(s);
  assert.deepEqual(m.findings.map((f) => f.severity), ["error", "warn", "note"]);
});

test("a settings file that is not valid JSON is an error", () => {
  const m = lint(sandbox({ project: "{ \"permissions\": { \"allow\": [ \"Bash(a *)\", ] } }" }));
  const f = find(m, "settings-unreadable");
  assert.equal(f.severity, "error");
  assert.match(f.message, /project settings is not valid JSON/);
  assert.match(f.message, /Claude Code skips the whole file/);
});

test("a duplicate is reported once, on the copy in the lower file, and only user and local copies are removable", () => {
  const s = sandbox({ user: perms({ allow: ["Bash(git status *)", "Bash(ls:*)"] }), project: perms({ allow: ["Bash(git status *)"] }), local: perms({ allow: ["Bash(git status *)", "Bash(npm test)", "Bash(npm test)"] }) });
  const m = lint(s);
  const dups = m.findings.filter((f) => f.id === "duplicate-rule");
  assert.deepEqual(dups.map((f) => `${f.scope}:${f.rule}:${f.autofix}`).sort(), ["local:Bash(git status *):true", "local:Bash(npm test):true", "user:Bash(git status *):true"]);
  assert.match(dups.find((f) => f.scope === "user").message, /repeats the same rule in project settings/);
  assert.match(dups.find((f) => f.rule === "Bash(npm test)").message, /repeats an earlier entry of the same list/);
});

test("two copies in the shared project file are removable (one of them), a duplicate across project and managed is not", () => {
  const s = sandbox({ project: perms({ allow: ["Bash(x *)", "Bash(x *)"] }), managed: perms({ allow: ["Bash(m *)"] }) });
  const same = lint(s).findings.find((f) => f.id === "duplicate-rule");
  assert.equal(same.autofix, true, "the same list in the same file: remove the later entry");
  assert.equal(same.index, 1);
  const s2 = sandbox({ project: perms({ allow: ["Bash(m *)"] }), managed: perms({ allow: ["Bash(m *)"] }) });
  const cross = lint(s2).findings.find((f) => f.id === "duplicate-rule");
  assert.equal(cross.scope, "project");
  assert.equal(cross.autofix, false, "the shared project file belongs to the team");
});

test("ls:* and ls * are one rule spelled twice: a mixed-syntax finding on the colon spelling, which --fix can remove", () => {
  const m = lint(sandbox({ user: perms({ allow: ["Bash(ls:*)", "Bash(ls *)"] }) }));
  assert.deepEqual(ids(m), ["mixed-syntax"]);
  const f = m.findings[0];
  assert.equal(f.rule, "Bash(ls:*)");
  assert.equal(f.severity, "note");
  assert.equal(f.autofix, true);
  assert.match(f.message, /means the same as Bash\(ls \*\) in the same file/);
  // the spelling does not matter for which copy stays: the one in the higher file does
  const m2 = lint(sandbox({ user: perms({ allow: ["Bash(ls *)"] }), project: perms({ allow: ["Bash(ls:*)"] }) }));
  assert.deepEqual(m2.findings.map((x) => [x.id, x.scope, x.rule]), [["mixed-syntax", "user", "Bash(ls *)"]]);
});

test("an allow rule that a deny or ask rule covers is shadowed, in whatever file", () => {
  const s = sandbox({
    user: perms({ allow: ["Bash(git push origin main)", "Bash(npm test)", "Bash(rm -rf node_modules)"], ask: ["Bash(npm *)"] }),
    project: perms({ deny: ["Bash(git push *)"] }),
    local: perms({ allow: ["Read(./.env)"], deny: ["Read(./.env)"] }),
  });
  const m = lint(s);
  const shadows = m.findings.filter((f) => f.id === "shadowed-rule");
  assert.deepEqual(shadows.map((f) => f.rule).sort(), ["Bash(git push origin main)", "Bash(npm test)", "Read(./.env)"]);
  assert.match(find(m, "shadowed-rule", "Bash(git push origin main)").message, /never allows anything: it is denied by Bash\(git push \*\)/);
  assert.match(find(m, "shadowed-rule", "Bash(npm test)").message, /always prompts: it is asked about by Bash\(npm \*\)/);
  assert.equal(find(m, "shadowed-rule", "Bash(rm -rf node_modules)"), undefined);
});

test("an ask rule under a deny rule never gets to ask", () => {
  const m = lint(sandbox({ user: perms({ ask: ["Bash(git push *)"], deny: ["Bash(git *)"] }) }));
  assert.equal(find(m, "shadowed-rule", "Bash(git push *)").overriddenBy, "Bash(git *)");
});

test("an unknown tool name is not a finding for an allow rule", () => {
  assert.deepEqual(lint(sandbox({ user: perms({ allow: ["Terminal"] }) })).findings, []);
});

test("managed settings that allow only managed rules: a note, and the other files' rules are reported as ignored", () => {
  const s = sandbox({ managed: { allowManagedPermissionRulesOnly: true, permissions: { deny: ["Bash(m *)"] } }, user: perms({ allow: ["Bash(a *)"] }) });
  const m = lint(s);
  const f = find(m, "managed-only");
  assert.equal(f.severity, "note");
  assert.equal(f.file, s.managedFile);
});

test("ruleLine finds the n-th identical entry of a list", () => {
  const text = `{\n  "permissions": {\n    "allow": [\n      "Bash(a)",\n      "Bash(b)",\n      "Bash(a)"\n    ],\n    "deny": ["Bash(a)"]\n  }\n}\n`;
  assert.equal(ruleLine(text, "allow", "Bash(a)", 0), 4);
  assert.equal(ruleLine(text, "allow", "Bash(a)", 1), 6);
  assert.equal(ruleLine(text, "allow", "Bash(b)", 0), 5);
  assert.equal(ruleLine(text, "deny", "Bash(a)", 0), 8, "a list on one line");
  assert.equal(ruleLine(text, "ask", "Bash(a)", 0), null);
  assert.equal(ruleLine(text, "allow", "Bash(zzz)", 0), null);
  assert.equal(ruleLine(null, "allow", "x"), null);
});

test("a finding carries the line of its rule", () => {
  const s = sandbox({ user: `{\n  "permissions": {\n    "allow": [\n      "Bash(ls *)",\n      "Bash(ls *)"\n    ]\n  }\n}\n` });
  const f = find(lint(s), "duplicate-rule");
  assert.equal(f.line, 5);
  assert.match(f.message, /line 4/);
});

// --- dead rules --------------------------------------------------------------------------------------------------------

function deadSandbox(runs, { oldFile = true } = {}) {
  const s = sandbox({ user: perms({ allow: ["Bash(make deploy)", "Bash(make build)", "Bash(make test)", "Bash(npm run lint)", "Bash(make all *)"] }) });
  if (oldFile) {
    const old = new Date(Date.now() - 60 * DAY);
    fs.utimesSync(s.userFile, old, old);
  }
  writeTranscript(s.cfg, s.proj, runs);
  return s;
}
const dead = (m) => m.findings.filter((f) => f.id === "dead-rule").map((f) => f.rule).sort();

test("dead rules: an exact rule used once long ago or never is dead; one used again, recently or as a prefix is not", () => {
  const s = deadSandbox([
    { command: "make deploy", daysAgo: 40 },
    { command: "make build", daysAgo: 30 }, { command: "make build", daysAgo: 20 }, { command: "make build", daysAgo: 10 },
    { command: "make test", daysAgo: 3 },
    { command: "make all one", daysAgo: 50 },
  ]);
  const m = lint(s, { transcripts: true });
  assert.deepEqual(dead(m), ["Bash(make deploy)", "Bash(npm run lint)"]);
  assert.match(find(m, "dead-rule", "Bash(make deploy)").message, /used once in the last 90 days, most likely the approval that created it/);
  assert.match(find(m, "dead-rule", "Bash(npm run lint)").message, /never used in the last 90 days/);
  assert.equal(find(m, "dead-rule", "Bash(make deploy)").autofix, true);
  assert.equal(m.scanned.runs, 6);
});

test("dead rules: a file written in the last two weeks is not judged on 'never used'", () => {
  const s = deadSandbox([{ command: "make build", daysAgo: 1 }, { command: "make build", daysAgo: 2 }], { oldFile: false });
  assert.deepEqual(dead(lint(s, { transcripts: true })), [], "the rule may have been added minutes ago");
});

test("dead rules: refused commands do not count as use", () => {
  const s = deadSandbox([{ command: "make build", daysAgo: 30 }, { command: "make build", daysAgo: 20, denial: "user-rejected" }, { command: "make build", daysAgo: 10, denial: "permission-rule" }]);
  assert.ok(dead(lint(s, { transcripts: true })).includes("Bash(make build)"));
});

test("dead rules: the window is --days", () => {
  const s = deadSandbox([{ command: "make deploy", daysAgo: 40 }, { command: "make deploy", daysAgo: 30 }, { command: "make deploy", daysAgo: 20 }]);
  assert.ok(!dead(lint(s, { transcripts: true, days: 90 })).includes("Bash(make deploy)"));
  assert.ok(dead(lint(s, { transcripts: true, days: 10 })).includes("Bash(make deploy)"), "in a 10 day window it was never used");
});

test("dead rules: without transcripts they are not judged, and the report says so", () => {
  const s = sandbox({ user: perms({ allow: ["Bash(make deploy)"] }) });
  const old = new Date(Date.now() - 60 * DAY);
  fs.utimesSync(s.userFile, old, old);
  const m = lint(s, { transcripts: true });
  assert.deepEqual(dead(m), []);
  assert.ok(m.notes.some((n) => n.includes("no transcripts from the last 90 days were found") && n.includes("dead rules were not checked")));
});

test("dead rules: a duplicate or a shadowed rule is reported as that, not also as dead", () => {
  const s = sandbox({ user: perms({ allow: ["Bash(make deploy)", "Bash(make deploy)", "Bash(make build)"], deny: ["Bash(make build)"] }) });
  const old = new Date(Date.now() - 60 * DAY);
  fs.utimesSync(s.userFile, old, old);
  writeTranscript(s.cfg, s.proj, [{ command: "ls", daysAgo: 30 }]);
  const m = lint(s, { transcripts: true });
  assert.deepEqual(dead(m), ["Bash(make deploy)"], "once for the two copies, and make build is shadowed, not dead");
  assert.equal(m.findings.filter((f) => f.id === "duplicate-rule").length, 1);
  assert.equal(m.findings.filter((f) => f.id === "shadowed-rule").length, 1);
});

test("dead rules: a project rule is judged on this project's transcripts, a user rule on every project's", () => {
  const s = sandbox({ user: perms({ allow: ["Bash(make elsewhere)"] }), project: perms({ allow: ["Bash(make elsewhere2)"] }) });
  const old = new Date(Date.now() - 60 * DAY);
  fs.utimesSync(s.userFile, old, old);
  fs.utimesSync(s.projectFile, old, old);
  const other = `${s.base}/other-project`;
  writeTranscript(s.cfg, other, [{ command: "make elsewhere", daysAgo: 5 }, { command: "make elsewhere", daysAgo: 6 }, { command: "make elsewhere2", daysAgo: 5 }, { command: "make elsewhere2", daysAgo: 6 }]);
  writeTranscript(s.cfg, s.proj, [{ command: "ls", daysAgo: 5 }]);
  const m = lint(s, { transcripts: true });
  assert.deepEqual(dead(m), ["Bash(make elsewhere2)"]);
});

test("ruleUsage: exact rules are counted against every simple command, PowerShell ignoring case and aliases", () => {
  const s = sandbox({ user: perms({ allow: ["Bash(make deploy)", "PowerShell(Get-ChildItem)", "Bash(npm *)"] }) });
  const st = loadSettings({ project: s.proj, env: s.env(), home: s.home, managed: s.managedDir });
  const runs = [
    { tool: "Bash", command: "make deploy", ts: new Date(Date.now() - 5 * DAY).toISOString() },
    { tool: "Bash", command: "cd sub && make deploy", ts: new Date(Date.now() - 4 * DAY).toISOString() },
    { tool: "Bash", command: "timeout 5 make deploy" },
    { tool: "Bash", command: "make deploy now" },
    { tool: "PowerShell", command: "ls" },
    { tool: "PowerShell", command: "get-childitem" },
    { tool: "Bash", command: "npm test" },
  ];
  const { counted } = ruleUsage(st, runs);
  const by = Object.fromEntries([...counted].map(([r, u]) => [r.raw, u]));
  assert.equal(by["Bash(make deploy)"].count, 3);
  assert.equal(by["PowerShell(Get-ChildItem)"].count, 2);
  assert.equal(by["Bash(npm *)"], undefined, "only exact rules are counted");
  assert.ok(by["Bash(make deploy)"].last > 0);
});

test("lintSettings can be given usage directly (the unit the report builds on)", () => {
  const s = sandbox({ user: perms({ allow: ["Bash(make deploy)"] }) });
  const old = new Date(Date.now() - 60 * DAY);
  fs.utimesSync(s.userFile, old, old);
  const st = loadSettings({ project: s.proj, env: s.env(), home: s.home, managed: s.managedDir });
  for (const f of st.files) f.mtimeMs = f.exists ? old.getTime() : 0;
  const { findings } = lintSettings(st, { usage: ruleUsage(st, []), now: Date.now(), days: 90 });
  assert.deepEqual(findings.map((f) => f.id), ["dead-rule"]);
});
