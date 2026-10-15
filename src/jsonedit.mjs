// Small, careful edits of a settings file: change one list and leave every other byte as it was.
// The input has already been parsed by JSON.parse, so it is valid JSON; this scanner only has to find
// where a value starts and ends. Nothing here validates.

const WS = /\s/;

function skipWs(text, i) {
  while (i < text.length && WS.test(text[i])) i++;
  return i;
}

function skipString(text, i) {
  i++; // opening quote
  while (i < text.length) {
    if (text[i] === "\\") i += 2;
    else if (text[i] === '"') return i + 1;
    else i++;
  }
  return i;
}

/** Index just after the JSON value that starts at i. */
function skipValue(text, i) {
  const c = text[i];
  if (c === '"') return skipString(text, i);
  if (c === "{" || c === "[") {
    const close = c === "{" ? "}" : "]";
    i++;
    for (;;) {
      i = skipWs(text, i);
      if (text[i] === close) return i + 1;
      if (text[i] === ",") { i++; continue; }
      if (c === "{") {
        i = skipString(text, i); // the key
        i = skipWs(text, i);
        i++; // the colon
        i = skipWs(text, i);
      }
      i = skipValue(text, i);
    }
  }
  let j = i;
  while (j < text.length && !/[,\]}\s]/.test(text[j])) j++;
  return j;
}

/** The range { start, end } of the value at a key path such as ["permissions", "allow"], or null. */
export function findValue(text, keys) {
  let i = skipWs(text, text.charCodeAt(0) === 0xfeff ? 1 : 0);
  let range = { start: i, end: skipValue(text, i) };
  for (const key of keys) {
    let p = skipWs(text, range.start);
    if (text[p] !== "{") return null;
    p++;
    let found = null;
    for (;;) {
      p = skipWs(text, p);
      if (text[p] === "}" || p >= text.length) break;
      if (text[p] === ",") { p++; continue; }
      const ks = p;
      p = skipString(text, p);
      const name = JSON.parse(text.slice(ks, p));
      p = skipWs(text, p);
      p++; // colon
      p = skipWs(text, p);
      const vs = p;
      p = skipValue(text, p);
      if (name === key) found = { start: vs, end: p };
    }
    if (!found) return null;
    range = found;
  }
  return range;
}

/** The ranges of the elements of the array whose range is given. */
export function arrayElements(text, range) {
  const out = [];
  let p = range.start + 1;
  for (;;) {
    p = skipWs(text, p);
    if (text[p] === "]" || p >= range.end) break;
    if (text[p] === ",") { p++; continue; }
    const s = p;
    p = skipValue(text, p);
    out.push({ start: s, end: p });
  }
  return out;
}

/** The leading whitespace of the line that holds index i. */
function lineIndent(text, i) {
  const from = text.lastIndexOf("\n", i - 1) + 1;
  const m = /^[ \t]*/.exec(text.slice(from, i));
  return m ? m[0] : "";
}

/**
 * Rewrite the array at `range` to hold only `elements` (raw JSON text of each), in the layout it had:
 * one per line when it was written that way, else on one line.
 */
export function rebuildArray(text, range, original, keepRaw, addRaw = []) {
  const all = [...keepRaw, ...addRaw];
  const inner = text.slice(range.start + 1, range.end - 1);
  const multiline = /\n/.test(inner);
  if (!all.length) return "[]";
  if (!multiline) return `[${all.join(", ")}]`;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const itemIndent = original.length ? lineIndent(text, original[0].start) : `${lineIndent(text, range.start)}  `;
  const closeIndent = lineIndent(text, range.end - 1);
  return `[${eol}${all.map((r) => `${itemIndent}${r}`).join(`,${eol}`)}${eol}${closeIndent}]`;
}

/**
 * Remove elements (by index) from the array at `keys`, and append `add` (rule strings).
 * Returns the new text, or null when the array is not there.
 */
export function editList(text, keys, removeIdx, add = []) {
  const range = findValue(text, keys);
  if (!range || text[range.start] !== "[") return null;
  const els = arrayElements(text, range);
  const drop = new Set(removeIdx);
  const keep = els.filter((_, i) => !drop.has(i)).map((e) => text.slice(e.start, e.end));
  const replacement = rebuildArray(text, range, els, keep, add.map((a) => JSON.stringify(a)));
  return text.slice(0, range.start) + replacement + text.slice(range.end);
}

/** The indentation unit of a JSON text: "\t", or the number of spaces of the first indented line. */
export function detectIndent(text) {
  const m = /\n([ \t]+)\S/.exec(text);
  if (!m) return 2;
  return m[1][0] === "\t" ? "\t" : m[1].length;
}
