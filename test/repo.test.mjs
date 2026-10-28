// The package itself: what it says it is, what it imports, which Node it needs, and that the plugin's
// skill calls the tool with flags the tool has.
import { ROOT } from "./helpers.mjs";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../src/cli.mjs";
import { VERSION } from "../src/version.mjs";

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const json = (rel) => JSON.parse(read(rel));
const files = (dir, ext) => fs.readdirSync(path.join(ROOT, dir)).filter((n) => n.endsWith(ext)).map((n) => path.join(dir, n));

const pkg = json("package.json");
const plugin = json(".claude-plugin/plugin.json");

test("package.json: name, version, bin, engines, no dependencies, tests run with node --test", () => {
  assert.equal(pkg.name, "claude-permission-doctor");
  assert.equal(pkg.version, VERSION);
  assert.equal(pkg.type, "module");
  assert.equal(pkg.license, "MIT");
  assert.deepEqual(pkg.bin, { "claude-permission-doctor": "bin/claude-permission-doctor.mjs" });
  assert.equal(pkg.engines.node, ">=18");
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.devDependencies, undefined);
  assert.equal(pkg.optionalDependencies, undefined);
  assert.equal(pkg.scripts.test, "node --test");
  assert.deepEqual(pkg.files, ["bin", "src", ".claude-plugin", "skills", "README.md", "LICENSE"]);
  for (const f of pkg.files) assert.ok(fs.existsSync(path.join(ROOT, f)), `${f} is listed and exists`);
  assert.match(pkg.description, /^Why Claude Code asked/);
  assert.match(pkg.description, /Zero tokens/i);
  for (const k of ["claude-code", "claude-code-permissions", "permissions", "allowlist", "linter", "security", "settings"]) assert.ok(pkg.keywords.includes(k), k);
});

test("the plugin manifest matches the package", () => {
  assert.equal(plugin.name, "permission-doctor");
  assert.equal(plugin.version, VERSION);
  assert.equal(plugin.license, "MIT");
  assert.match(plugin.homepage, /github\.com\/nrzz\/claude-permission-doctor/);
  assert.match(plugin.repository, /github\.com\/nrzz\/claude-permission-doctor/);
  for (const k of ["documentationUrl", "supportUrl", "privacyPolicyUrl", "termsOfServiceUrl"]) assert.match(plugin[k], /^https:\/\/github\.com\/nrzz\/claude-permission-doctor/, k);
  assert.equal(plugin.hooks, undefined, "no hooks: the plugin is one skill");
  assert.equal(plugin.mcpServers, undefined);
});

test("one skill, /permission-doctor:check, that only runs this tool", () => {
  const dirs = fs.readdirSync(path.join(ROOT, "skills"));
  assert.deepEqual(dirs, ["check"]);
  // A Windows checkout holds CRLF (the repository may carry no .gitattributes)
  const text = read("skills/check/SKILL.md").replace(/\r\n/g, "\n");
  const front = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(front, "has frontmatter");
  assert.match(front[1], /^name: check$/m);
  assert.match(front[1], /^disable-model-invocation: true$/m);
  const desc = /^description: (.+)$/m.exec(front[1])[1];
  assert.ok(desc.length <= 80, `the description is part of what loads every session: ${desc.length} characters`);
  const allowed = /^allowed-tools: (.+)$/m.exec(front[1])[1];
  assert.match(allowed, /Bash\(node "\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/claude-permission-doctor\.mjs" \*\)/);
  assert.doesNotMatch(allowed, /Bash\(\*\)|Bash\s|Edit|Write/, "nothing wider than the one command");
  const body = text.slice(front[0].length);
  const commands = [...body.matchAll(/^!`node "\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/claude-permission-doctor\.mjs" (.+)`$/gm)].map((m) => m[1]);
  assert.equal(commands.length, 2);
  const parsed = commands.map((c) => parseArgs(c.replace(/"\$\{CLAUDE_PROJECT_DIR\}"/g, "dir").split(/\s+/)));
  assert.deepEqual(parsed.map((p) => p.command), ["lint", "suggest"]);
  assert.ok(parsed.every((p) => p.markdown && p.project === "dir"), "markdown for the project folder");
  assert.ok(parsed.every((p) => !p.fix && !p.write), "the skill never writes");
  assert.match(body, /Edit nothing until the user agrees/);
  assert.match(body, /not prompts the user approved/);
});

