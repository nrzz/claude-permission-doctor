import { sandbox, tmp, writeTranscript } from "./helpers.mjs";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { forEachLine, projectSlug, readRuns, refusal, transcriptFiles } from "../src/transcripts.mjs";

const DAY = 86400000;

test("projectSlug: every character that is not a letter or a digit becomes a dash", () => {
  assert.equal(projectSlug("D:\\Projects\\my app"), "D--Projects-my-app");
  assert.equal(projectSlug("/home/a/b.c"), "-home-a-b-c");
  const long = projectSlug("/x".repeat(150));
  assert.ok(long.length <= 220, "a long path is cut and given a hash");
  assert.equal(projectSlug("/x".repeat(150)), long, "and the hash is stable");
  assert.notEqual(projectSlug("/x".repeat(150) + "a"), long);
});

test("readRuns: commands that ran are returned, commands that were refused are not", () => {
  const s = sandbox();
  const file = writeTranscript(s.cfg, s.proj, [
    { command: "git status" },
    { command: "npm test", failed: true },
    { command: "rm -rf x", denial: "permission-rule" },
    { command: "git push", denial: "user-rejected" },
    { command: "make build", source: "user_temporary" },
    { command: "make deploy", source: "user_permanent" },
    { command: "Get-Date", tool: "PowerShell" },
  ]);
  const runs = readRuns(file);
  assert.deepEqual(runs.map((r) => r.command), ["git status", "npm test", "make build", "make deploy", "Get-Date"]);
  assert.deepEqual(runs.map((r) => r.tool), ["Bash", "Bash", "Bash", "Bash", "PowerShell"]);
  assert.deepEqual(runs.map((r) => r.approved), ["config", "config", "user_temporary", "user_permanent", "config"]);
  assert.ok(runs.every((r) => r.cwd === s.proj && r.session === "s1" && /^\d{4}-/.test(r.ts)));
});

test("readRuns: a transcript from before the decision was recorded falls back to the refusal sentences", () => {
  const s = sandbox();
  const file = writeTranscript(s.cfg, s.proj, [
    { command: "ls", old: true },
    { command: "make", old: true, failed: true },
    { command: "rm x", old: true, denial: "permission-rule" },
    { command: "git push", old: true, denial: "user-rejected" },
  ]);
  const runs = readRuns(file);
  assert.deepEqual(runs.map((r) => r.command), ["ls", "make"], "a command that fails starts with Exit code, a refusal does not");
  assert.deepEqual(runs.map((r) => r.approved), [null, null], "an old transcript does not say who answered");
});

test("refusal: the stamps decide; the sentences are only a fallback", () => {
  assert.deepEqual(refusal({ toolDenialKind: "cancelled" }, {}), { denied: true, by: "stamp", kind: "cancelled" });
  assert.equal(refusal({ permissionDecision: { decision: "reject" } }, {}).denied, true);
  assert.equal(refusal({ permissionDecision: { decision: "accept" } }, { is_error: true, content: "Permission to use Bash has been denied" }).denied, false, "an accepted call is not a refusal, whatever its output says");
  for (const text of ["Permission to use Bash with command x has been denied.", "Permission for this action has been denied", "The user doesn't want to proceed with this tool use.", "This command requires approval", "Claude requested permissions to use Bash, but you haven't granted it yet.", "[Request interrupted by user for tool use]"]) {
    assert.equal(refusal({}, { is_error: true, content: text }).denied, true, text);
  }
  assert.equal(refusal({}, { is_error: true, content: "Exit code 1\nPermission to use" }).denied, false);
  assert.equal(refusal({}, { is_error: false, content: "This command requires approval" }).denied, false, "output of a command that worked is never a refusal");
  assert.equal(refusal({}, { is_error: true, content: [{ type: "text", text: "This command requires approval" }] }).denied, true, "content can be a list of blocks");
});

test("readRuns: a tool_use that never got a result, a line that is not JSON and a result for another call are ignored", () => {
  const s = sandbox();
  const file = writeTranscript(s.cfg, s.proj, [{ command: "ls" }]);
  const orphan = JSON.stringify({ type: "assistant", timestamp: new Date().toISOString(), cwd: s.proj, sessionId: "s1", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_orphan", name: "Bash", input: { command: "never answered" } }] } });
  const stray = JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_nobody", content: "x" }] } });
  fs.appendFileSync(file, `${orphan}\n{ "type": "assistant", "message": { "content": [{ "type": "tool_use", "name": "Bash" \n${stray}\n\n`);
  assert.deepEqual(readRuns(file).map((r) => r.command), ["ls"]);
});

test("readRuns: a tool_use of another tool, or without a command, is not a shell run", () => {
  const s = sandbox();
  const file = path.join(s.cfg, "projects", "x", "s.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const use = (name, input, id) => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
  const res = (id) => JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } });
  fs.writeFileSync(file, [use("Read", { file_path: "a" }, "t1"), res("t1"), use("Bash", {}, "t2"), res("t2"), use("Bash", { command: "ls" }, "t3"), res("t3")].join("\n"));
  assert.deepEqual(readRuns(file).map((r) => r.command), ["ls"]);
});

