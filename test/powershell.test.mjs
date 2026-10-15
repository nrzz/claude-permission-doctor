import "./helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { parsePowerShell } from "../src/powershell.mjs";
import { canonicalName, canonicalText, readOnlyPs } from "../src/psknow.mjs";

const NL = "\n";
const read = (s) => {
  const r = parsePowerShell(s);
  return { ok: r.ok, texts: r.cmds.map((c) => c.text), issues: [...new Set(r.issues.map((i) => i.kind))].sort(), seps: r.seps, r };
};

const splits = [
  ["mytool a | mytool b", ["mytool a", "mytool b"], ["|"]],
  ["mytool a ; mytool b", ["mytool a", "mytool b"], [";"]],
  [`mytool a ${NL}mytool b`, ["mytool a", "mytool b"], ["\n"]],
  ["mytool a && mytool b", ["mytool a", "mytool b"], ["&&"]],
  ["mytool a || mytool b", ["mytool a", "mytool b"], ["||"]],
  ['mytool "a ; b"', ['mytool "a ; b"'], []],
  ["mytool 'a | b'", ["mytool 'a | b'"], []],
  ["git commit -m \"x\"", ['git commit -m "x"'], []],
  ["mytool a > out.txt 2>&1", ["mytool a"], []],
  [".\\mytool a", [".\\mytool a"], []],
  ["C:\\x\\mytool a", ["C:\\x\\mytool a"], []],
  ["mytool a # comment", ["mytool a"], []],
  ["<# block #> mytool a", ["mytool a"], []],
];
for (const [src, texts, seps] of splits) {
  test(`parsePowerShell splits ${JSON.stringify(src)}`, () => {
    const r = read(src);
    assert.equal(r.ok, true);
    assert.deepEqual(r.texts, texts);
    assert.deepEqual(r.seps, seps);
  });
}

test("parsePowerShell: && and || are noted, not refused (PowerShell 7 syntax)", () => {
  assert.equal(parsePowerShell("a && b").chain, true);
  assert.equal(parsePowerShell("a | b").chain, false);
});

for (const src of ["mytool a |", "mytool a &&", "&& mytool a", "| mytool a"]) {
  test(`parsePowerShell: ${JSON.stringify(src)} is a parse problem (an empty pipe element)`, () => {
    assert.equal(parsePowerShell(src).ok, false);
  });
}

const issues = [
  ["(mytool a)", ["subexpression"]],
  ["$(mytool a)", ["dynamic-command", "subexpression"]],
  ["Write-Output (mytool a)", ["subexpression"]],
  ["& { mytool a }", ["dynamic-command", "script-block"]],
  ["& $cmd a", ["dynamic-command"]],
  ["$x = mytool a", ["assignment"]],
  ["$env:FOO = 1; mytool a", ["environment"]],
  ["mytool $x", ["variable"]],
  ["mytool $true", ["variable"]],
  ["mytool $null", ["variable"]],
  ["mytool \"$false\"", ["variable"]],
  ["Get-ChildItem sub//x", ["unc-path"]],
  ["Write-Output 'a//b'", ["unc-path"]],
  ["Get-ChildItem sub\\\\x", ["unc-path"]],
  ["mytool $env:HOME", ["variable"]],
  ["foreach ($i in 1,2) { mytool a }", ["control-flow", "dynamic-command", "script-block", "subexpression"]],
  ["1,2 | ForEach-Object { mytool a }", ["script-block"]],
  ["if ($true) { mytool a }", ["control-flow", "dynamic-command", "script-block", "subexpression"]],
  ["try { mytool a } catch { }", ["control-flow", "script-block"]],
  ["powershell -Command \"mytool a\"", ["nested-shell"]],
  ["pwsh -c \"mytool a\"", ["nested-shell"]],
  ["Invoke-Expression \"mytool a\"", ["invoke-expression"]],
  ["iex \"mytool a\"", ["invoke-expression"]],
  ["mytool a &", ["background"]],
  [". .\\profile.ps1", ["dot-source"]],
];
for (const [src, kinds] of issues) {
  test(`parsePowerShell: ${JSON.stringify(src)} raises ${kinds.join(", ")}`, () => {
    assert.deepEqual(read(src).issues, kinds);
  });
}

for (const src of ["mytool 'a $b'", "mytool a", "& mytool a", "Get-ChildItem -Recurse | Select-Object -First 5", "Get-ChildItem sub// ; Write-Output http://x"]) {
  test(`parsePowerShell: ${JSON.stringify(src)} raises nothing`, () => {
    assert.deepEqual(read(src).issues, []);
  });
}

test("parsePowerShell: commands inside brackets are still found, for deny and ask rules", () => {
  const r = read("Write-Output (mytool a); 1 | ForEach-Object { othertool b }");
  assert.ok(r.texts.includes("mytool a"));
  assert.ok(r.texts.includes("othertool b"));
});