test("every source file is .mjs, imports only node:fs, node:os, node:path and the package itself", () => {
  const sources = [...files("src", ".mjs"), ...files("bin", ".mjs")];
  assert.ok(sources.length >= 20);
  assert.deepEqual(fs.readdirSync(path.join(ROOT, "src")).filter((n) => !n.endsWith(".mjs")), []);
  const allowed = new Set(["node:fs", "node:os", "node:path"]);
  for (const f of sources) {
    for (const m of read(f).matchAll(/^import\s[^;]*?from\s+"([^"]+)";/gms)) {
      const spec = m[1];
      assert.ok(spec.startsWith("./") || spec.startsWith("../") || allowed.has(spec), `${f} imports ${spec}`);
    }
    assert.doesNotMatch(read(f), /\brequire\(|\bimport\(/, `${f} has no dynamic loading`);
  }
});

test("nothing in the package can reach the network or start a process", () => {
  const banned = /\b(fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(|node:(http|https|http2|net|tls|dns|dgram|child_process|worker_threads|cluster|vm)\b|\bchild_process\b|\bprocess\.binding\b|\beval\s*\(|new Function\s*\(/;
  for (const f of [...files("src", ".mjs"), ...files("bin", ".mjs")]) assert.doesNotMatch(read(f), banned, f);
});

test("only APIs that exist in Node 18 are used", () => {
  // each of these arrived after Node 18.0 (or is not in every 18.x), so using one would break on the oldest supported Node
  const newer = [
    [/\.toSorted\(|\.toReversed\(|\.toSpliced\(|\.with\(\d/, "Array copy-methods (Node 20)"],
    [/\bObject\.groupBy\b|\bMap\.groupBy\b/, "groupBy (Node 21)"],
    [/\bArray\.fromAsync\b/, "Array.fromAsync (Node 22)"],
    [/\bPromise\.withResolvers\b/, "Promise.withResolvers (Node 22)"],
    [/import\.meta\.(dirname|filename)\b/, "import.meta.dirname/filename (Node 20.11)"],
    [/\bfs\.(glob|globSync)\b/, "fs.glob (Node 22)"],
    [/\.(isWellFormed|toWellFormed)\(/, "String well-formed methods (Node 20)"],
    [/\.(union|intersection|difference|symmetricDifference|isSubsetOf|isSupersetOf|isDisjointFrom)\(/, "Set methods (Node 22)"],
    [/process\.getBuiltinModule|process\.loadEnvFile|util\.styleText|\bstyleText\b/, "newer process/util APIs"],
    [/\bimport\s[^;]*\swith\s*\{/, "import attributes"],
  ];
  for (const f of [...files("src", ".mjs"), ...files("bin", ".mjs")]) {
    const text = read(f);
    for (const [re, what] of newer) assert.doesNotMatch(text, re, `${f}: ${what}`);
  }
});

test("lookbehind and the other regular expression features used are in Node 18's V8", () => {
  assert.doesNotThrow(() => new RegExp("(?<!:)//(?=\\S)"));
  assert.doesNotThrow(() => new RegExp("(?<name>a)\\k<name>"));
});

test("the license, the conduct file and the changelog are there and agree on the version", () => {
  assert.match(read("LICENSE"), /^MIT License/);
  assert.match(read("LICENSE"), /Copyright \(c\) \d{4} /);
  assert.ok(fs.existsSync(path.join(ROOT, "CODE_OF_CONDUCT.md")));
  if (fs.existsSync(path.join(ROOT, "CHANGELOG.md"))) assert.match(read("CHANGELOG.md"), new RegExp(`^## \\[${VERSION.replace(/\./g, "\\.")}\\]`, "m"));
});

test("a settings file in a test never points at the real Claude folder", () => {
  // the helper's safety net: every way the tool finds a config, home or managed folder is a temp folder
  assert.notEqual(process.env.CLAUDE_CONFIG_DIR, "");
  assert.ok(process.env.CLAUDE_CONFIG_DIR.startsWith(process.env.HOME), "the config folder is inside the throwaway home");
  assert.match(process.env.CLAUDE_PERMISSION_DOCTOR_MANAGED_DIR, /no-managed-settings$/);
});
