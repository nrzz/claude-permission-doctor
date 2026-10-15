import "./helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { compileWildcard, covers, matches, parseContent } from "../src/pattern.mjs";
import { overrides, ruleKey } from "../src/overrides.mjs";

const m = (rule, text, opts) => matches(parseContent(rule), text, opts);

test("parseContent: exact, prefix and wildcard", () => {
  assert.equal(parseContent("npm test").type, "exact");
  assert.equal(parseContent("npm test *").type, "wildcard");
  assert.equal(parseContent("npm:*").type, "prefix");
  assert.equal(parseContent("npm:*").prefix, "npm");
  assert.equal(parseContent("git:* push").type, "wildcard", ":* that is not at the end is a wildcard with a literal colon");
  assert.equal(parseContent("a \\*").type, "exact", "an escaped star is not a wildcard");
  assert.equal(parseContent("ls*").type, "wildcard");
});

// [rule, command, matches]. Every row was checked against Claude Code 2.1.295.
const rows = [
  ["mytool deploy", "mytool deploy", true],
  ["mytool deploy", "mytool deploy --prod", false],
  ["mytool deploy", "mytool  deploy", false], // an exact rule is exact
  ["mytool *", "mytool", true], // a trailing " *" also matches the bare command
  ["mytool *", "mytool deploy", true],
  ["mytool *", "mytoolx", false], // the space before the star is part of the rule
  ["mytool *", "mytool  deploy", true], // runs of spaces count as one in wildcard rules
  ["mytool *", "mytool a\tb", true],
  ["mytool *", "MYTOOL deploy", false], // Bash rules are case-sensitive
  ["mytool:*", "mytool", true],
  ["mytool:*", "mytool deploy", true],
  ["mytool:*", "mytoolx", false],
  ["mytool a b:*", "mytool a  b c", true],
  ["mytool a:*", "mytool ax", false],
  ["mytool*", "mytoolx deploy", true],
  ["mytool*", "mytool", true],
  ["mytool deploy*", "mytool deployment", true],
  ["* --version", "mytool --version", true],
  ["* --version", "mytool -v", false],
  ["mytool * main", "mytool a b main", true],
  ["mytool * main", "mytool main", false], // two spaces are needed around the star
  ["mytool * main", "mytool a main x", false],
  ["mytool:* main", "mytool:x main", true], // :* in the middle: the colon is literal
  ["mytool:* main", "mytool a main", false],
  ["* --help *", "npm --help x", true],
  ["* --help *", "npm --help", false], // the bare-command rule needs a single star
  ["mytool \\*", "mytool \\*", true], // an escaped star is literal text, compared as written
  ["mytool \\*", "mytool x", false],
  ["mytool **", "mytool x", true],
  ["git log * main", "git log --oneline main", true],
  ["git log * main", "git log main", false],
  ["git * main", "git -c core.fsmonitor=x diff main", true],
  ["ls *", "lsof", false],
  ["ls*", "lsof", true],
  ["a (b) *", "a (b) c", true], // parentheses are literal
  ["a.b *", "axb c", false], // regex characters are literal
  ["mytool *", "mytool \"two\nlines\"", true], // * also matches a line break inside a quoted string
];
for (const [rule, text, expected] of rows) {
  test(`matches: Bash(${rule}) ${expected ? "matches" : "does not match"} ${JSON.stringify(text)}`, () => {
    assert.equal(m(rule, text), expected);
  });
}

test("matches: PowerShell rules are not case-sensitive", () => {
  assert.equal(m("Get-ChildItem *", "get-childitem -Path .", { ignoreCase: true }), true);
  assert.equal(m("Get-ChildItem", "GET-CHILDITEM", { ignoreCase: true }), true);
  assert.equal(m("npm:*", "NPM test", { ignoreCase: true }), true);
  assert.equal(m("Get-ChildItem *", "get-childitem", { ignoreCase: false }), false);
});

test("compileWildcard: a pattern with many stars on a long input takes linear time", () => {
  const stars = Array.from({ length: 40 }, () => "x").join(" * ");
  const m = compileWildcard(`a * ${stars} * e *`);
  const t0 = Date.now();
  assert.equal(m.test(`a ${"x ".repeat(200000)}z`), false);
  assert.equal(m.test(`a ${"x ".repeat(200000)}e z`), true);
  assert.ok(Date.now() - t0 < 2000, `${Date.now() - t0} ms`);
});

