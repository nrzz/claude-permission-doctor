import "./helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { parseBash, textFrom } from "../src/shell.mjs";

const NL = "\n";
const read = (s) => {
  const r = parseBash(s);
  return { ok: r.ok, texts: r.cmds.map((c) => c.text), issues: [...new Set(r.issues.map((i) => i.kind))].sort(), seps: r.seps, problem: r.problem, r };
};

// --- splitting ------------------------------------------------------------------------------

const splits = [
  ["mytool a && mytool b", ["mytool a", "mytool b"], ["&&"]],
  ["mytool a || mytool b", ["mytool a", "mytool b"], ["||"]],
  ["mytool a ; mytool b", ["mytool a", "mytool b"], [";"]],
  ["mytool a; mytool b", ["mytool a", "mytool b"], [";"]],
  ["mytool a | mytool b", ["mytool a", "mytool b"], ["|"]],
  ["mytool a |& mytool b", ["mytool a", "mytool b"], ["|&"]],
  [`mytool a${NL}mytool b`, ["mytool a", "mytool b"], ["\n"]],
  ["mytool a && mytool b || mytool c | mytool d", ["mytool a", "mytool b", "mytool c", "mytool d"], ["&&", "||", "|"]],
  ['mytool "a && b"', ['mytool "a && b"'], []],
  ["mytool 'a ; b'", ["mytool 'a ; b'"], []],
  ["mytool a # && othertool", ["mytool a"], []],
  ["mytool a\\; othertool", ["mytool a\\; othertool"], []],
  ["mytool a;", ["mytool a"], [";"]],
  ["mytool a |", ["mytool a"], ["|"]],
  ["  mytool a  ", ["mytool a"], []],
  ["# only a comment", [], []],
  ["", [], []],
  ["git status && git diff | head", ["git status", "git diff", "head"], ["&&", "|"]],
  ["if true; then mytool a; else mytool b; fi", ["true", "mytool a", "mytool b"], []],
  ["for f in a b; do mytool a; done", ["mytool a"], []],
  ["while false; do mytool a; done", ["false", "mytool a"], []],
  ["(mytool a; mytool b)", ["mytool a", "mytool b"], []],
  ["{ mytool a; }", ["mytool a"], [";"]],
  ["echo $(mytool a)", ["mytool a", "echo $(mytool a)"], []],
  ["echo `mytool a`", ["mytool a", "echo `mytool a`"], []],
  ["case x in a) mytool a;; b|c) mytool b;; esac && mytool z", ["mytool a", "mytool b", "mytool z"], ["&&"]],
  ["[[ -f x ]] && mytool a", ["[[ -f x ]]", "mytool a"], ["&&"]],
  ["! mytool a", ["mytool a"], []],
  ["mytool a && ! mytool b", ["mytool a", "mytool b"], ["&&"]],
];
for (const [src, texts, seps] of splits) {
  test(`parseBash splits ${JSON.stringify(src)}`, () => {
    const r = read(src);
    assert.equal(r.ok, true, r.problem);
    assert.deepEqual(r.texts.sort(), [...texts].sort());
    assert.deepEqual(r.seps, seps);
  });
}

// --- redirections are not part of the text a rule sees ---------------------------------------------

const redirects = [
  ["mytool a 2>&1", "mytool a"],
  ["mytool a > out.txt", "mytool a"],
  ["mytool a >> out.txt", "mytool a"],
  ["mytool a >/dev/null 2>&1", "mytool a"],
  ["mytool a &>/dev/null", "mytool a"],
  ["mytool a < in.txt", "mytool a"],
  ["mytool a >&2", "mytool a"],
  ["mytool a 1>&2", "mytool a"],
  ["mytool a <<< \"x\"", "mytool a <<< \"x\""], // a here-string stays in the text
  ["2>&1 mytool a", "2>&1 mytool a"], // a redirection in front stays in too
];
for (const [src, text] of redirects) {
  test(`parseBash: the text of ${JSON.stringify(src)} is ${JSON.stringify(text)}`, () => {
    assert.deepEqual(read(src).texts, [text]);
  });
}

test("parseBash: redirections are listed with their operator, descriptor and target", () => {
  const [c] = parseBash("mytool a 2>err.log > out.txt < in.txt").cmds;
  assert.deepEqual(c.redirs.map((r) => [r.op, r.fd, r.target.value]), [[">", "2", "err.log"], [">", null, "out.txt"], ["<", null, "in.txt"]]);
});

// --- parse problems -------------------------------------------------------------------------

