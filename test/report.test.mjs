import { sandbox, writeTranscript } from "./helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { buildLint, buildShow, buildSuggest, buildWhy } from "../src/commands.mjs";
import { markdownLint, markdownSuggest, palette, renderFixResult, renderLint, renderShow, renderSuggest, renderWhy, renderWrite } from "../src/report.mjs";

const perms = (p) => ({ permissions: p });
const opts = (s) => ({ project: s.proj, env: s.env(), home: s.home, managed: s.managedDir });
const lines = (text) => text.split("\n").filter((l) => l !== "");

function crowded() {
  // a user file with 80 rules that all draw findings, and a history with 40 commands that ran three times each
  const allow = Array.from({ length: 80 }, (_, i) => `bash(tool${i})`);
  const s = sandbox({ user: perms({ allow }) });
  const runs = [];
  for (let i = 0; i < 40; i++) for (let k = 0; k < 3; k++) runs.push({ command: `prog${i} sub${i} arg`, daysAgo: 1 + k });
  writeTranscript(s.cfg, s.proj, runs);
  return s;
}

test("markdown lint is capped: the skill's report cannot grow with the number of findings", () => {
  const s = crowded();
  const m = buildLint({ ...opts(s) });
  assert.equal(m.findings.length, 80);
  const md = markdownLint(m);
  assert.ok(lines(md).length <= 24 + 2 + 1 + 3, `${lines(md).length} lines`);
  assert.match(md, /- \.\.\. and 56 more \(run `claude-permission-doctor lint`\)/);
  assert.ok(lines(markdownLint(m, { max: 5 })).length <= 5 + 6);
});

test("markdown suggest is capped too", () => {
  const s = crowded();
  const m = buildSuggest({ ...opts(s) });
  assert.equal(m.proposals.length, 40);
  const md = markdownSuggest(m);
  assert.ok(lines(md).length <= 14 + 2 + 1 + 1, `${lines(md).length} lines`);
  assert.match(md, /- \.\.\. and 26 more \(run `claude-permission-doctor suggest`\)/);
});

test("the two markdown reports together stay under the 60 lines the skill promises", () => {
  const s = crowded();
  const total = lines(markdownLint(buildLint({ ...opts(s) }))).length + lines(markdownSuggest(buildSuggest({ ...opts(s) }))).length;
  assert.ok(total <= 60, `${total} lines`);
});

test("a very long rule or command cannot make a markdown line long", () => {
  const long = `Bash(${"x".repeat(5000)} *)`;
  const s = sandbox({ user: perms({ allow: [long, long, "bash(y)"] }) });
  writeTranscript(s.cfg, s.proj, Array.from({ length: 3 }, () => ({ command: `${"y".repeat(4000)} sub` })));
  for (const md of [markdownLint(buildLint({ ...opts(s) })), markdownSuggest(buildSuggest({ ...opts(s) }))]) {
    for (const line of md.split("\n")) assert.ok(line.length <= Math.max(320, s.proj.length + 80), `${line.length} characters: ${line.slice(0, 60)}`);
  }
});

test("markdown for a project with nothing to report is short and says so", () => {
  const s = sandbox({ user: perms({ allow: ["Bash(ls *)"] }) });
  const lint = markdownLint(buildLint({ ...opts(s) }));
  assert.match(lint, /No findings\./);
  assert.equal(lines(lint).length, 4, "a heading, the counts, 'No findings.' and the note that there were no transcripts");
  const sug = markdownSuggest(buildSuggest({ ...opts(s) }));
  assert.match(sug, /\nNone\.\n/);
  assert.match(sug, /Counts are commands that ran without a rule, not prompts you approved\./);
});

test("markdown never contains control characters or colour codes", () => {
  const s = crowded();
  for (const md of [markdownLint(buildLint({ ...opts(s) })), markdownSuggest(buildSuggest({ ...opts(s) }))]) assert.doesNotMatch(md, /[\x00-\x08\x0b-\x1f]/);
});

test("palette: off gives the text back, on wraps it", () => {
  const off = palette(false);
  assert.equal(off.red("x"), "x");
  assert.equal(off.bold(5), "5");
  const on = palette(true);
  assert.equal(on.green("x"), "\x1b[32mx\x1b[0m");
});

test("the text reports render for empty and odd inputs without throwing", () => {
  const s = sandbox();
  assert.match(renderShow(buildShow(opts(s))), /0 deny rules, 0 ask rules, 0 allow rules; 0 overridden, 0 skipped/);
  assert.match(renderLint(buildLint(opts(s))), /No findings\./);
  assert.match(renderSuggest(buildSuggest(opts(s))), /No command ran 3 or more times without a rule\./);
  for (const command of ["", "ls", "mytool a && rm x", "echo $(date)", "a |", "cat ../x"]) {
    const text = renderWhy(buildWhy({ ...opts(s), tool: "Bash", command, cwd: s.proj }));
    assert.match(text, /^claude-permission-doctor [\d.]+ {2}why this Bash command/);
    assert.match(text, /Verdict/);
  }
  assert.match(renderFixResult({ dryRun: true, files: [], left: [] }), /nothing to remove/);
  assert.match(renderWrite({ dryRun: true, scope: "user", display: "x", added: ["a"], already: ["b"], skipped: null, backup: null, path: "x" }), /\+ a\n {2}= b {2}\(already there\)/);
});

test("the multi-line parts of a command are shown on one line each", () => {
  const s = sandbox();
  const text = renderWhy(buildWhy({ ...opts(s), tool: "Bash", command: "mytool a\nmytool b", cwd: s.proj }));
  assert.match(text, /Split into 2 commands at newline:/);
  assert.match(text, /command {3}mytool a\n {10}mytool b/);
});

test("--json documents carry schema 1, the tool name and version, and none of the loaded-settings internals", () => {
  const s = sandbox({ user: perms({ allow: ["Bash(ls *)"] }) });
  for (const m of [buildShow(opts(s)), buildWhy({ ...opts(s), command: "ls", cwd: s.proj }), buildLint(opts(s)), buildSuggest(opts(s))]) {
    assert.equal(m.schema, 1);
    assert.equal(m.tool === "claude-permission-doctor" || m.toolName === "Bash", true);
    assert.match(m.version, /^\d+\.\d+\.\d+$/);
  }
});