test("compileWildcard: the pieces between the stars must come in order and not overlap", () => {
  const t = (p, s, ci = false) => compileWildcard(p, { ignoreCase: ci }).test(s);
  assert.equal(t("a*b*c", "abc"), true);
  assert.equal(t("a*b*c", "acb"), false);
  assert.equal(t("ab*bc", "abc"), false, "the start and the end cannot share a letter");
  assert.equal(t("ab*bc", "abbc"), true);
  assert.equal(t("*b*b*", "ab"), false);
  assert.equal(t("*b*b*", "abb"), true);
  assert.equal(t("a * b", "a x b"), true);
  assert.equal(t("a * b", "a b"), false);
  assert.equal(t("git *", "git"), true, "a single trailing star after a space also matches the bare command");
  assert.equal(t("git * *", "git"), false);
  assert.equal(t("GIT *", "git status", true), true);
  assert.equal(t("a  *  b", "a x b"), true, "runs of spaces count as one");
  assert.equal(t("a\\\\*", "a\\"), true, "an escaped backslash, then a star");
  assert.equal(t("*", ""), true);
  assert.equal(t("**", "anything\nat all"), true, "a star also takes a line break");
});

// covers(outer, inner): is everything inner allows also matched by outer?
const coverRows = [
  ["git push *", "git push origin main", true],
  ["git push *", "git push", true],
  ["git push *", "git push *", true],
  ["git push *", "git *", false],
  ["git *", "git push *", true],
  ["git *", "git push origin main", true],
  ["git push origin main", "git push *", false],
  ["git push origin main", "git push origin main", true],
  ["git:*", "git status", true],
  ["git:*", "git status *", true],
  ["git:*", "gitk", false],
  ["git *", "git:*", true],
  ["git push:*", "git push *", true],
  ["git push*", "git push", true],
  ["git push*", "git pusher *", true],
  ["git push *", "git pusher", false],
  ["rm *", "rm -rf build", true],
  ["rm *", "rmdir x", false],
  ["* --version", "node --version", true],
  ["*", "anything at all *", true],
  ["npm run *", "npm run build", true],
  ["npm run build", "npm run *", false],
];
for (const [outer, inner, expected] of coverRows) {
  test(`covers: Bash(${outer}) ${expected ? "covers" : "does not cover"} Bash(${inner})`, () => {
    assert.equal(covers(parseContent(outer), parseContent(inner)), expected);
  });
}

const rule = (behavior, raw, tool = "Bash", content) => {
  const c = content !== undefined ? content : raw.slice(raw.indexOf("(") + 1, -1);
  return { behavior, raw, tool, content: raw.includes("(") ? c : undefined, bare: !raw.includes("(") || c === "*", parsed: raw.includes("(") ? parseContent(c) : null, problem: null };
};

test("overrides: a deny rule overrides an allow rule it covers, in any file", () => {
  assert.equal(overrides(rule("deny", "Bash(git push *)"), rule("allow", "Bash(git push origin main)")), true);
  assert.equal(overrides(rule("deny", "Bash(git push origin main)"), rule("allow", "Bash(git push *)")), false, "a narrower deny does not cover the wider allow");
  assert.equal(overrides(rule("ask", "Bash(npm *)"), rule("allow", "Bash(npm test)")), true);
  assert.equal(overrides(rule("deny", "Bash(rm *)"), rule("ask", "Bash(rm -rf x)")), true, "deny beats ask");
  assert.equal(overrides(rule("allow", "Bash(npm *)"), rule("deny", "Bash(npm test)")), false);
  assert.equal(overrides(rule("allow", "Bash(npm *)"), rule("allow", "Bash(npm test)")), false, "two allow rules never override each other");
});

test("overrides: a bare tool rule covers every rule of the tool; other tools are not compared", () => {
  assert.equal(overrides(rule("deny", "Bash"), rule("allow", "Bash(ls *)")), true);
  assert.equal(overrides(rule("deny", "Bash(*)"), rule("allow", "Bash(ls *)")), true);
  assert.equal(overrides(rule("deny", "WebFetch", "WebFetch"), rule("allow", "Bash(ls *)")), false);
  assert.equal(overrides(rule("deny", "Read(./.env)", "Read"), rule("allow", "Read(./.env)", "Read")), true, "path rules: only an identical rule counts");
  assert.equal(overrides(rule("deny", "Read(./**)", "Read"), rule("allow", "Read(./src/a)", "Read")), false, "path globs are not compared");
});

test("ruleKey: ls:* and ls * are the same rule", () => {
  const a = { ...rule("allow", "Bash(ls:*)"), parsed: parseContent("ls:*") };
  const b = { ...rule("allow", "Bash(ls *)"), parsed: parseContent("ls *") };
  assert.equal(ruleKey(a), ruleKey(b));
  assert.notEqual(ruleKey(a), ruleKey({ ...b, behavior: "deny" }));
  assert.equal(ruleKey({ ...rule("allow", "Bash"), bare: true }), ruleKey({ ...rule("allow", "Bash(*)"), bare: true }));
});