for (const [src, why] of [
  ["mytool a &&", "nothing after"],
  ["mytool a ||", "nothing after"],
  ["&& mytool a", "no command before"],
  ["|| mytool a", "no command before"],
  ["; mytool a", "no command before"],
  ["mytool a && && mytool b", "no command before"],
  ["mytool a \\", "backslash"],
  ["mytool a )", "unexpected"],
]) {
  test(`parseBash: ${JSON.stringify(src)} is a parse problem`, () => {
    const r = parseBash(src);
    assert.equal(r.ok, false);
    assert.match(r.problem, new RegExp(why));
  });
}

test("parseBash: an operator followed by a line break continues the line", () => {
  assert.equal(read(`mytool a &&${NL}mytool b`).ok, true);
});

// --- things Claude Code cannot check before they run ----------------------------------------------

const issues = [
  ["mytool a &", ["background"]],
  ["mytool a & mytool b", ["background"]],
  ["(mytool a)", ["subshell"]],
  ["{ mytool a; }", ["brace-group"]],
  ["echo $(date)", ["substitution"]],
  ["echo `date`", ["substitution"]],
  ['echo "$(date)"', ["quoted-substitution"]],
  ["mytool <(echo b)", ["process-substitution"]],
  ["mytool $FOO", ["variable"]],
  ["mytool ${HOME}", ["braced-variable"]],
  ['mytool "a $b"', ["variable"]],
  ["mytool $1", ["variable"]],
  ["mytool $PATH", ["variable"]],
  ["mytool {a,b}", ["brace-expansion"]],
  ["A=1 B=2", ["multiple-assignments"]],
  ["if true; then x=1; fi", ["nested-assignment"]],
  ["for i in 1; do x=1 y=2; done", ["multiple-assignments", "nested-assignment"]],
  ["mytool $'x'", ["ansi-c-quote"]],
  ["echo $'a\\nb'", ["ansi-c-quote"]],
  ["mytool $\"x\"", ["locale-quote"]],
  ["f() { mytool a; }; f", ["brace-group", "function"]],
  ["case x in a) mytool a;; esac", ["case"]],
  [`mytool a <<EOF${NL}x${NL}EOF`, ["heredoc"]],
  [`mytool a <<'EOF' --flag${NL}x${NL}EOF`, ["heredoc-tail"]],
  [`cat <<'EOF' | mytool a${NL}x${NL}EOF`, ["heredoc-tail"]],
  [`cat <<'EOF' > out.txt${NL}x${NL}EOF`, ["heredoc-tail"]],
  ["mytool my\\ file", ["escaped-whitespace"]],
  [`mytool a\\${NL}b`, ["escaped-whitespace"]],
  ["eval \"mytool a\"", ["eval"]],
  ["source x.sh", ["eval"]],
  [". x.sh", ["eval"]],
  ["exec mytool a", ["eval"]],
  ["trap 'rm x' EXIT", ["eval"]],
  ["alias ll=ls", ["eval"]],
  ["[ -f x ] > /dev/null", ["test-brackets"]],
  ["if true; then mytool a; fi > out.txt", ["compound-redirect"]],
  ["for f in a; do mytool a; done < in.txt", ["compound-redirect"]],
  ["(mytool a) 2>&1", ["compound-redirect", "subshell"]],
];
for (const [src, kinds] of issues) {
  test(`parseBash: ${JSON.stringify(src)} raises ${kinds.join(", ")}`, () => {
    assert.deepEqual(read(src).issues, [...kinds].sort());
  });
}

const clean = [
  "mytool $HOME", "mytool \"$HOME/x\"", "mytool '$FOO'", "mytool \\$FOO", "mytool $((1+2))", "mytool a=b", "mytool *.txt", "mytool ~/x", "mytool [ab]",
  "FOO=bar mytool a", "A=1 B=2 mytool a", "x=1; y=2", "x=1; mytool a", "x=$(mytool a)", "x=`mytool a`", "if true; then mytool a; fi", "mytool a <<'EOF'\nx\nEOF", "cat <<'EOF'",
  "mytool a 2>&1 | mytool b", "mytool --flag=$HOME", "! mytool a", "mytool a # $(rm x)", "mytool \"$'x'\"", "mytool '$\"x\"'",
];
for (const src of clean) {
  test(`parseBash: ${JSON.stringify(src)} raises nothing`, () => {
    assert.deepEqual(read(src).issues, []);
  });
}

