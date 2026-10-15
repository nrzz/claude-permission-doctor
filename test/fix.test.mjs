import { sandbox, tmp } from "./helpers.mjs";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { addRules, applyRemovals, backupPath, planRemovals, restoreBackup, stamp } from "../src/fix.mjs";
import { buildLint } from "../src/commands.mjs";

const perms = (p, extra = {}) => ({ model: "opus", ...extra, permissions: p });
const lint = (s) => buildLint({ project: s.proj, env: s.env(), home: s.home, managed: s.managedDir, transcripts: false });
const plan = (s) => planRemovals(lint(s).findings);
const list = (file, key = "allow") => JSON.parse(fs.readFileSync(file, "utf8")).permissions[key];
const NOW = new Date(2026, 9, 15, 15, 30, 12);

test("stamp and backupPath: <file>.bak-permission-doctor-<timestamp>, with a number when the name is taken", () => {
  assert.equal(stamp(NOW), "20261015-153012");
  const dir = tmp();
  const file = path.join(dir, "settings.json");
  fs.writeFileSync(file, "{}");
  assert.equal(backupPath(file, NOW), `${file}.bak-permission-doctor-20261015-153012`);
  fs.writeFileSync(backupPath(file, NOW), "x");
  assert.equal(backupPath(file, NOW), `${file}.bak-permission-doctor-20261015-153012-1`);
  fs.writeFileSync(backupPath(file, NOW), "x");
  assert.equal(backupPath(file, NOW), `${file}.bak-permission-doctor-20261015-153012-2`);
});

test("planRemovals: the personal copy goes, the copy in the shared file stays, a repeat inside one list is removable anywhere", () => {
  const s = sandbox({
    user: perms({ allow: ["Bash(a *)", "Bash(b *)"] }),
    project: perms({ allow: ["Bash(a *)", "Bash(c *)", "Bash(c *)"] }),
    local: perms({ allow: ["Bash(b *)", "Bash(a *)"] }),
  });
  const p = plan(s);
  const by = Object.fromEntries(p.files.map((f) => [f.scope, f.items.map((i) => `${i.index}:${i.rule}`)]));
  assert.deepEqual(by, { user: ["0:Bash(a *)"], local: ["0:Bash(b *)", "1:Bash(a *)"], project: ["2:Bash(c *)"] });
  assert.deepEqual(p.left, []);
});

test("applyRemovals: a dry run writes nothing; the real run backs up, edits only the list, and says what it did", () => {
  const s = sandbox({ user: perms({ allow: ["Bash(a *)", "Bash(a *)", "Bash(b *)"], deny: ["Bash(d)"] }, { env: { X: "1" } }) });
  const before = fs.readFileSync(s.userFile, "utf8");
  const p = plan(s);
  const dry = applyRemovals(p, { dryRun: true, now: NOW });
  assert.equal(dry.dryRun, true);
  assert.equal(fs.readFileSync(s.userFile, "utf8"), before);
  assert.deepEqual(s.backups(s.userFile), []);
  assert.deepEqual(dry.files[0].removed.map((r) => r.rule), ["Bash(a *)"]);
  assert.equal(dry.files[0].backup, null);

  const done = applyRemovals(p, { now: NOW });
  assert.deepEqual(list(s.userFile), ["Bash(a *)", "Bash(b *)"]);
  assert.deepEqual(list(s.userFile, "deny"), ["Bash(d)"]);
  const backups = s.backups(s.userFile);
  assert.equal(backups.length, 1);
  assert.equal(done.files[0].backup, path.join(s.cfg, backups[0]));
  assert.equal(fs.readFileSync(done.files[0].backup, "utf8"), before, "the backup is the file as it was");
  assert.match(backups[0], /^settings\.json\.bak-permission-doctor-20261015-153012$/);
  const after = JSON.parse(fs.readFileSync(s.userFile, "utf8"));
  assert.equal(after.model, "opus");
  assert.deepEqual(after.env, { X: "1" });
});

test("applyRemovals: a second run finds nothing left to do", () => {
  const s = sandbox({ user: perms({ allow: ["Bash(a *)", "Bash(a *)"] }) });
  applyRemovals(plan(s), { now: NOW });
  assert.deepEqual(plan(s).files, []);
});

test("applyRemovals leaves a file that is not valid JSON alone", () => {
  const s = sandbox({ user: perms({ allow: ["Bash(a *)", "Bash(a *)"] }) });
  const p = plan(s);
  fs.writeFileSync(s.userFile, "{ broken");
  const r = applyRemovals(p, { now: NOW });
  assert.match(r.files[0].skipped, /not valid JSON/);
  assert.deepEqual(r.files[0].removed, []);
  assert.equal(fs.readFileSync(s.userFile, "utf8"), "{ broken");
  assert.deepEqual(s.backups(s.userFile), []);
});

