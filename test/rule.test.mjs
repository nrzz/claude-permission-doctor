import "./helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { checkRule, hasStar, parseMcp, ruleString, splitRule, wildcardBeforeSubcommand } from "../src/rule.mjs";
import { fine, problems, warned } from "./rule-table.mjs";

// Each row was checked against Claude Code 2.1.295 (`claude doctor` lists the skipped rules, the debug
// log the startup warnings); test/oracle.test.mjs repeats the check when a binary is available.

test("splitRule: a name, a call, a malformed rule", () => {
  assert.deepEqual(splitRule("Bash"), { raw: "Bash", tool: "Bash", content: undefined, shape: "name" });
  assert.deepEqual(splitRule("Bash(npm test)"), { raw: "Bash(npm test)", tool: "Bash", content: "npm test", shape: "call" });
  assert.equal(splitRule("Bash(npm run (x))").content, "npm run (x)", "parentheses inside the content are literal");
  assert.equal(splitRule("Bash(ls").shape, "malformed");
  assert.equal(splitRule("Bash(ls) x").shape, "malformed");
  assert.equal(splitRule("Bash)ls(").shape, "malformed");
  assert.equal(splitRule("Bash()").content, "");
});

test("hasStar ignores an escaped star", () => {
  assert.equal(hasStar("a *"), true);
  assert.equal(hasStar("a \\*"), false);
  assert.equal(hasStar("a \\\\*"), true, "an escaped backslash does not escape the star");
  assert.equal(hasStar("plain"), false);
});

test("parseMcp", () => {
  assert.deepEqual(parseMcp("mcp__github__get_issue"), { server: "github", tool: "get_issue" });
  assert.deepEqual(parseMcp("mcp__github"), { server: "github", tool: null });
  assert.deepEqual(parseMcp("mcp__github__*"), { server: "github", tool: "*" });
  assert.equal(parseMcp("Bash"), null);
});

test("ruleString rebuilds a rule", () => {
  assert.equal(ruleString("Bash", "ls *"), "Bash(ls *)");
  assert.equal(ruleString("Read", undefined), "Read");
});

for (const [rule, behavior, code] of problems) {
  test(`checkRule: ${JSON.stringify(rule)} as ${behavior} is skipped (${code})`, () => {
    const r = checkRule(rule, behavior);
    assert.ok(r.problem, "a problem is reported");
    assert.equal(r.problem.code, code);
    assert.ok(r.problem.message.length > 10 && r.problem.fix.length > 5);
  });
}

for (const [rule, behavior] of fine) {
  test(`checkRule: ${rule} as ${behavior} is accepted without a warning`, () => {
    const r = checkRule(rule, behavior);
    assert.equal(r.problem, null);
    assert.deepEqual(r.warnings, []);
  });
}

for (const [rule, behavior, code, silent] of warned) {
  test(`checkRule: ${rule} as ${behavior} warns ${code}${silent ? " (Claude Code itself says nothing)" : ""}`, () => {
    const r = checkRule(rule, behavior);
    assert.equal(r.problem, null);
    const w = r.warnings.find((x) => x.code === code);
    assert.ok(w, `${code} among ${r.warnings.map((x) => x.code)}`);
    assert.equal(w.silent, silent);
  });
}

test("checkRule: a name that is unknown is not a problem for an allow rule (Claude Code only checks deny and ask)", () => {
  assert.deepEqual(checkRule("Bsh(ls)", "allow").warnings, []);
});

test("checkRule: MultiEdit(x) in an ask rule gets both warnings, as in Claude Code", () => {
  const codes = checkRule("MultiEdit(x)", "ask").warnings.map((w) => w.code);
  assert.deepEqual(codes.sort(), ["file-rule-not-consulted", "unknown-tool"]);
});

test("checkRule: tool names containing _ or * are never reported as unknown", () => {
  assert.deepEqual(checkRule("mcp__a__b", "ask").warnings, []);
  assert.deepEqual(checkRule("My_Tool", "deny").warnings, []);
});

test("wildcardBeforeSubcommand: the stars the docs call out", () => {
  assert.equal(wildcardBeforeSubcommand("git * main"), "git");
  assert.equal(wildcardBeforeSubcommand("git log * main"), null, "after the subcommand it is fine");
  assert.equal(wildcardBeforeSubcommand("* --version"), null);
  assert.equal(wildcardBeforeSubcommand("npm run *"), null);
  assert.equal(wildcardBeforeSubcommand("git -c * status"), "git");
  assert.equal(wildcardBeforeSubcommand("ls *"), null, "two tokens: a trailing wildcard");
  assert.equal(wildcardBeforeSubcommand("git:*"), null);
  assert.equal(wildcardBeforeSubcommand("a * | b"), null, "a shell operator ends the command");
});

test("wildcardBeforeSubcommand says git for the git options warning", () => {
  const r = checkRule("Bash(git * main)", "allow");
  assert.match(r.warnings[0].message, /git options such as -c and --exec-path can run arbitrary commands/);
  assert.doesNotMatch(checkRule("Bash(npm * test)", "allow").warnings[0].message, /git options/);
});
