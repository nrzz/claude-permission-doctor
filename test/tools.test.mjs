import { sandbox, tmp } from "./helpers.mjs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { loadSettings } from "../src/settings.mjs";
import { decideFetch, decideFile, decideTool, domainMatches } from "../src/tools.mjs";

const load = (s) => loadSettings({ project: s.proj, env: s.env(), home: s.home, managed: s.managedDir });
const rules = (list) => ({ permissions: list });

const domainRows = [
  // [pattern, host, matches]
  ["example.com", "example.com", true], ["example.com", "www.example.com", false], ["example.com", "badexample.com", false],
  ["Example.COM", "example.com", true], ["example.com.", "example.com", true],
  ["*.example.com", "a.example.com", true], ["*.example.com", "a.b.example.com", true], ["*.example.com", "example.com", false], ["*.example.com", "badexample.com", false],
  ["*", "anything.org", true],
  ["api.*.com", "api.x.com", true], ["api.*.com", "api.x.y.com", false], ["api.*.com", "api.com", false],
  ["a.b", "a-b", false],
];
for (const [pattern, host, expected] of domainRows) {
  test(`domainMatches: domain:${pattern} ${expected ? "matches" : "does not match"} ${host}`, () => {
    assert.equal(domainMatches(pattern, host), expected);
  });
}

test("decideFetch: allow, ask and deny rules by host; deny wins; the fix names the host", () => {
  const s = sandbox({ user: rules({ allow: ["WebFetch(domain:docs.example.com)"], deny: ["WebFetch(domain:evil.example.com)"] }), project: rules({ ask: ["WebFetch(domain:ask.example.com)"] }) });
  const st = load(s);
  assert.equal(decideFetch({ url: "https://docs.example.com/page?q=1", settings: st }).verdict, "allow");
  assert.equal(decideFetch({ url: "https://DOCS.example.com./x", settings: st }).verdict, "allow", "case and a trailing dot do not matter");
  assert.equal(decideFetch({ url: "https://evil.example.com/", settings: st }).verdict, "deny");
  assert.equal(decideFetch({ url: "https://ask.example.com/", settings: st }).verdict, "ask");
  const none = decideFetch({ url: "https://other.example.org/x", settings: st });
  assert.equal(none.verdict, "ask");
  assert.equal(none.fix.rule, "WebFetch(domain:other.example.org)");
  assert.ok(none.notes.some((n) => n.includes("documentation hosts")));
});

test("decideFetch: a bare WebFetch rule governs every fetch; deny first", () => {
  const allow = decideFetch({ url: "https://x.test/", settings: load(sandbox({ user: rules({ allow: ["WebFetch"] }) })) });
  assert.equal(allow.verdict, "allow");
  const deny = decideFetch({ url: "https://x.test/", settings: load(sandbox({ user: rules({ allow: ["WebFetch"], deny: ["WebFetch"] }) })) });
  assert.equal(deny.verdict, "deny");
  const ask = decideFetch({ url: "https://x.test/", settings: load(sandbox({ user: rules({ allow: ["WebFetch(domain:x.test)"], ask: ["WebFetch"] }) })) });
  assert.equal(ask.verdict, "ask");
});

test("decideFetch: something that is not a URL is treated as a host name", () => {
  const st = load(sandbox({ user: rules({ allow: ["WebFetch(domain:docs.example.com)"] }) }));
  assert.equal(decideFetch({ url: "docs.example.com", settings: st }).verdict, "allow");
});

test("decideTool: MCP rules by server and by tool", () => {
  const st = load(sandbox({ user: rules({ allow: ["mcp__github", "mcp__fs__read_*"], deny: ["mcp__fs__delete"], ask: ["mcp__db__*"] }) }));
  assert.equal(decideTool({ tool: "mcp__github__get_issue", settings: st }).verdict, "allow", "a server name covers its tools");
  assert.equal(decideTool({ tool: "mcp__fs__read_file", settings: st }).verdict, "allow");
  assert.equal(decideTool({ tool: "mcp__fs__write_file", settings: st }).verdict, "ask");
  assert.equal(decideTool({ tool: "mcp__fs__delete", settings: st }).verdict, "deny");
  assert.equal(decideTool({ tool: "mcp__db__query", settings: st }).verdict, "ask");
  const none = decideTool({ tool: "mcp__other__thing", settings: st });
  assert.equal(none.verdict, "ask");
  assert.equal(none.fix.rule, "mcp__other__thing");
  assert.match(none.fix.why, /mcp__other__\*/);
});