test("applyRemovals keeps the layout: tabs, CRLF and everything outside the list", () => {
  const s = sandbox();
  const text = `{\r\n\t"permissions": {\r\n\t\t"allow": [\r\n\t\t\t"Bash(a *)",\r\n\t\t\t"Bash(a *)",\r\n\t\t\t"Bash(b *)"\r\n\t\t]\r\n\t},\r\n\t"x": [ 1,2 ]\r\n}\r\n`;
  fs.writeFileSync(s.userFile, text);
  applyRemovals(plan(s), { now: NOW });
  assert.equal(fs.readFileSync(s.userFile, "utf8"), text.replace("\t\t\t\"Bash(a *)\",\r\n", ""));
});

test("applyRemovals writes through a symlink and keeps the mode", { skip: process.platform === "win32" }, () => {
  const s = sandbox();
  const real = path.join(tmp(), "real-settings.json");
  fs.writeFileSync(real, JSON.stringify(perms({ allow: ["Bash(a *)", "Bash(a *)"] }), null, 2));
  fs.chmodSync(real, 0o600);
  fs.mkdirSync(s.cfg, { recursive: true });
  fs.symlinkSync(real, s.userFile);
  applyRemovals(plan(s), { now: NOW });
  assert.ok(fs.lstatSync(s.userFile).isSymbolicLink(), "the link is still a link");
  assert.deepEqual(JSON.parse(fs.readFileSync(real, "utf8")).permissions.allow, ["Bash(a *)"]);
  assert.equal(fs.statSync(real).mode & 0o777, 0o600);
});

test("planRemovals: project-file duplicates across files and managed duplicates are reported, not removed", () => {
  const s = sandbox({ project: perms({ allow: ["Bash(m *)"] }), managed: perms({ allow: ["Bash(m *)"] }) });
  const p = plan(s);
  assert.deepEqual(p.files, []);
  assert.equal(p.left.length, 1);
  assert.match(p.left[0], /shared project file belongs to the team/);
});

test("applyRemovals removes dead rules too, from the right list, and the report names the reason", () => {
  const s = sandbox({ user: perms({ allow: ["Bash(a *)"], deny: ["Bash(d *)"], ask: ["Bash(e *)"] }) });
  const findings = [{ id: "dead-rule", file: s.userFile, scope: "user", behavior: "allow", index: 0, rule: "Bash(a *)", autofix: true }];
  const r = applyRemovals(planRemovals(findings), { now: NOW });
  assert.deepEqual(list(s.userFile), []);
  assert.deepEqual(list(s.userFile, "deny"), ["Bash(d *)"]);
  assert.deepEqual(list(s.userFile, "ask"), ["Bash(e *)"]);
  assert.equal(r.files[0].removed[0].why, "dead literal rule");
});

// --- addRules ---------------------------------------------------------------------------------------------------------------

test("addRules appends to the allow list after a backup, skips what is already there, and keeps the rest of the file", () => {
  const s = sandbox({ user: perms({ allow: ["Bash(a *)"], deny: ["Bash(d)"] }) });
  const before = fs.readFileSync(s.userFile, "utf8");
  const r = addRules(s.userFile, ["Bash(a *)", "Bash(new *)"], { scope: "user", now: NOW });
  assert.deepEqual(r.added, ["Bash(new *)"]);
  assert.deepEqual(r.already, ["Bash(a *)"]);
  assert.deepEqual(list(s.userFile), ["Bash(a *)", "Bash(new *)"]);
  assert.deepEqual(list(s.userFile, "deny"), ["Bash(d)"]);
  assert.equal(fs.readFileSync(r.backup, "utf8"), before);
});

test("addRules --dry-run changes nothing", () => {
  const s = sandbox({ user: perms({ allow: ["Bash(a *)"] }) });
  const before = fs.readFileSync(s.userFile, "utf8");
  const r = addRules(s.userFile, ["Bash(new *)"], { scope: "user", dryRun: true, now: NOW });
  assert.deepEqual(r.added, ["Bash(new *)"]);
  assert.equal(fs.readFileSync(s.userFile, "utf8"), before);
  assert.deepEqual(s.backups(s.userFile), []);
  assert.equal(r.dryRun, true);
});

