import { sandbox, tmp } from "./helpers.mjs";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { activeRules, configDir, gitRoot, loadSettings, localSettingsPaths, managedDir, SCOPES, shortPath } from "../src/settings.mjs";

const load = (s, extra = {}) => loadSettings({ project: s.proj, env: s.env(), home: s.home, managed: s.managedDir, ...extra });
const perms = (p) => ({ permissions: p });

test("the files are listed in precedence order: managed, local, project, user", () => {
  const s = sandbox({ user: perms({ allow: ["Bash(a *)"] }), project: perms({ allow: ["Bash(b *)"] }), local: perms({ allow: ["Bash(c *)"] }), managed: perms({ deny: ["Bash(d *)"] }) });
  const st = load(s);
  assert.deepEqual(SCOPES, ["managed", "local", "project", "user"]);
  assert.deepEqual(st.files.map((f) => f.scope), ["managed", "local", "project", "user"]);
  assert.deepEqual(st.files.map((f) => f.exists), [true, true, true, true]);
  assert.deepEqual(st.rules.map((r) => `${r.scope}:${r.behavior}:${r.raw}`), ["managed:deny:Bash(d *)", "local:allow:Bash(c *)", "project:allow:Bash(b *)", "user:allow:Bash(a *)"]);
  assert.deepEqual(st.files.map((f) => f.label), ["managed settings", "local settings", "project settings", "user settings"]);
});

test("files that are not there are listed as missing, and rules are empty", () => {
  const st = load(sandbox());
  assert.equal(st.files.length, 4);
  assert.ok(st.files.every((f) => !f.exists));
  assert.deepEqual(st.rules, []);
});

test("CLAUDE_CONFIG_DIR picks the user settings; without it the home folder's .claude is used", () => {
  const s = sandbox({ user: perms({ allow: ["Bash(x *)"] }) });
  const st = load(s);
  assert.equal(st.configDir, s.cfg);
  assert.equal(st.configSource, "CLAUDE_CONFIG_DIR");
  assert.equal(st.files.find((f) => f.scope === "user").path, s.userFile);

  const other = tmp();
  fs.mkdirSync(path.join(other, ".claude"));
  fs.writeFileSync(path.join(other, ".claude", "settings.json"), JSON.stringify(perms({ deny: ["Bash(y *)"] })));
  const dflt = loadSettings({ project: s.proj, env: {}, home: other, managed: s.managedDir });
  assert.equal(dflt.configSource, "default");
  assert.equal(dflt.configDir, path.join(other, ".claude"));
  assert.deepEqual(dflt.rules.map((r) => r.raw), ["Bash(y *)"]);
  assert.deepEqual(configDir({ CLAUDE_CONFIG_DIR: "/x/y" }, "/home/a"), { dir: path.resolve("/x/y"), source: "CLAUDE_CONFIG_DIR" });
  assert.deepEqual(configDir({}, "/home/a"), { dir: path.join("/home/a", ".claude"), source: "default" });
});

test("managedDir names the system folder for each platform", () => {
  assert.equal(managedDir("win32"), "C:\\Program Files\\ClaudeCode");
  assert.equal(managedDir("darwin"), "/Library/Application Support/ClaudeCode");
  assert.equal(managedDir("linux"), "/etc/claude-code");
});

test("the managed folder comes from the option, then CLAUDE_PERMISSION_DOCTOR_MANAGED_DIR", () => {
  const s = sandbox({ managed: perms({ deny: ["Bash(m *)"] }) });
  assert.deepEqual(loadSettings({ project: s.proj, env: s.env(), home: s.home }).rules.map((r) => r.raw), ["Bash(m *)"], "from the environment variable");
  const empty = tmp();
  assert.deepEqual(loadSettings({ project: s.proj, env: s.env(), home: s.home, managed: empty }).rules, [], "the option wins");
});

test("managed-settings.d drop-ins are read in name order, hidden and non-JSON files are not", () => {
  const s = sandbox({ managed: perms({ deny: ["Bash(a *)"] }) });
  const drop = path.join(s.managedDir, "managed-settings.d");
  fs.mkdirSync(drop);
  fs.writeFileSync(path.join(drop, "20-b.json"), JSON.stringify(perms({ deny: ["Bash(b *)"] })));
  fs.writeFileSync(path.join(drop, "10-a.json"), JSON.stringify(perms({ ask: ["Bash(c *)"] })));
  fs.writeFileSync(path.join(drop, ".hidden.json"), JSON.stringify(perms({ deny: ["Bash(h *)"] })));
  fs.writeFileSync(path.join(drop, "notes.txt"), "x");
  const st = load(s);
  assert.deepEqual(st.rules.map((r) => r.raw), ["Bash(a *)", "Bash(c *)", "Bash(b *)"]);
  assert.deepEqual(st.files.filter((f) => f.scope === "managed").map((f) => f.label), ["managed settings", "managed settings (10-a.json)", "managed settings (20-b.json)"]);
});