test("decideTool: other tools by name; a rule with parentheses is not a rule for the whole tool", () => {
  const st = load(sandbox({ user: rules({ allow: ["WebSearch", "Skill(foo)"], deny: ["Agent"] }) }));
  assert.equal(decideTool({ tool: "WebSearch", settings: st }).verdict, "allow");
  assert.equal(decideTool({ tool: "Agent", settings: st }).verdict, "deny");
  assert.equal(decideTool({ tool: "Skill", settings: st }).verdict, "ask");
  assert.equal(decideTool({ tool: "Monitor", settings: st }).fix.rule, "Monitor");
});

test("decideFile: a read inside the working folder needs no rule; outside it asks and the fix is a Read rule", () => {
  const s = sandbox();
  const st = load(s);
  const inside = decideFile({ tool: "Read", file: "src/a.ts", settings: st, cwd: s.proj, home: s.home });
  assert.equal(inside.verdict, "allow");
  assert.equal(inside.kind, "inside");
  const outside = decideFile({ tool: "Read", file: path.join(s.base, "elsewhere", "x.txt"), settings: st, cwd: s.proj, home: s.home });
  assert.equal(outside.verdict, "ask");
  assert.equal(outside.kind, "no-rule");
  assert.match(outside.fix.rule, /^Read\(\/\/.*\/\*\*\)$/);
});

test("decideFile: an additional directory counts as inside", () => {
  const extra = path.join(tmp(), "extra");
  const s = sandbox({ user: rules({ additionalDirectories: [extra] }) });
  const d = decideFile({ tool: "Read", file: path.join(extra, "a.txt"), settings: load(s), cwd: s.proj, home: s.home });
  assert.equal(d.verdict, "allow");
  assert.equal(decideFile({ tool: "Read", file: path.join(extra, "..", "a.txt"), settings: load(s), cwd: s.proj, home: s.home }).verdict, "ask");
});

test("decideFile: Edit asks by default, an Edit allow rule allows, Edit deny and Read deny refuse", () => {
  const s = sandbox({ user: rules({ allow: ["Edit(./src/**)"], deny: ["Read(./secret.txt)"] }), project: rules({ deny: ["Edit(./locked.txt)"] }) });
  const st = load(s);
  const run = (tool, file) => decideFile({ tool, file, settings: st, cwd: s.proj, home: s.home });
  assert.equal(run("Edit", "src/a.ts").verdict, "allow");
  assert.equal(run("Edit", "other.txt").verdict, "ask");
  assert.equal(run("Edit", "other.txt").fix.rule, "Edit(other.txt)");
  assert.equal(run("Edit", "locked.txt").verdict, "deny");
  const readDeny = run("Edit", "secret.txt");
  assert.equal(readDeny.verdict, "deny");
  assert.match(readDeny.summary, /Read deny rule also blocks Edit/);
  assert.equal(run("Write", "src/new.ts").verdict, "allow", "Edit rules cover Write");
});

test("decideFile: bare Read, Edit and Write rules", () => {
  const s = sandbox({ user: rules({ allow: ["Read", "Edit"], deny: ["Write"] }) });
  const st = load(s);
  const run = (tool, file) => decideFile({ tool, file, settings: st, cwd: s.proj, home: s.home });
  assert.equal(run("Read", path.join(s.base, "outside.txt")).verdict, "allow");
  assert.equal(run("Edit", "a.txt").verdict, "allow");
  assert.equal(run("Write", "a.txt").verdict, "deny", "a bare Write deny rule wins over the Edit allow rule");
  assert.equal(decideFile({ tool: "Write", file: "a.txt", settings: load(sandbox({ user: rules({ allow: ["Write"] }) })), cwd: s.proj, home: s.home }).verdict, "allow");
  assert.equal(decideFile({ tool: "Write", file: "a.txt", settings: load(sandbox({ user: rules({ ask: ["Write"] }) })), cwd: s.proj, home: s.home }).verdict, "ask");
});

test("decideFile: a Write(path) rule is never consulted, and the verdict says so", () => {
  const s = sandbox({ user: rules({ allow: ["Write(src/**)"] }) });
  const d = decideFile({ tool: "Write", file: "src/new.ts", settings: load(s), cwd: s.proj, home: s.home });
  assert.equal(d.verdict, "ask");
  assert.ok(d.notes.some((n) => n.includes("Write(path) rules are never consulted")));
});

test("decideFile: ask rules and deny order", () => {
  const s = sandbox({ user: rules({ allow: ["Read(./a.txt)"], ask: ["Read(./a.txt)"] }), project: rules({ deny: ["Read(./a.txt)"] }) });
  const d = decideFile({ tool: "Read", file: "a.txt", settings: load(s), cwd: s.proj, home: s.home });
  assert.equal(d.verdict, "deny");
  const s2 = sandbox({ user: rules({ allow: ["Read(./a.txt)"], ask: ["Read(./a.txt)"] }) });
  assert.equal(decideFile({ tool: "Read", file: "a.txt", settings: load(s2), cwd: s2.proj, home: s2.home }).verdict, "ask");
});