test("addRules creates the file, and the list, when they are missing", () => {
  const s = sandbox();
  const r = addRules(s.userFile, ["Bash(new *)"], { scope: "user", now: NOW });
  assert.equal(r.backup, null, "nothing to back up");
  assert.deepEqual(list(s.userFile), ["Bash(new *)"]);
  const t = sandbox({ user: { model: "opus" } });
  addRules(t.userFile, ["Bash(x *)"], { scope: "user", now: NOW });
  assert.equal(JSON.parse(fs.readFileSync(t.userFile, "utf8")).model, "opus");
  assert.deepEqual(list(t.userFile), ["Bash(x *)"]);
  assert.equal(t.backups(t.userFile).length, 1);
  const u = sandbox({ user: perms({ deny: ["Bash(d)"] }) });
  addRules(u.userFile, ["Bash(x *)"], { scope: "user", now: NOW });
  assert.deepEqual(list(u.userFile, "deny"), ["Bash(d)"]);
  assert.deepEqual(list(u.userFile), ["Bash(x *)"]);
});

test("addRules keeps a file's indentation and line endings when it has to add the list", () => {
  const s = sandbox();
  fs.writeFileSync(s.userFile, "{\r\n    \"model\": \"x\"\r\n}\r\n");
  addRules(s.userFile, ["Bash(x *)"], { scope: "user", now: NOW });
  const text = fs.readFileSync(s.userFile, "utf8");
  assert.equal(text, "{\r\n    \"model\": \"x\",\r\n    \"permissions\": {\r\n        \"allow\": [\r\n            \"Bash(x *)\"\r\n        ]\r\n    }\r\n}\r\n");
});

test("addRules leaves a file that is not valid JSON, not an object, or with odd permissions alone", () => {
  const s = sandbox();
  for (const content of ["{ broken", "[]", "{\"permissions\": []}", "{\"permissions\": null}"]) {
    fs.writeFileSync(s.userFile, content);
    const r = addRules(s.userFile, ["Bash(x *)"], { scope: "user", now: NOW });
    assert.ok(r.skipped, content);
    assert.deepEqual(r.added, [], content);
    assert.equal(fs.readFileSync(s.userFile, "utf8"), content);
  }
  assert.deepEqual(s.backups(s.userFile), []);
});

test("addRules treats an empty file as a missing one", () => {
  const s = sandbox();
  fs.writeFileSync(s.userFile, "  \n");
  const r = addRules(s.userFile, ["Bash(x *)"], { scope: "user", now: NOW });
  assert.deepEqual(r.added, ["Bash(x *)"]);
  assert.deepEqual(list(s.userFile), ["Bash(x *)"]);
});

// --- restoreBackup ----------------------------------------------------------------------------------------------------------------

test("restoreBackup puts the newest backup back, keeping the file as it is now in a backup of its own", () => {
  const s = sandbox({ user: perms({ allow: ["Bash(a *)", "Bash(a *)"] }) });
  const original = fs.readFileSync(s.userFile, "utf8");
  applyRemovals(plan(s), { now: NOW });
  const edited = fs.readFileSync(s.userFile, "utf8");
  assert.notEqual(edited, original);
  const r = restoreBackup(s.userFile, { now: new Date(NOW.getTime() + 60000) });
  assert.equal(r.restored, true);
  assert.equal(fs.readFileSync(s.userFile, "utf8"), original);
  assert.equal(fs.readFileSync(r.savedCurrent, "utf8"), edited, "so the restore can be undone");
  assert.equal(r.others, 0);
  // restoring again goes back to the edit: the newest backup is now the one that was saved
  const again = restoreBackup(s.userFile, { now: new Date(NOW.getTime() + 120000) });
  assert.equal(fs.readFileSync(s.userFile, "utf8"), edited);
  assert.equal(again.restored, true);
});

test("restoreBackup says when there is nothing to restore", () => {
  const s = sandbox({ user: perms({ allow: [] }) });
  const r = restoreBackup(s.userFile);
  assert.equal(r.restored, false);
  assert.match(r.reason, /no backup/);
  assert.equal(restoreBackup(path.join(tmp(), "nope", "settings.json")).restored, false);
});

test("restoreBackup works on a file that was deleted since", () => {
  const s = sandbox({ user: perms({ allow: ["Bash(a *)"] }) });
  addRules(s.userFile, ["Bash(b *)"], { scope: "user", now: NOW });
  fs.rmSync(s.userFile);
  const r = restoreBackup(s.userFile);
  assert.equal(r.restored, true);
  assert.equal(r.savedCurrent, null);
  assert.deepEqual(list(s.userFile), ["Bash(a *)"]);
});
