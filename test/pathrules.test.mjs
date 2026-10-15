import { tmp } from "./helpers.mjs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { pathRuleMatches, posixForm } from "../src/pathrules.mjs";
import { insideAny, leavesFolder, resolveArg, toPosix } from "../src/paths.mjs";
import { denyRows } from "./path-table.mjs";

const cwd = tmp("pd-pr-cwd-");
const home = tmp("pd-pr-home-");
const cfg = tmp("pd-pr-cfg-");
const elsewhere = tmp("pd-pr-else-");
const hit = (content, rel, { behavior = "deny", scope = "project", file } = {}) =>
  pathRuleMatches(content, file || path.join(cwd, ...rel.split("/")), { behavior, scope, cwd, home, configDir: cfg });

for (const [rule, file, expected] of denyRows) {
  test(`pathRuleMatches: Read(${rule}) ${expected ? "reaches" : "does not reach"} ${file} (deny)`, () => {
    assert.equal(hit(rule, file), expected);
  });
}

test("pathRuleMatches: dir/** at any depth is for deny and ask rules; an allow rule is tied to its anchor", () => {
  assert.equal(hit("src/**", "x/src/a.ts", { behavior: "deny" }), true);
  assert.equal(hit("src/**", "x/src/a.ts", { behavior: "ask" }), true);
  assert.equal(hit("src/**", "x/src/a.ts", { behavior: "allow" }), false);
  assert.equal(hit("src/**", "src/a.ts", { behavior: "allow" }), true);
  assert.equal(hit("src/a/**", "x/src/a/b.ts", { behavior: "deny" }), false, "only a single folder name before /** is matched at any depth");
});

test("pathRuleMatches: /path is tied to the folder of the settings file", () => {
  assert.equal(hit("/src/**", "src/a.ts", { scope: "project" }), true);
  assert.equal(hit("/src/**", "x/src/a.ts", { scope: "project" }), false);
  assert.equal(hit("/src/**", "src/a.ts", { scope: "local" }), true);
  // a user rule starts at the config folder, not at the project
  assert.equal(hit("/skills/**", "skills/a.md", { scope: "user" }), false);
  assert.equal(hit("/skills/**", "ignored", { scope: "user", file: path.join(cfg, "skills", "a.md") }), true);
});

test("pathRuleMatches: ~/ starts at the home folder and // at the root", () => {
  assert.equal(hit("~/notes/**", "", { file: path.join(home, "notes", "a.txt") }), true);
  assert.equal(hit("~/notes/**", "", { file: path.join(home, "other", "a.txt") }), false);
  assert.equal(hit("~/.ssh/id_rsa", "", { file: path.join(home, ".ssh", "id_rsa") }), true);
  const abs = posixForm(path.join(elsewhere, "shared"));
  assert.equal(hit(`/${abs}/**`, "", { file: path.join(elsewhere, "shared", "a.txt") }), true);
  assert.equal(hit(`/${abs}/**`, "", { file: path.join(elsewhere, "other", "a.txt") }), false);
  assert.equal(hit(`/${abs}`, "", { file: path.join(elsewhere, "shared", "a.txt") }), true, "a folder reaches what is inside");
});

test("pathRuleMatches: a third slash after the // is ignored", () => {
  const abs = posixForm(path.join(elsewhere, "shared"));
  const file = path.join(elsewhere, "shared", "a.txt");
  assert.equal(hit(`//${abs}/**`, "", { file }), true);
  assert.equal(hit(`/${abs}/**`, "", { file }), true);
});

test("pathRuleMatches: an absolute Windows path in a rule works with either kind of slash", { skip: process.platform !== "win32" }, () => {
  const file = path.join(elsewhere, "shared", "a.txt");
  assert.equal(hit(file, "", { file }), true);
  assert.equal(hit(file.split("\\").join("/"), "", { file }), true);
  assert.equal(hit(`${path.join(elsewhere, "shared")}\\**`, "", { file }), true);
  assert.equal(hit(path.join(elsewhere, "other", "a.txt"), "", { file }), false);
  assert.equal(hit(`//${file}`, "", { file }), false, "// in front of a drive path is not an anchor for it");
});

