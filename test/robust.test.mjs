// Whatever is typed, the tool answers: no input makes it throw, hang or return nonsense. The inputs are
// random but seeded, so a failure is the same failure next time.
import { sandbox } from "./helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { buildWhy } from "../src/commands.mjs";
import { checkRule } from "../src/rule.mjs";
import { matches, parseContent } from "../src/pattern.mjs";
import { loadSettings } from "../src/settings.mjs";
import { parseBash } from "../src/shell.mjs";
import { parsePowerShell } from "../src/powershell.mjs";
import { pathRuleMatches } from "../src/pathrules.mjs";
import fs from "node:fs";
import path from "node:path";

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PIECES = [
  "ls", "cat", "git", "status", "push", "rm", "-rf", "-la", "mytool", "echo", "$(", ")", "`", "'", "\"", "\\", "|", "||", "&&", "&", ";", "\n", ">", ">>", "<", "<<", "<<<", "2>&1",
  "$HOME", "${X}", "$X", "$'a'", "$\"b\"", "{", "}", "(", "[", "]", "[[", "]]", "if", "then", "fi", "for", "do", "done", "while", "case", "esac", "in", "function", "=", "A=1", "FOO=bar",
  "timeout", "5", "sudo", "env", "xargs", "nice", "*", "?", "~", "..", "../", "./", "//", "/", "sub/", "a.txt", "<<EOF", "EOF", "<(", ">(", "#", "!", "@", "%", "^", ",", ":", "\t", " ", " ", " ", " ",
  "Get-ChildItem", "Remove-Item", "$true", "$env:HOME", "@(", "@{", "&", ".", "-Path", "foreach", "1,2", "|%", "{ ", " }", "<#", "#>", "`n", "`", "\u00e9", "\u4e2d", "\u0000", "\r",
];

function randomText(r, max = 14) {
  const n = 1 + Math.floor(r() * max);
  let s = "";
  for (let i = 0; i < n; i++) {
    s += PIECES[Math.floor(r() * PIECES.length)];
    if (r() < 0.7) s += " ";
  }
  return s;
}

const SETTINGS = {
  permissions: {
    allow: ["Bash(mytool *)", "Bash(git status *)", "Bash(ls:*)", "PowerShell(Get-ChildItem *)", "Read(./**)", "Edit(./out.txt)"],
    ask: ["Bash(git push *)"],
    deny: ["Bash(rm *)", "Read(./.env)", "PowerShell(Remove-Item *)"],
  },
};

const VERDICTS = new Set(["allow", "ask", "deny"]);

test("random command lines: the readers and the decision never throw and always give a verdict", () => {
  const s = sandbox({ user: SETTINGS });
  const r = rng(20261015);
  const t0 = Date.now();
  for (let i = 0; i < 1500; i++) {
    const text = randomText(r);
    for (const tool of ["Bash", "PowerShell"]) {
      let m;
      try {
        m = buildWhy({ project: s.proj, env: s.env(), home: s.home, managed: s.managedDir, tool, command: text, cwd: s.proj });
      } catch (e) {
        assert.fail(`${tool} ${JSON.stringify(text)} threw ${e && e.stack}`);
      }
      assert.ok(VERDICTS.has(m.decision.verdict), `${tool} ${JSON.stringify(text)} -> ${m.decision.verdict}`);
      assert.equal(typeof m.decision.summary, "string");
      assert.ok(Array.isArray(m.decision.parts));
    }
  }
  assert.ok(Date.now() - t0 < 120000, `took ${Date.now() - t0} ms`);
});

test("random command lines: the readers alone are fast and total", () => {
  const r = rng(7);
  for (let i = 0; i < 6000; i++) {
    const text = randomText(r, 30);
    const b = parseBash(text);
    assert.equal(typeof b.ok, "boolean");
    assert.ok(Array.isArray(b.cmds) && Array.isArray(b.issues) && Array.isArray(b.seps));
    const p = parsePowerShell(text);
    assert.equal(typeof p.ok, "boolean");
    assert.ok(Array.isArray(p.cmds));
    for (const c of [...b.cmds, ...p.cmds]) assert.equal(typeof c.text, "string");
  }
});