test("readRuns: sinceMs drops older records", () => {
  const s = sandbox();
  const file = writeTranscript(s.cfg, s.proj, [{ command: "old", daysAgo: 40 }, { command: "new", daysAgo: 2 }]);
  assert.deepEqual(readRuns(file, { sinceMs: Date.now() - 10 * DAY }).map((r) => r.command), ["new"]);
  assert.deepEqual(readRuns(file).map((r) => r.command), ["old", "new"]);
});

test("readRuns: several tool calls in one message", () => {
  const s = sandbox();
  const file = path.join(s.cfg, "projects", "x", "s.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const msg = { type: "assistant", message: { content: [{ type: "tool_use", id: "a", name: "Bash", input: { command: "one" } }, { type: "tool_use", id: "b", name: "Bash", input: { command: "two" } }] } };
  const result = (id) => JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } });
  fs.writeFileSync(file, [JSON.stringify(msg), result("b"), result("a")].join("\n"));
  assert.deepEqual(readRuns(file).map((r) => r.command), ["two", "one"], "in the order the results came");
});

test("readRuns: a file that is not there gives no runs", () => {
  assert.deepEqual(readRuns(path.join(tmp(), "nope.jsonl")), []);
});

test("forEachLine: CRLF, a last line without a newline, and stopping early", () => {
  const file = path.join(tmp(), "t.txt");
  fs.writeFileSync(file, "a\r\nb\nc");
  const seen = [];
  forEachLine(file, (l) => { seen.push(l); });
  assert.deepEqual(seen, ["a", "b", "c"]);
  const first = [];
  forEachLine(file, (l) => { first.push(l); return false; });
  assert.deepEqual(first, ["a"]);
  forEachLine(path.join(tmp(), "missing"), () => assert.fail("no file, no lines"));
});

test("forEachLine: a line longer than one read buffer is not split", () => {
  const file = path.join(tmp(), "big.txt");
  const big = "x".repeat((1 << 20) + 5000);
  fs.writeFileSync(file, `${big}\nend\n`);
  const lens = [];
  forEachLine(file, (l) => { lens.push(l.length); });
  assert.deepEqual(lens, [big.length, 3]);
});

test("transcriptFiles: the project's own folder, folders below it, subagents; not other projects", () => {
  const s = sandbox();
  const inner = path.join(s.proj, "packages", "app");
  const other = path.join(s.base, "proj-two"); // its slug starts with the project's slug
  writeTranscript(s.cfg, s.proj, [{ command: "a" }], { session: "own" });
  writeTranscript(s.cfg, inner, [{ command: "b" }], { session: "inner" });
  writeTranscript(s.cfg, other, [{ command: "c" }], { session: "other" });
  writeTranscript(s.cfg, path.join(s.base, "unrelated"), [{ command: "d" }], { session: "unrelated" });
  const sub = path.join(s.cfg, "projects", s.proj.replace(/[^a-zA-Z0-9]/g, "-"), "own", "subagents");
  fs.mkdirSync(sub, { recursive: true });
  fs.copyFileSync(path.join(s.cfg, "projects", s.proj.replace(/[^a-zA-Z0-9]/g, "-"), "own.jsonl"), path.join(sub, "agent-1.jsonl"));

  const mine = transcriptFiles({ configDir: s.cfg, project: s.proj }).map((t) => path.basename(t.file)).sort();
  assert.deepEqual(mine, ["agent-1.jsonl", "inner.jsonl", "own.jsonl"]);
  const all = transcriptFiles({ configDir: s.cfg, all: true }).map((t) => path.basename(t.file)).sort();
  assert.deepEqual(all, ["agent-1.jsonl", "inner.jsonl", "other.jsonl", "own.jsonl", "unrelated.jsonl"]);
});

test("transcriptFiles: sinceMs skips files nobody touched since; no projects folder is fine", () => {
  const s = sandbox();
  assert.deepEqual(transcriptFiles({ configDir: s.cfg, project: s.proj }), []);
  const file = writeTranscript(s.cfg, s.proj, [{ command: "a" }]);
  const old = new Date(Date.now() - 100 * DAY);
  fs.utimesSync(file, old, old);
  assert.equal(transcriptFiles({ configDir: s.cfg, project: s.proj, sinceMs: Date.now() - 10 * DAY }).length, 0);
  assert.equal(transcriptFiles({ configDir: s.cfg, project: s.proj, sinceMs: Date.now() - 200 * DAY }).length, 1);
});