test("a file that is not valid JSON is reported and none of its rules count; the others still load", () => {
  const s = sandbox({ user: "{ \"permissions\": { \"allow\": [\"Bash(a *)\", ] } }", project: perms({ allow: ["Bash(b *)"] }) });
  const st = load(s);
  const user = st.files.find((f) => f.scope === "user");
  assert.match(user.error, /^is not valid JSON/);
  assert.deepEqual(st.rules.map((r) => r.raw), ["Bash(b *)"]);
});

test("a file with a byte order mark loads; an empty file and a non-object are errors", () => {
  const bom = sandbox({ user: `\ufeff${JSON.stringify(perms({ allow: ["Bash(a *)"] }))}` });
  assert.deepEqual(load(bom).rules.map((r) => r.raw), ["Bash(a *)"]);
  assert.equal(load(sandbox({ user: "" })).files.find((f) => f.scope === "user").error, "is empty");
  assert.equal(load(sandbox({ user: "   \n" })).files.find((f) => f.scope === "user").error, "is empty");
  assert.equal(load(sandbox({ user: "[]" })).files.find((f) => f.scope === "user").error, "is not a JSON object");
  assert.equal(load(sandbox({ user: "null" })).files.find((f) => f.scope === "user").error, "is not a JSON object");
});

test("a settings path that is a folder is an error, not a crash", () => {
  const s = sandbox();
  fs.mkdirSync(s.userFile, { recursive: true });
  const st = load(s);
  assert.match(st.files.find((f) => f.scope === "user").error, /cannot be read/);
});

test("permissions that is not an object, or a list that is not a list, are reported", () => {
  const a = load(sandbox({ user: { permissions: [] } }));
  assert.equal(a.files.find((f) => f.scope === "user").error, 'has "permissions" that is not an object');
  const b = load(sandbox({ user: perms({ allow: "Bash(a *)", deny: ["Bash(b *)"] }) }));
  assert.deepEqual(b.rules.map((r) => r.raw), ["Bash(b *)"]);
  assert.ok(b.notes.some((n) => n.includes("permissions.allow is not a list")));
  assert.deepEqual(load(sandbox({ user: { env: { A: "1" } } })).rules, [], "a file without permissions has no rules");
});

test("every rule keeps where it came from, its position and what is wrong with it", () => {
  const s = sandbox({ user: perms({ allow: ["Bash(ls *)", "bash(x)", 42, "Bash(git * main)"], deny: ["Read(./.env)"] }) });
  const st = load(s);
  const byRaw = Object.fromEntries(st.rules.map((r) => [r.raw, r]));
  assert.equal(byRaw["Bash(ls *)"].index, 0);
  assert.equal(byRaw["Bash(ls *)"].file, s.userFile);
  assert.equal(byRaw["Bash(ls *)"].parsed.type, "wildcard");
  assert.equal(byRaw["bash(x)"].problem.code, "lowercase");
  assert.equal(byRaw["42"].problem.code, "not-a-string");
  assert.equal(byRaw["Bash(git * main)"].warnings[0].code, "wildcard-before-subcommand");
  assert.equal(byRaw["Read(./.env)"].parsed, null, "only Bash and PowerShell rules are parsed as commands");
  assert.equal(byRaw["Read(./.env)"].content, "./.env");
});

test("Bash and Bash(*) are bare rules; Bash(**) and Bash(* ) are ordinary wildcards", () => {
  const st = load(sandbox({ user: perms({ allow: ["Bash", "Bash(*)", "Bash(**)", "Bash(* )", "Read"] }) }));
  assert.deepEqual(st.rules.map((r) => r.bare), [true, true, false, false, true]);
});

test("allowManagedPermissionRulesOnly makes the user, project and local rules ignored", () => {
  const s = sandbox({ managed: { allowManagedPermissionRulesOnly: true, permissions: { deny: ["Bash(m *)"] } }, user: perms({ allow: ["Bash(a *)"] }), project: perms({ allow: ["Bash(b *)"] }) });
  const st = load(s);
  assert.equal(st.managedOnly, true);
  assert.deepEqual(st.rules.filter((r) => r.ignored).map((r) => r.raw), ["Bash(b *)", "Bash(a *)"]);
  assert.ok(st.notes.some((n) => n.includes("allowManagedPermissionRulesOnly")));
  assert.deepEqual(activeRules(st).allow, []);
  assert.equal(activeRules(st).deny.length, 1);
});

test("activeRules drops skipped and ignored rules and can filter by tool", () => {
  const st = load(sandbox({ user: perms({ allow: ["Bash(a *)", "bash(x)", "Read(./x)"], deny: ["Bash(d *)"], ask: ["Edit(./e)"] }) }));
  const all = activeRules(st);
  assert.deepEqual(all.allow.map((r) => r.raw), ["Bash(a *)", "Read(./x)"]);
  assert.deepEqual(activeRules(st, { tool: "Bash" }).allow.map((r) => r.raw), ["Bash(a *)"]);
  assert.deepEqual(activeRules(st, { tool: "Edit" }).ask.map((r) => r.raw), ["Edit(./e)"]);
  assert.deepEqual(activeRules(st, { tool: "Edit" }).deny, []);
});