test("long and deeply nested input does not hang or overflow the stack", () => {
  const bombs = [
    "(".repeat(5000), "$(".repeat(3000), "{ ".repeat(3000), "if ".repeat(3000), "a | ".repeat(20000), "a && ".repeat(20000), "'".repeat(10001), "\"$(".repeat(2000),
    "<<EOF\n".repeat(500), "x".repeat(300000), "a;".repeat(100000), "\n".repeat(50000), "\\".repeat(10001), "$(".repeat(3000) + ")".repeat(3000),
  ];
  const s = sandbox({ user: SETTINGS });
  for (const text of bombs) {
    const t0 = Date.now();
    for (const tool of ["Bash", "PowerShell"]) {
      const m = buildWhy({ project: s.proj, env: s.env(), home: s.home, managed: s.managedDir, tool, command: text, cwd: s.proj });
      assert.ok(VERDICTS.has(m.decision.verdict));
    }
    assert.ok(Date.now() - t0 < 20000, `${JSON.stringify(text.slice(0, 20))} took ${Date.now() - t0} ms`);
  }
});

test("random rules and patterns: no throw, and a pattern never matches by accident of regex syntax", () => {
  const r = rng(99);
  const bits = ["*", "**", ":*", "\\*", "(", ")", " ", "a", "git", "[", "]", "?", ".", "+", "^", "$", "|", "\\", "{", "}", "-", "/", "~", "!", "=", "é"];
  const rand = (max = 10) => Array.from({ length: Math.floor(r() * max) }, () => bits[Math.floor(r() * bits.length)]).join("");
  for (let i = 0; i < 4000; i++) {
    const content = rand();
    const text = rand(14);
    const parsed = parseContent(content);
    const result = matches(parsed, text);
    assert.equal(typeof result, "boolean");
    for (const behavior of ["allow", "ask", "deny"]) {
      for (const tool of ["Bash", "Read", "mcp__x", "", "bash", "WebFetch", "Write"]) {
        const c = checkRule(`${tool}(${content})`, behavior);
        assert.ok(c.problem === null || typeof c.problem.code === "string");
        assert.ok(Array.isArray(c.warnings));
      }
    }
    assert.equal(typeof pathRuleMatches(content, path.resolve("x", "y"), { behavior: "deny", scope: "project", cwd: path.resolve("x"), home: path.resolve("h"), configDir: path.resolve("c") }), "boolean");
  }
  assert.equal(matches(parseContent("a*"), "a"), true);
  assert.equal(matches(parseContent("a.b"), "axb"), false, "the dot is a dot");
  assert.equal(matches(parseContent("a+"), "aa"), false, "the plus is a plus");
});

test("settings files with the wrong types everywhere load without throwing", () => {
  const weird = [
    {}, { permissions: null }, { permissions: [] }, { permissions: "x" }, { permissions: { allow: null } }, { permissions: { allow: [null, 1, {}, [], true, "", "Bash", "Bash("] } },
    { permissions: { allow: "Bash(ls)", deny: 5, ask: {} } }, { permissions: { additionalDirectories: [1, null, "", "~", "//x"] } }, { permissions: { defaultMode: [] } },
    { allowManagedPermissionRulesOnly: "yes", permissions: { deny: ["Bash(x)"] } }, [], "string", 5, null,
  ];
  for (const w of weird) {
    const s = sandbox({ user: JSON.stringify(w) });
    const st = loadSettings({ project: s.proj, env: s.env(), home: s.home, managed: s.managedDir });
    assert.ok(Array.isArray(st.rules) && Array.isArray(st.files));
    const m = buildWhy({ project: s.proj, env: s.env(), home: s.home, managed: s.managedDir, tool: "Bash", command: "ls", cwd: s.proj });
    assert.ok(VERDICTS.has(m.decision.verdict));
  }
});

test("binary junk and odd bytes in a settings file are an error message, not a crash", () => {
  const s = sandbox();
  fs.mkdirSync(s.cfg, { recursive: true });
  for (const bytes of [Buffer.from([0xff, 0xfe, 0x00, 0x01]), Buffer.from("\u0000\u0000"), Buffer.alloc(100000, 0x7b), Buffer.from("{\"a\":\"\\ud800\"}")]) {
    fs.writeFileSync(s.userFile, bytes);
    const st = loadSettings({ project: s.proj, env: s.env(), home: s.home, managed: s.managedDir });
    assert.ok(Array.isArray(st.files));
  }
});