test("pathRuleMatches: a character class has no negation, and one that cannot be read matches nothing", () => {
  assert.equal(hit("a.[!t]xt", "a.txt"), true, "! is just a member");
  assert.equal(hit("a.[!t]xt", "a.cxt"), false);
  assert.equal(hit("a.[^t]xt", "a.txt"), true);
  assert.equal(hit("a.[^t]xt", "a.^xt"), true);
  assert.equal(hit("a.[}-)]xt", "a.txt"), false, "an out-of-order range does not throw");
  assert.equal(hit("[", "["), true, "a lone [ is itself");
});

test("pathRuleMatches: an escaped star or question mark is a character, not a quantifier", () => {
  assert.equal(hit("a\\*", "a"), false);
  assert.equal(hit("a\\*", "a*"), true);
  assert.equal(hit("a\\?", "aa"), false);
});

test("pathRuleMatches: a relative rule does not reach a file outside the working folder", () => {
  assert.equal(hit(".env", "", { file: path.join(elsewhere, ".env") }), false);
  assert.equal(hit("**/.env", "", { file: path.join(elsewhere, ".env") }), false);
});

test("pathRuleMatches: the folder itself is not matched by its own contents rule", () => {
  assert.equal(hit("src/**", "", { file: cwd }), false);
});

test("posixForm: the form Claude Code matches on", () => {
  if (process.platform === "win32") {
    assert.equal(posixForm("C:\\Users\\a\\b"), "/c/Users/a/b");
    assert.equal(posixForm("D:\\"), "/d");
  } else {
    assert.equal(posixForm("/usr/local/bin"), "/usr/local/bin");
    assert.equal(posixForm("/"), "/");
  }
});

test("paths: leavesFolder, resolveArg, insideAny", () => {
  assert.equal(leavesFolder("a/b"), false);
  assert.equal(leavesFolder("./a"), false);
  assert.equal(leavesFolder("../a"), true);
  assert.equal(leavesFolder("a/../../b"), true);
  assert.equal(leavesFolder("/etc"), true);
  assert.equal(leavesFolder("~"), true);
  assert.equal(leavesFolder("~/x"), true);
  assert.equal(leavesFolder("C:\\x"), true);
  assert.equal(leavesFolder("C:/x"), true);
  assert.equal(leavesFolder(""), false);

  assert.equal(resolveArg("a/b", cwd, home), path.join(cwd, "a", "b"));
  assert.equal(resolveArg("../a", cwd, home), path.resolve(cwd, "..", "a"));
  assert.equal(resolveArg("~/x", cwd, home), path.join(home, "x"));
  assert.equal(resolveArg("~", cwd, home), home);
  assert.equal(resolveArg("~bob/x", cwd, home), null, "another user's home cannot be known");
  assert.equal(resolveArg("*.txt", cwd, home), null, "a glob names no one file");
  assert.equal(resolveArg("$X/a", cwd, home), null);
  assert.equal(resolveArg("a?b", cwd, home), null);
  assert.equal(resolveArg("", cwd, home), null);
  assert.equal(resolveArg(undefined, cwd, home), null);

  assert.equal(insideAny(cwd, [cwd]), true);
  assert.equal(insideAny(path.join(cwd, "a", "b"), [cwd]), true);
  assert.equal(insideAny(path.join(cwd, "..", "x"), [cwd]), false);
  assert.equal(insideAny(path.join(cwd, "a"), [elsewhere, cwd]), true);
  assert.equal(insideAny(cwd + "x", [cwd]), false, "a sibling whose name starts the same is not inside");
  assert.equal(toPosix("a\\b\\c"), "a/b/c");
});

test("resolveArg: Git Bash writes C:\\Users as /c/Users", { skip: process.platform !== "win32" }, () => {
  assert.equal(resolveArg("/c/Users/x", cwd, home), path.resolve("C:\\Users\\x"));
  assert.equal(resolveArg("/c", cwd, home), path.resolve("C:\\"));
});