test("additionalDirectories resolve against the file that lists them", () => {
  const s = sandbox({ user: perms({ additionalDirectories: ["rel", "~/h", "//abs"] }), project: perms({ additionalDirectories: ["../sibling", "inner"] }) });
  const st = load(s);
  const names = st.additionalDirectories;
  assert.ok(names.includes(path.join(s.cfg, "rel")), "a user directory is relative to the config folder");
  assert.ok(names.includes(path.join(s.home, "h")));
  assert.ok(names.includes(path.resolve("/abs")));
  assert.ok(names.includes(path.resolve(s.proj, "../sibling")), "a project directory is relative to the project");
  assert.ok(names.includes(path.join(s.proj, "inner")));
});

test("defaultMode is read from each file", () => {
  const st = load(sandbox({ project: perms({ defaultMode: "acceptEdits" }), user: perms({ defaultMode: 5 }) }));
  assert.equal(st.files.find((f) => f.scope === "project").defaultMode, "acceptEdits");
  assert.equal(st.files.find((f) => f.scope === "user").defaultMode, null);
});

test("gitRoot finds the repository above a folder, and the main checkout of a worktree", () => {
  const base = tmp();
  fs.mkdirSync(path.join(base, "repo", ".git"), { recursive: true });
  fs.mkdirSync(path.join(base, "repo", "packages", "app"), { recursive: true });
  assert.equal(gitRoot(path.join(base, "repo", "packages", "app")), path.join(base, "repo"));
  assert.equal(gitRoot(path.join(base, "repo")), path.join(base, "repo"));

  fs.mkdirSync(path.join(base, "main", ".git", "worktrees", "wt1"), { recursive: true });
  fs.mkdirSync(path.join(base, "wt"), { recursive: true });
  fs.writeFileSync(path.join(base, "wt", ".git"), `gitdir: ${path.join(base, "main", ".git", "worktrees", "wt1")}\n`);
  assert.equal(gitRoot(path.join(base, "wt")), path.join(base, "main"));

  fs.mkdirSync(path.join(base, "sub"), { recursive: true });
  fs.writeFileSync(path.join(base, "sub", ".git"), "not a gitdir line\n");
  assert.equal(gitRoot(path.join(base, "sub")), path.join(base, "sub"), "a .git file that is not a worktree pointer is a root too");
});

test("localSettingsPaths: the repository root in a repository, the folder itself elsewhere and on Windows", () => {
  const base = tmp();
  const home = path.join(base, "home");
  fs.mkdirSync(home);
  fs.mkdirSync(path.join(base, "repo", ".git"), { recursive: true });
  const app = path.join(base, "repo", "packages", "app");
  fs.mkdirSync(app, { recursive: true });
  const own = path.join(app, ".claude", "settings.local.json");
  const atRoot = path.join(base, "repo", ".claude", "settings.local.json");
  assert.deepEqual(localSettingsPaths(app, { home, platform: "linux" }), [atRoot, own]);
  assert.deepEqual(localSettingsPaths(path.join(base, "repo"), { home, platform: "linux" }), [atRoot]);
  assert.deepEqual(localSettingsPaths(app, { home, platform: "win32" }), [own], "Windows keeps it in the folder");
  assert.deepEqual(localSettingsPaths(app, { home: path.join(base, "repo"), platform: "darwin" }), [own], "a repository that is the home folder does not count");
});

test("a local file at the repository root is read, and a file left in the folder is too", () => {
  const base = tmp();
  const home = path.join(base, "home");
  const cfg = path.join(base, "cfg");
  fs.mkdirSync(home);
  fs.mkdirSync(cfg);
  const app = path.join(base, "repo", "app");
  fs.mkdirSync(path.join(base, "repo", ".git"), { recursive: true });
  fs.mkdirSync(path.join(base, "repo", ".claude"), { recursive: true });
  fs.mkdirSync(path.join(app, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(base, "repo", ".claude", "settings.local.json"), JSON.stringify(perms({ allow: ["Bash(root *)"] })));
  fs.writeFileSync(path.join(app, ".claude", "settings.local.json"), JSON.stringify(perms({ allow: ["Bash(own *)"] })));
  const st = loadSettings({ project: app, env: { CLAUDE_CONFIG_DIR: cfg }, home, platform: "linux", managed: path.join(base, "none") });
  assert.deepEqual(st.rules.map((r) => r.raw), ["Bash(root *)", "Bash(own *)"]);
  assert.equal(st.files.filter((f) => f.scope === "local").length, 2);
});

test("shortPath shows project files relative, home files as ~/, the rest in full with forward slashes", () => {
  const base = tmp();
  const project = path.join(base, "proj");
  const home = path.join(base, "home");
  assert.equal(shortPath(path.join(project, ".claude", "settings.json"), { home, project }), ".claude/settings.json");
  assert.equal(shortPath(path.join(home, ".claude", "settings.json"), { home, project }), "~/.claude/settings.json");
  assert.equal(shortPath(path.join(base, "elsewhere", "x.json"), { home, project }), path.join(base, "elsewhere", "x.json").split(path.sep).join("/"));
  assert.equal(shortPath(project, { home, project }), project.split(path.sep).join("/"), "the project folder itself is not 'relative'");
});
