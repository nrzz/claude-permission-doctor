// Verdicts are checked in bulk by test/table.test.mjs (and against Claude Code by test/oracle.test.mjs).
// These tests look at what `why` says around the verdict: kinds, parts, rules, explanations, fixes, notes.
import { sandbox } from "./helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { buildWhy } from "../src/commands.mjs";
import { renderWhy } from "../src/report.mjs";

const perms = (p) => ({ permissions: p });

function why(spec, input, { tool = "Bash", files = {}, platform } = {}) {
  const s = sandbox({ ...files, ...(spec && !spec.user && !spec.project && !spec.local ? { user: perms(spec) } : spec ? { user: spec.user && perms(spec.user), project: spec.project && perms(spec.project), local: spec.local && perms(spec.local) } : {}) });
  const shell = tool === "Bash" || tool === "PowerShell";
  const m = buildWhy({ tool, command: shell ? input : undefined, target: shell ? undefined : input, project: s.proj, cwd: s.proj, home: s.home, env: s.env(), managed: s.managedDir, platform });
  return { m, d: m.decision, s };
}

test("a bare deny rule removes the tool: kind tool-denied", () => {
  const { d } = why({ deny: ["Bash"] }, "ls");
  assert.equal(d.verdict, "deny");
  assert.equal(d.kind, "tool-denied");
  assert.match(d.summary, /removes the Bash tool/);
  assert.match(d.fix.why, /remove Bash from user settings/);
});

test("a deny rule names its file and line and the part it matched", () => {
  const { d, s } = why({ allow: ["Bash(git commit *)"], deny: ["Bash(git push *)"] }, "git commit -m x && git push origin main");
  assert.equal(d.verdict, "deny");
  assert.equal(d.kind, "deny-rule");
  assert.equal(d.rule.rule, "Bash(git push *)");
  assert.equal(d.rule.file, s.userFile);
  assert.equal(d.rule.line, 7);
  assert.equal(d.rule.scope, "user");
  assert.deepEqual(d.parts.map((p) => p.status), ["allow", "deny"]);
  assert.equal(d.parts[0].rule.rule, "Bash(git commit *)");
  assert.deepEqual(d.separators, ["&&"]);
  assert.match(d.fix.why, /remove or narrow Bash\(git push \*\) in user settings/);
});

test("an ask rule: kind ask-rule, and nothing else is needed to explain the prompt", () => {
  const { d } = why({ allow: ["Bash(git *)"], ask: ["Bash(git push *)"] }, "git push origin main");
  assert.equal(d.verdict, "ask");
  assert.equal(d.kind, "ask-rule");
  assert.equal(d.rule.rule, "Bash(git push *)");
  assert.deepEqual(d.parts.map((p) => p.status), ["ask"]);
  assert.match(d.fix.why, /remove Bash\(git push \*\)/);
});

test("allowed by a rule, and allowed because it only reads", () => {
  const rule = why({ allow: ["Bash(mytool *)"] }, "mytool a");
  assert.equal(rule.d.kind, "allow-rule");
  assert.equal(rule.d.rule.rule, "Bash(mytool *)");
  const ro = why({}, "ls -la | head -3").d;
  assert.equal(ro.verdict, "allow");
  assert.equal(ro.kind, "read-only");
  assert.deepEqual(ro.parts.map((p) => p.status), ["read-only", "read-only"]);
  assert.equal(ro.summary, "every command is read-only");
});

test("a rule found behind a wrapper says what was taken off", () => {
  const { d } = why({ allow: ["Bash(mytool *)"] }, "NODE_ENV=test timeout 5 nice mytool a");
  assert.equal(d.verdict, "allow");
  assert.deepEqual(d.parts[0].stripped, ["NODE_ENV=", "timeout 5", "nice"]);
  assert.match(renderWhy(why({ allow: ["Bash(mytool *)"] }, "timeout 5 mytool a").m), /after taking off timeout 5/);
});

test("a line Claude Code cannot parse prompts and the fix is a rule for the whole line", () => {
  const { d } = why({ allow: ["Bash(mytool *)"] }, "mytool a &&");
  assert.equal(d.verdict, "ask");
  assert.equal(d.kind, "unparseable");
  assert.match(d.summary, /cannot parse/);
  assert.equal(d.fix.rule, "Bash(mytool a &&)");
});