test("parsePowerShell: a call operator keeps the & in the text and out of the words", () => {
  const [c] = parsePowerShell("& mytool a").cmds;
  assert.equal(c.text, "& mytool a");
  assert.deepEqual(c.argv.map((w) => w.value), ["mytool", "a"]);
  assert.equal(c.call, true);
});

test("parsePowerShell: expressions at the head of a statement are not commands", () => {
  assert.deepEqual(read("$x = 1").texts, []);
  assert.deepEqual(read("1,2 | mytool a").texts, ["mytool a"]);
  assert.deepEqual(read('"mytool a" | Invoke-Expression').texts, ["Invoke-Expression"]);
});

test("parsePowerShell never throws", () => {
  for (const src of ["(".repeat(400), "{".repeat(400), "$(".repeat(300), "'".repeat(999), '"'.repeat(1001), "@\"\n".repeat(30), "`".repeat(999), "a | ".repeat(2000), "<#".repeat(100)]) {
    assert.equal(typeof parsePowerShell(src).ok, "boolean");
  }
});

// --- aliases and read-only cmdlets -------------------------------------------------------------

for (const [alias, cmdlet] of [
  ["ls", "Get-ChildItem"], ["dir", "Get-ChildItem"], ["gci", "Get-ChildItem"], ["cat", "Get-Content"], ["gc", "Get-Content"], ["type", "Get-Content"],
  ["cd", "Set-Location"], ["pwd", "Get-Location"], ["echo", "Write-Output"], ["rm", "Remove-Item"], ["del", "Remove-Item"], ["ri", "Remove-Item"],
  ["cp", "Copy-Item"], ["mv", "Move-Item"], ["ni", "New-Item"], ["sleep", "Start-Sleep"], ["select", "Select-Object"], ["where", "Where-Object"],
  ["foreach", "ForEach-Object"], ["measure", "Measure-Object"], ["sls", "Select-String"], ["ps", "Get-Process"], ["gps", "Get-Process"],
]) {
  test(`canonicalName: ${alias} is ${cmdlet}`, () => {
    assert.equal(canonicalName(alias), cmdlet.toLowerCase());
    assert.equal(canonicalName(cmdlet), cmdlet.toLowerCase());
  });
}

test("canonicalName: aliases Claude Code does not resolve stay as they are", () => {
  for (const a of ["sort", "sc", "set", "diff", "compare", "group", "gm", "gal", "gu", "gmo", "gdr", "rv", "mytool"]) assert.equal(canonicalName(a), a);
});

test("canonicalText: the first word is canonical and lowercase, the rest lowercase", () => {
  assert.equal(canonicalText("LS -Recurse"), "get-childitem -recurse");
  assert.equal(canonicalText("Get-ChildItem *"), "get-childitem *");
  assert.equal(canonicalText("* --version"), "* --version");
});

const ctx = { cwd: process.cwd(), home: process.cwd(), dirs: [process.cwd()] };
for (const [cmd, ok] of [
  ["Get-ChildItem", true], ["ls x", true], ["Get-Content x", true], ["cat x", true], ["Get-Location", true], ["pwd", true], ["Write-Output hi", true],
  ["echo hi", true], ["Write-Host hi", true], ["Get-Date", true], ["Select-String foo x", true], ["Test-Path x", true], ["Get-Item x", true],
  ["Measure-Object", true], ["Select-Object -First 3", true], ["Sort-Object", true], ["Where-Object x", true], ["Format-Table", true],
  ["ConvertTo-Json", true], ["Join-Path a b", true], ["Split-Path x", true], ["Start-Sleep 0", true], ["Get-Module", true], ["hostname", true],
  ["whoami", true], ["git status", true], ["git log --oneline", true], ["git commit -m x", false], ["Get-Process", false], ["Get-Service", false],
  ["Get-Command git", false], ["Get-Help x", false], ["ForEach-Object x", false], ["Remove-Item x", false], ["rm x", false], ["Set-Content x y", false],
  ["New-Item x", false], ["Invoke-WebRequest x", false], ["node --version", false], ["npm test", false], ["mytool a", false], ["Out-File x", false],
]) {
  test(`readOnlyPs: ${cmd} is ${ok ? "" : "not "}read-only`, () => {
    assert.equal(readOnlyPs(cmd.split(" "), ctx).ok, ok);
  });
}

test("readOnlyPs: a path outside the working folders is not read-only, and the argument is named", () => {
  const r = readOnlyPs(["Get-ChildItem", "..\\other"], ctx);
  assert.equal(r.ok, false);
  assert.equal(r.outside, "..\\other");
  assert.equal(readOnlyPs(["Get-Content", "sub/file.txt"], ctx).ok, true);
});
