import "./helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { parseBash } from "../src/shell.mjs";
import { candidates, innerProgram, SAFE_ENV, strippedWords, wrapperLength } from "../src/wrappers.mjs";

const cmd = (s) => parseBash(s).cmds[0];
const texts = (s, behavior) => candidates(cmd(s), behavior).map((c) => c.text);

// [command, number of words the wrapper takes, deep]
const lengths = [
  ["timeout 30 npm test", 2, false],
  ["timeout -s KILL 30 npm test", 4, false],
  ["timeout --signal=KILL 30s npm test", 3, false],
  ["timeout -k 5 -s TERM 30 npm test", 6, false],
  ["timeout --weird 30 npm test", 0, false],
  ["timeout npm test", 0, false],
  ["time npm test", 1, false],
  ["nice npm test", 1, false],
  ["nice -n 5 npm test", 3, false],
  ["nice -5 npm test", 2, false],
  ["nohup npm test", 1, false],
  ["stdbuf -oL npm test", 2, false],
  ["stdbuf -oL -eL npm test", 3, false],
  ["stdbuf --weird npm test", 0, false],
  ["command npm test", 1, false],
  ["command -v npm", 0, false],
  ["builtin echo hi", 1, false],
  ["xargs grep x", 1, false],
  ["xargs -n1 grep x", 0, false],
  ["env npm test", 0, false],
  ["env npm test", 1, true],
  ["env FOO=1 -i npm test", 3, true],
  ["env -u FOO npm test", 3, true],
  ["sudo npm test", 1, true],
  ["sudo -u bob -E npm test", 4, true],
  ["doas npm test", 1, true],
  ["ionice -c 3 npm test", 3, true],
  ["setsid npm test", 1, true],
  ["watch -n 5 npm test", 3, true],
  ["flock f npm test", 2, true],
  ["strace -o log npm test", 3, true],
  ["exec npm test", 1, true],
  ["npx tsc", 0, true],
  ["chroot / npm test", 0, true],
  ["npm test", 0, true],
];
for (const [src, n, deep] of lengths) {
  test(`wrapperLength: ${src} (${deep ? "deny" : "allow"} rules) takes ${n} words`, () => {
    assert.equal(wrapperLength(src.split(" "), 0, { deep }), n);
  });
}

test("candidates: an allow rule sees the command, then what is left after each wrapper and safe variable", () => {
  assert.deepEqual(texts("timeout 30 npm test", "allow"), ["timeout 30 npm test", "npm test"]);
  assert.deepEqual(texts("NODE_ENV=test timeout 30 npm test", "allow"), ["NODE_ENV=test timeout 30 npm test", "timeout 30 npm test", "npm test"]);
  assert.deepEqual(texts("nice timeout 5 npm test", "allow"), ["nice timeout 5 npm test", "timeout 5 npm test", "npm test"]);
});

test("candidates: an unsafe variable stops an allow rule, but not a deny or ask rule", () => {
  assert.deepEqual(texts("FOO=bar npm test", "allow"), ["FOO=bar npm test"]);
  assert.deepEqual(texts("FOO=bar npm test", "deny"), ["FOO=bar npm test", "npm test"]);
  assert.deepEqual(texts("NODE_ENV=test FOO=bar npm test", "allow"), ["NODE_ENV=test FOO=bar npm test", "FOO=bar npm test"]);
  assert.deepEqual(texts("A=1 B=2 npm test", "ask"), ["A=1 B=2 npm test", "B=2 npm test", "npm test"]);
});

test("candidates: deny and ask rules also look through sudo, env and the exec wrappers", () => {
  assert.deepEqual(texts("sudo -u bob rm -rf x", "deny"), ["sudo -u bob rm -rf x", "rm -rf x"]);
  assert.deepEqual(texts("sudo -u bob rm -rf x", "allow"), ["sudo -u bob rm -rf x"]);
  assert.deepEqual(texts("env FOO=1 rm x", "deny"), ["env FOO=1 rm x", "rm x"]);
});

test("candidates: redirections are not part of the text, and the command word is read without its quotes", () => {
  assert.deepEqual(texts("npm test 2>&1", "allow"), ["npm test"]);
  assert.deepEqual(texts('"rm" x', "deny"), ['"rm" x', "rm x"]);
  assert.deepEqual(texts("\\rm x", "deny"), ["\\rm x", "rm x"]);
  assert.deepEqual(texts("r\\m x", "allow"), ["r\\m x", "rm x"]);
  assert.deepEqual(texts("rm\\ x", "allow"), ["rm\\ x"], "an escaped space makes it one word: no plain spelling");
  assert.deepEqual(texts("git 'push' origin", "deny"), ["git 'push' origin"], "only the command word is read without quotes");
});

test("candidates: a bare assignment is only itself", () => {
  assert.deepEqual(texts("FOO=bar", "allow"), ["FOO=bar"]);
});

test("innerProgram: for the read-only question only a safe variable, command, builtin and noglob are looked through", () => {
  assert.deepEqual(innerProgram(cmd("NODE_ENV=test ls -la")).words, ["ls", "-la"]);
  assert.deepEqual(innerProgram(cmd("command ls")).words, ["ls"]);
  assert.deepEqual(innerProgram(cmd("builtin echo hi")).words, ["echo", "hi"]);
  assert.deepEqual(innerProgram(cmd("timeout 5 ls")).words, ["timeout", "5", "ls"]);
  assert.deepEqual(innerProgram(cmd("xargs ls")).words, ["xargs", "ls"]);
  assert.deepEqual(innerProgram(cmd("env ls")).words, ["env", "ls"]);
  const unsafe = innerProgram(cmd("FOO=1 ls"));
  assert.equal(unsafe.index, 0, "stops at the unsafe assignment");
});

test("strippedWords: allow, path and deny kinds of stripping", () => {
  assert.deepEqual(strippedWords(cmd("timeout 5 cat x"), "allow"), ["cat", "x"]);
  assert.deepEqual(strippedWords(cmd("xargs cat x"), "allow"), ["cat", "x"]);
  assert.deepEqual(strippedWords(cmd("xargs cat x"), "path"), ["xargs", "cat", "x"]);
  assert.deepEqual(strippedWords(cmd("sudo cat x"), "allow"), ["sudo", "cat", "x"]);
  assert.deepEqual(strippedWords(cmd("sudo cat x"), "deny"), ["cat", "x"]);
});

test("SAFE_ENV is the list checked against Claude Code, one variable at a time", () => {
  assert.equal(SAFE_ENV.size, 39);
  for (const v of ["NODE_ENV", "CI", "TZ", "LANG", "NO_COLOR", "RUST_LOG", "GOOS", "CGO_ENABLED", "PYTHONUNBUFFERED", "GIT_TERMINAL_PROMPT"]) assert.ok(SAFE_ENV.has(v), v);
  for (const v of ["PATH", "HOME", "FOO", "LD_PRELOAD", "GIT_DIR", "EDITOR", "SHELL", "USER"]) assert.ok(!SAFE_ENV.has(v), v);
});