test("substitutions, subshells and unknown variables: cannot-check, with the reasons listed", () => {
  const { d } = why({ allow: ["Bash(echo *)", "Bash(mytool *)"] }, "echo $(mytool a) $FOO");
  assert.equal(d.verdict, "ask");
  assert.equal(d.kind, "cannot-check");
  assert.deepEqual(d.issues.map((i) => i.kind).sort(), ["substitution", "variable"]);
  assert.ok(d.parts.some((p) => p.context.includes("substitution")), "the command inside is listed, marked as inside");
  assert.equal(d.fix.rule, "Bash(echo $(mytool a) $FOO)");
  assert.match(renderWhy(why({}, "echo $(date) | tee out.txt").m), /Claude Code cannot check this line before it runs/);
});

test("the & operator makes a line that would be allowed prompt, and the fix is to drop it", () => {
  const { d } = why({ allow: ["Bash(mytool *)"] }, "mytool a &");
  assert.equal(d.verdict, "ask");
  assert.equal(d.kind, "cannot-check");
  assert.match(d.summary, /background/);
  assert.equal(d.fix.rule, null);
  assert.match(d.fix.why, /without the &/);
});

test("no rule: the explanation names what is wrong with the near misses", () => {
  const cases = [
    [{ allow: ["Bash(npm test)"] }, "npm test --watch", /has no \*, so it matches only the exact command `npm test`; this one continues after it/],
    [{ allow: ["Bash(npm run build:*)"] }, "npm run test", /needs the command to start with `npm run build`/],
    [{ allow: ["Bash(git * main)"] }, "git fetch origin", /needs the command to end with `main`/],
    [{ allow: ["Bash(mytool *)"] }, "env mytool a", /does not look through `env` for allow rules/],
    [{ allow: ["Bash(mytool *)"] }, "FOO=1 mytool a", /would match without `FOO=` in front, but an allow rule does not match past an assignment/],
    [{ allow: ["Bash(npm run test:* x)"] }, "npm run test", /the colon is a literal character here/],
    [{ allow: ["Bash(git commit *)"] }, "git commit-tree x", /needs a space after `git commit`, and this command has more letters straight after it/],
    [{ allow: ["Bash(git push origin *)"] }, "git pull origin main", /stops short: it needs the command to start with `git push origin`/],
  ];
  for (const [rules, command, pattern] of cases) {
    const { d } = why(rules, command);
    assert.equal(d.verdict, "ask", command);
    assert.ok(d.parts.some((p) => p.misses.some((x) => pattern.test(x))), `${command}: ${JSON.stringify(d.parts.map((p) => p.misses))}`);
  }
});

test("every unresolved command is explained, and gets its own rule in fixes", () => {
  const { d } = why({ allow: ["Bash(mytool *)"] }, "npm test --watch && env mytool a && sudo npm install x");
  assert.equal(d.parts.filter((p) => p.status === "no-rule").length, 3);
  assert.deepEqual(d.fixes.map((f) => f.rule), ["Bash(npm test *)", "Bash(env mytool *)", "Bash(sudo npm install *)"]);
  assert.deepEqual(d.fixes.map((f) => f.for), ["npm test --watch", "env mytool a", "sudo npm install x"]);
  assert.equal(d.fix.rule, "Bash(npm test *)", "fix is the first of them");
  assert.equal(d.fixes[2].risk, "installs and runs third-party code");
  const text = renderWhy(why({ allow: ["Bash(mytool *)"] }, "npm test --watch && env mytool a").m);
  assert.match(text, /a rule for each command that has none/);
});

test("the fix for one command is a prefix rule for its program and subcommand", () => {
  assert.equal(why({}, "npm test").d.fix.rule, "Bash(npm test *)");
  assert.equal(why({}, "git commit -m 'x y'").d.fix.rule, "Bash(git commit *)");
  assert.equal(why({}, "npm run build").d.fix.rule, "Bash(npm run build *)");
  assert.equal(why({}, "gh pr view 12").d.fix.rule, "Bash(gh pr view *)");
  assert.equal(why({}, "mytool deploy").d.fix.rule, "Bash(mytool *)");
  assert.equal(why({}, "sudo -u bob make install").d.fix.rule, "Bash(sudo -u bob make install *)");
  assert.equal(why({}, "FOO=1 make build").d.fix.rule, "Bash(FOO=1 make build *)");
  assert.equal(why({}, "python3 -c \"print(1)\"").d.fix.rule, "Bash(python3 -c \"print(1)\")", "inline code needs the whole command in the rule");
  assert.equal(why({}, "sudo python3 -c \"x\"").d.fix.rule, "Bash(sudo python3 -c \"x\")");
  assert.equal(why({}, "rm -rf build").d.fix.risk, "deletes files");
  assert.equal(why({}, "git push origin main").d.fix.risk, "publishes commits");
});