test("parseBash: the commit message heredoc is the one substitution that passes", () => {
  const src = `git commit -m "$(cat <<'EOF'${NL}fix: thing${NL}${NL}Co-Authored-By: x${NL}EOF${NL})"`;
  const r = parseBash(src);
  assert.equal(r.ok, true);
  assert.deepEqual(r.issues, []);
  const cat = r.cmds.find((c) => c.argv[0].value === "cat");
  assert.equal(cat.inert, true, "the cat inside is marked so allow rules ignore it, while deny rules still see it");
  assert.equal(r.cmds.find((c) => c.argv[0].value === "git").text.startsWith("git commit -m"), true);
});

for (const [name, src] of [
  ["an unquoted delimiter", `git commit -m "$(cat <<EOF${NL}x${NL}EOF${NL})"`],
  ["no double quotes around it", `git commit -m $(cat <<'EOF'${NL}x${NL}EOF${NL})`],
  ["the closing parenthesis on the delimiter line", `git commit -m "$(cat <<'EOF'${NL}x${NL}EOF)"`],
  ["a pipe inside", `git commit -m "$(cat <<'EOF' | tr a b${NL}x${NL}EOF${NL})"`],
  ["a second command inside", `git commit -m "$(cat <<'EOF'${NL}x${NL}EOF${NL}; rm y)"`],
  ["cat of a file", 'git commit -m "$(cat file.txt)"'],
  ["<<- heredoc", `git commit -m "$(cat <<-'EOF'${NL}x${NL}EOF${NL})"`],
]) {
  test(`parseBash: a heredoc commit with ${name} is not the safe shape`, () => {
    const r = parseBash(src);
    assert.ok(r.issues.length > 0 || !r.ok, "something is raised");
  });
}

test("parseBash: parentheses and quotes inside a heredoc body do not confuse the reader", () => {
  const src = `git commit -m "$(cat <<'EOF'${NL}it's a (test) with "quotes" and $(not run)${NL}EOF${NL})" && mytool b`;
  const r = parseBash(src);
  assert.equal(r.ok, true);
  assert.deepEqual(r.issues, []);
  assert.deepEqual(r.cmds.filter((c) => !c.inert).map((c) => c.argv[0].value), ["git", "mytool"]);
});

test("parseBash: an assignment with a substitution passes its inner commands on to be judged by rules only", () => {
  const r = parseBash("x=$(mytool a); mytool b");
  assert.deepEqual(r.issues, []);
  assert.equal(r.cmds.find((c) => c.text === "mytool a").needsRule, true);
});

test("parseBash: leading assignments are kept apart from the command", () => {
  const [c] = parseBash("NODE_ENV=test FOO='a b' mytool a").cmds;
  assert.deepEqual(c.assigns.map((w) => w.raw), ["NODE_ENV=test", "FOO='a b'"]);
  assert.deepEqual(c.argv.map((w) => w.value), ["mytool", "a"]);
  assert.equal(c.text, "NODE_ENV=test FOO='a b' mytool a");
});

test("parseBash: words lose their quotes in value but not in text", () => {
  const [c] = parseBash(`git commit -m "it's" 'a b' c\\ d $'x y'`).cmds;
  assert.deepEqual(c.argv.map((w) => w.value), ["git", "commit", "-m", "it's", "a b", "c d", "x y"]);
  assert.equal(c.text, `git commit -m "it's" 'a b' c\\ d $'x y'`);
});

test("parseBash: commands inside substitutions, subshells and bodies carry their context", () => {
  const r = parseBash("(echo $(mytool a)); if true; then othertool b; fi");
  const ctxOf = (t) => r.cmds.find((c) => c.text === t).ctx;
  assert.deepEqual(ctxOf("mytool a"), ["subshell", "substitution"]);
  assert.deepEqual(ctxOf("othertool b"), ["if"]);
});

test("textFrom: the text of a command from word n on", () => {
  const [c] = parseBash("timeout 5 mytool a > out.txt").cmds;
  assert.equal(textFrom(c, 0), "timeout 5 mytool a");
  assert.equal(textFrom(c, 2), "mytool a");
  assert.equal(textFrom(c, 9), "");
});

test("parseBash never throws and gives up on absurd input", () => {
  for (const src of ["(".repeat(500), "$(".repeat(500), "'".repeat(1000), "\"".repeat(1001), "`".repeat(999), "<<EOF\n".repeat(50), "a && ".repeat(3000), "{".repeat(2000), "\\".repeat(1001)]) {
    const r = parseBash(src);
    assert.equal(typeof r.ok, "boolean");
  }
});
