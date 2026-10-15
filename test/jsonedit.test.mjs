import "./helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { arrayElements, detectIndent, editList, findValue, rebuildArray } from "../src/jsonedit.mjs";

const doc = (indent, eol = "\n") => JSON.stringify({ model: "x", permissions: { allow: ["Bash(a)", "Bash(b)", "Bash(c)"], deny: ["Bash(d)"] }, env: { A: "1" } }, null, indent).replace(/\n/g, eol) + eol;
const list = (text, key) => JSON.parse(text).permissions[key];

test("findValue locates a value by key path and nothing else", () => {
  const text = doc(2);
  const r = findValue(text, ["permissions", "allow"]);
  assert.equal(text[r.start], "[");
  assert.equal(text[r.end - 1], "]");
  assert.deepEqual(JSON.parse(text.slice(r.start, r.end)), ["Bash(a)", "Bash(b)", "Bash(c)"]);
  assert.equal(findValue(text, ["permissions", "ask"]), null);
  assert.equal(findValue(text, ["model", "x"]), null, "a string has no keys");
  assert.equal(text.slice(findValue(text, ["env", "A"]).start, findValue(text, ["env", "A"]).end), "\"1\"");
});

test("findValue is not fooled by braces, brackets and quotes inside strings", () => {
  const text = JSON.stringify({ a: "]}[{", permissions: { allow: ["Bash(echo \"}\")", "Bash(ls [a-z])", "x,y"], ask: [] } }, null, 2);
  assert.deepEqual(JSON.parse(text.slice(findValue(text, ["permissions", "allow"]).start, findValue(text, ["permissions", "allow"]).end)), ["Bash(echo \"}\")", "Bash(ls [a-z])", "x,y"]);
});

test("findValue takes the last of two equal keys, as JSON.parse does", () => {
  const text = "{ \"a\": [1], \"a\": [2, 3] }";
  assert.deepEqual(JSON.parse(text.slice(findValue(text, ["a"]).start, findValue(text, ["a"]).end)), [2, 3]);
});

test("findValue skips a byte order mark", () => {
  const text = `\ufeff${doc(2)}`;
  assert.deepEqual(JSON.parse(text.slice(findValue(text, ["permissions", "deny"]).start, findValue(text, ["permissions", "deny"]).end)), ["Bash(d)"]);
});

test("arrayElements gives the range of each element", () => {
  const text = "{\"a\": [ \"x\" , {\"k\": [1,2]},[3] , 4 ]}";
  const range = findValue(text, ["a"]);
  assert.deepEqual(arrayElements(text, range).map((e) => text.slice(e.start, e.end)), ["\"x\"", "{\"k\": [1,2]}", "[3]", "4"]);
  const empty = "{\"a\": []}";
  assert.deepEqual(arrayElements(empty, findValue(empty, ["a"])), []);
});

for (const [name, indent, eol] of [["two spaces", 2, "\n"], ["four spaces", 4, "\n"], ["tabs", "\t", "\n"], ["CRLF", 2, "\r\n"]]) {
  test(`editList removes by index and keeps every other byte (${name})`, () => {
    const text = doc(indent, eol);
    const next = editList(text, ["permissions", "allow"], [1]);
    assert.deepEqual(list(next, "allow"), ["Bash(a)", "Bash(c)"]);
    assert.deepEqual(list(next, "deny"), ["Bash(d)"]);
    // everything outside the edited array is byte for byte what it was
    const before = findValue(text, ["permissions", "allow"]);
    const after = findValue(next, ["permissions", "allow"]);
    assert.equal(next.slice(0, after.start), text.slice(0, before.start));
    assert.equal(next.slice(after.end), text.slice(before.end));
    // and the layout of the array is the layout it had
    assert.equal(next.includes(eol === "\r\n" ? "\n" : "\n"), true);
    assert.ok(!/[^\r]\n/.test(next) || eol === "\n", "no bare line feed was introduced into a CRLF file");
  });
}

test("editList removes several, all, and none", () => {
  const text = doc(2);
  assert.deepEqual(list(editList(text, ["permissions", "allow"], [0, 2]), "allow"), ["Bash(b)"]);
  assert.deepEqual(list(editList(text, ["permissions", "allow"], [0, 1, 2]), "allow"), []);
  assert.equal(editList(text, ["permissions", "allow"], [0, 1, 2]).includes("\"allow\": []"), true);
  assert.equal(editList(text, ["permissions", "allow"], []), text, "nothing to remove, nothing changes");
  assert.equal(editList(text, ["permissions", "allow"], [7]), text, "an index that is not there is ignored");
});

test("editList appends rules in the layout of the list", () => {
  const multi = editList(doc(2), ["permissions", "allow"], [], ["Bash(new *)"]);
  assert.deepEqual(list(multi, "allow"), ["Bash(a)", "Bash(b)", "Bash(c)", "Bash(new *)"]);
  assert.match(multi, /\n {6}"Bash\(new \*\)"\n/, "one per line, indented like the others");
  const one = "{\"permissions\": {\"allow\": [\"a\", \"b\"]}}";
  assert.equal(editList(one, ["permissions", "allow"], [], ["c"]), "{\"permissions\": {\"allow\": [\"a\", \"b\", \"c\"]}}");
  assert.deepEqual(list(editList(doc(2), ["permissions", "allow"], [0], ["Bash(z)"]), "allow"), ["Bash(b)", "Bash(c)", "Bash(z)"]);
});

test("editList on an empty array, and on a missing list", () => {
  const empty = "{\"permissions\": {\"allow\": []}}";
  assert.equal(editList(empty, ["permissions", "allow"], [], ["x"]), "{\"permissions\": {\"allow\": [\"x\"]}}");
  assert.equal(editList(doc(2), ["permissions", "ask"], [0]), null);
  assert.equal(editList("{\"permissions\": {\"allow\": \"nope\"}}", ["permissions", "allow"], [0]), null, "not an array");
});

test("editList keeps rules with quotes, backslashes and unicode intact", () => {
  const rules = ["Bash(echo \"a b\")", "Bash(ls C:\\\\x\\\\*)", "Bash(echo \u00e9\u4e2d)", "Bash(tab\there)"];
  const text = JSON.stringify({ permissions: { allow: [...rules, "Bash(drop)"] } }, null, 2);
  const next = editList(text, ["permissions", "allow"], [4]);
  assert.deepEqual(list(next, "allow"), rules);
});

test("rebuildArray: one line stays one line, many lines stay many", () => {
  const one = "{\"a\": [\"x\", \"y\"]}";
  const r1 = findValue(one, ["a"]);
  assert.equal(rebuildArray(one, r1, arrayElements(one, r1), ["\"x\""]), "[\"x\"]");
  const many = "{\n  \"a\": [\n    \"x\",\n    \"y\"\n  ]\n}";
  const r2 = findValue(many, ["a"]);
  assert.equal(rebuildArray(many, r2, arrayElements(many, r2), ["\"x\""]), "[\n    \"x\"\n  ]");
  assert.equal(rebuildArray(many, r2, arrayElements(many, r2), []), "[]");
});

test("detectIndent: tabs, the first indented line, two by default", () => {
  assert.equal(detectIndent("{\n\t\"a\": 1\n}"), "\t");
  assert.equal(detectIndent("{\n    \"a\": 1\n}"), 4);
  assert.equal(detectIndent("{\n  \"a\": 1\n}"), 2);
  assert.equal(detectIndent("{\"a\": 1}"), 2);
});