test("a command that reaches outside the working folders: the fix is a folder or a Read rule, not a Bash rule", () => {
  const { d } = why({ allow: ["Bash(cat *)"] }, "cat ../secret.txt");
  assert.equal(d.verdict, "ask");
  assert.equal(d.kind, "path");
  assert.equal(d.fix.rule, null);
  assert.match(d.fix.why, /\/add-dir|additionalDirectories/);
  assert.match(d.fix.why, /Read\(\/\/path\/\*\*\)/);
});

test("a path with a .. after a directory name or a // inside: asked about whatever the rules say", () => {
  for (const command of ["cat sub/../a.txt", "head sub//a.txt"]) {
    const { d } = why({ allow: ["Bash(cat *)", "Bash(head *)"] }, command, { platform: "win32" });
    assert.equal(d.verdict, "ask", command);
    assert.equal(d.kind, "path");
    assert.equal(d.fix.rule, null);
    assert.match(d.fix.why, /write the path another way/);
    assert.match(d.summary, /whatever the rules say/);
  }
});

test("a redirection needs an Edit rule, and the fix says so", () => {
  const { d } = why({ allow: ["Bash(mytool *)"] }, "mytool a > out.txt");
  assert.equal(d.verdict, "ask");
  assert.equal(d.kind, "path");
  assert.equal(d.fix.rule, "Edit(out.txt)");
  assert.match(d.fix.why, /checks a redirection against Edit rules/);
  const unknown = why({ allow: ["Bash(mytool *)"] }, "mytool a > *.txt").d;
  assert.equal(unknown.fix.rule, null);
  assert.match(unknown.fix.why, /can only be approved by hand/);
});

test("cd rules: several, git after a move, a redirection after a move", () => {
  const multi = why({}, "cd sub && cd ..").d;
  assert.equal(multi.verdict, "ask");
  assert.equal(multi.kind, "cd");
  assert.match(multi.summary, /several directory changes/);
  assert.match(multi.fix.why, /run the command without the cd/);
  assert.match(why({}, "cd sub && git status").d.summary, /git after a cd into another folder/);
  assert.match(why({ allow: ["Bash(mytool *)", "Edit(./out.txt)"] }, "cd sub && mytool a > out.txt").d.summary, /after a cd into another folder/);
  assert.equal(why({}, "cd sub && ls").d.verdict, "allow");
});

test("a for loop takes the read-only shortcut away, and says why", () => {
  const { d } = why({}, "for i in 1 2; do ls; done");
  assert.equal(d.verdict, "ask");
  assert.ok(d.parts.some((p) => /inside a for loop only an allow rule counts/.test(p.detail)));
});

test("parts inside an if are marked with where they sit", () => {
  const { d } = why({ allow: ["Bash(mytool *)"] }, "if true; then mytool a; fi");
  assert.equal(d.verdict, "allow");
  const inner = d.parts.find((p) => p.text === "mytool a");
  assert.deepEqual(inner.context, ["if"]);
});

test("a bare allow rule allows everything, and says so on every part", () => {
  const { d } = why({ allow: ["Bash"] }, "rm nothing && echo $(date)");
  assert.equal(d.verdict, "allow");
  assert.ok(d.parts.every((p) => p.status === "allow" && p.rule.rule === "Bash"));
});

test("exact whole-line rules skip the substitution check but not the path check", () => {
  assert.equal(why({ allow: ["Bash(echo $(date))"] }, "echo $(date)").d.verdict, "allow");
  assert.equal(why({ allow: ["Bash(cat sub/../a.txt)"] }, "cat sub/../a.txt").d.verdict, "ask");
});

