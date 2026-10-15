// How the content of a Bash or PowerShell rule matches a command. The docs describe the shapes
// ("Wildcard patterns" in the permissions page); the details that the docs leave open were checked
// against Claude Code 2.1.295 and are marked "checked".
//
//   Bash(npm test)      no *: matches exactly that command
//   Bash(npm test *)    * stands for any text, spaces included; a trailing " *" (the only *) also
//                       matches the bare command
//   Bash(npm:*)         the same as "npm *"; only recognized at the end of the rule
//
// Checked: the pattern is trimmed and runs of spaces and tabs count as one space, for wildcard and
// :* rules but not for exact ones; a "\*" is a literal star; "**" acts as "*".

import { hasStar } from "./rule.mjs";

/** Parse the content of a rule into { type: "exact" | "prefix" | "wildcard", ... }. */
export function parseContent(content) {
  const m = content.match(/^(.+):\*$/);
  if (m) return { type: "prefix", prefix: m[1], content };
  if (hasStar(content)) return { type: "wildcard", pattern: content, content };
  return { type: "exact", command: content, content };
}

const squeeze = (s) => s.replace(/[ \t]+/g, " ");

/**
 * Compile a wildcard pattern (with * and \*) into a matcher { test(text) } over the whole command.
 * The pattern is cut at its stars into literal pieces: the text must start with the first, end with
 * the last and hold the ones between in order. That takes time linear in the text however many stars
 * a rule has, which a regular expression with many ".*" does not.
 */
export function compileWildcard(pattern, { ignoreCase = false } = {}) {
  const p = squeeze(pattern.trim());
  const pieces = [];
  let cur = "";
  let stars = 0;
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "\\" && (p[i + 1] === "*" || p[i + 1] === "\\")) {
      cur += p[i + 1];
      i++;
      continue;
    }
    if (c === "*") {
      stars++;
      while (p[i + 1] === "*") { i++; stars++; } // ** is the same as *
      pieces.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  pieces.push(cur);
  const fold = ignoreCase ? (s) => s.toLowerCase() : (s) => s;
  const parts = pieces.map(fold);
  // "git *", with the single star after a space, also matches the bare "git"
  const bare = stars === 1 && p.endsWith(" *") ? parts[0].slice(0, -1) : null;
  return {
    test(text) {
      const t = fold(text);
      if (parts.length === 1) return t === parts[0];
      if (bare !== null && t === bare) return true;
      const first = parts[0];
      const last = parts[parts.length - 1];
      if (t.length < first.length + last.length || !t.startsWith(first) || !t.endsWith(last)) return false;
      let pos = first.length;
      const end = t.length - last.length;
      for (let k = 1; k < parts.length - 1; k++) {
        const at = t.indexOf(parts[k], pos);
        if (at === -1 || at + parts[k].length > end) return false;
        pos = at + parts[k].length;
      }
      return true;
    },
  };
}

/**
 * Does a parsed rule content match this command text?
 *   text        one simple command, redirections taken out, spaces trimmed
 *   ignoreCase  PowerShell rules are not case-sensitive
 */
export function matches(parsed, text, { ignoreCase = false } = {}) {
  switch (parsed.type) {
    case "exact":
      return ignoreCase ? parsed.command.toLowerCase() === text.toLowerCase() : parsed.command === text;
    case "prefix": {
      let a = squeeze(parsed.prefix);
      let b = squeeze(text);
      if (ignoreCase) { a = a.toLowerCase(); b = b.toLowerCase(); }
      return b === a || b.startsWith(`${a} `);
    }
    case "wildcard": {
      // compiled once per rule: a history of thousands of commands is matched against every rule
      const slot = ignoreCase ? "_wI" : "_w";
      if (!parsed[slot]) Object.defineProperty(parsed, slot, { value: compileWildcard(parsed.pattern, { ignoreCase }), enumerable: false });
      return parsed[slot].test(squeeze(text));
    }
    default:
      return false;
  }
}

/**
 * Is every command matched by the allow rule `inner` also matched by the rule `outer`? Used to say
 * that a deny or ask rule overrides an allow rule. It is a sound but incomplete test: it treats the
 * inner rule's wildcards as characters only a wildcard of the outer rule can match.
 */
export function covers(outer, inner, { ignoreCase = false } = {}) {
  const probes = innerProbes(inner);
  return probes.every((p) => coverProbe(outer, p, ignoreCase));
}

// The commands an inner rule stands for, with each of its wildcards written as the placeholder STAR.
const STAR = "\u0001";

function innerProbes(inner) {
  switch (inner.type) {
    case "exact":
      return [inner.command];
    case "prefix":
      return [inner.prefix, `${inner.prefix} ${STAR}`];
    default: {
      const p = squeeze(inner.pattern.trim());
      const star = p.replace(/\\\*/g, "\u0002").replace(/\*+/g, STAR).replace(/\u0002/g, "*");
      const probes = [star];
      if (star.endsWith(` ${STAR}`) && (star.match(new RegExp(STAR, "g")) || []).length === 1) probes.push(star.slice(0, -2));
      return probes;
    }
  }
}

function coverProbe(outer, probe, ignoreCase) {
  switch (outer.type) {
    case "exact":
      return !probe.includes(STAR) && (ignoreCase ? outer.command.toLowerCase() === probe.toLowerCase() : outer.command === probe);
    case "prefix": {
      let a = squeeze(outer.prefix);
      let b = squeeze(probe);
      if (ignoreCase) { a = a.toLowerCase(); b = b.toLowerCase(); }
      return b === a || b.startsWith(`${a} `);
    }
    case "wildcard": {
      // the placeholder is an ordinary character that only a star of the outer pattern accepts
      return compileWildcard(outer.pattern, { ignoreCase }).test(probe);
    }
    default:
      return false;
  }
}