test("notes: project allow rules need workspace trust; defaultMode other than default; the PowerShell && caveat", () => {
  const trust = why({ project: { allow: ["Bash(mytool *)"] } }, "mytool a").m;
  assert.ok(trust.notes.some((n) => n.includes("workspace trust dialog")));
  const mode = why({ user: { allow: ["Bash(mytool *)"], defaultMode: "acceptEdits" } }, "mytool a").m;
  assert.ok(mode.notes.some((n) => n.includes("defaultMode acceptEdits")));
  const chain = why({ allow: ["PowerShell(mytool *)"] }, "mytool a && mytool b", { tool: "PowerShell" }).m;
  assert.equal(chain.notes.filter((n) => n.includes("PowerShell 7")).length, 1, "said once");
  assert.equal(why({}, "ls").m.notes.length, 0);
});

test("the report names the config folder and counts the rules it read", () => {
  const { m, s } = why({ allow: ["Bash(a *)", "Bash(b *)"], deny: ["Bash(c *)"] }, "ls");
  assert.equal(m.configDir, s.cfg.split("\\").join("/"));
  assert.equal(m.configDirSource, "CLAUDE_CONFIG_DIR");
  assert.deepEqual(m.rulesRead, { allow: 2, ask: 0, deny: 1, files: 1 });
  assert.match(renderWhy(m), /\(from CLAUDE_CONFIG_DIR\)/);
});

test("other tools: files, URLs and tools by name come back in the same shape", () => {
  const file = why({ deny: ["Read(./.env)"] }, "./.env", { tool: "Read" });
  assert.equal(file.m.kind, "file");
  assert.equal(file.d.verdict, "deny");
  assert.equal(file.d.rule.rule, "Read(./.env)");
  const url = why({ allow: ["WebFetch(domain:docs.example.com)"] }, "https://docs.example.com/x", { tool: "WebFetch" });
  assert.equal(url.m.kind, "url");
  assert.equal(url.d.verdict, "allow");
  const other = why({ allow: ["mcp__srv"] }, "mcp__srv__tool", { tool: "mcp__srv__tool" });
  assert.equal(other.m.kind, "tool");
  assert.equal(other.d.verdict, "allow");
  assert.match(renderWhy(file.m), /why this read is refused/);
  assert.match(renderWhy(url.m), /why this fetch runs without a prompt/);
});

test("PowerShell: aliases, case, and the rule that matched", () => {
  const { d } = why({ allow: ["PowerShell(Get-Process *)"] }, "gps -Name x; ps", { tool: "PowerShell" });
  assert.equal(d.verdict, "allow");
  assert.deepEqual(d.parts.map((p) => p.status), ["allow", "allow"]);
  const deny = why({ deny: ["PowerShell(Remove-Item *)"] }, "rm x", { tool: "PowerShell" }).d;
  assert.equal(deny.verdict, "deny");
  assert.equal(deny.rule.rule, "PowerShell(Remove-Item *)");
});

test("PowerShell: a variable or a // is a reason Claude Code cannot check the line", () => {
  assert.deepEqual(why({ allow: ["PowerShell(mytool *)"] }, "mytool $true", { tool: "PowerShell" }).d.issues.map((i) => i.kind), ["variable"]);
  assert.deepEqual(why({ allow: ["PowerShell(mytool *)"] }, "mytool a//b", { tool: "PowerShell", platform: "win32" }).d.issues.map((i) => i.kind), ["unc-path"]);
  assert.deepEqual(why({ allow: ["PowerShell(mytool *)"] }, "mytool a//b", { tool: "PowerShell", platform: "linux" }).d.issues, [], "a // is only a network path on Windows");
});

test("Bash: ANSI-C and locale quotes are reasons Claude Code cannot check the line", () => {
  assert.deepEqual(why({ allow: ["Bash(mytool *)"] }, "mytool $'a b'").d.issues.map((i) => i.kind), ["ansi-c-quote"]);
  assert.deepEqual(why({ allow: ["Bash(mytool *)"] }, "mytool $\"a b\"").d.issues.map((i) => i.kind), ["locale-quote"]);
  assert.equal(why({ allow: ["Bash(mytool *)"] }, "mytool \"$'a'\"").d.verdict, "allow", "inside double quotes the $' is just text");
});

test("empty and whitespace-only commands do not throw", () => {
  for (const c of ["", "   ", "\n", ";", "&&", "#"]) {
    const { d } = why({}, c);
    assert.ok(["allow", "ask", "deny"].includes(d.verdict), JSON.stringify(c));
  }
});
