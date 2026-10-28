// "Why did none of my rules match?" For one command that no allow rule covers, look at the rules
// that name the same program and say, in a sentence each, what keeps them from matching: no * in the
// rule, a prefix that stops short, a colon that is not at the end, a wrapper or a variable in front.
import { hasStar } from "./rule.mjs";

const squeeze = (s) => s.replace(/[ \t]+/g, " ").trim();
const firstWord = (s) => squeeze(s).split(" ")[0] || "";

/** Characters of a pattern before its first unescaped "*". */
function head(pattern) {
  for (let i = 0; i < pattern.length; i++) if (pattern[i] === "*" && pattern[i - 1] !== "\\") return pattern.slice(0, i);
  return pattern;
}

function tail(pattern) {
  for (let i = pattern.length - 1; i >= 0; i--) if (pattern[i] === "*" && pattern[i - 1] !== "\\") return pattern.slice(i + 1);
  return pattern;
}

const show = (s) => `\`${s}\``;

/** The first words of `text`, as many as the rule has literal words in front, for a "yours has" phrase. */
function sample(text, words) {
  return squeeze(text).split(" ").slice(0, Math.max(1, words)).join(" ");
}

/**
 * @param tool       "Bash" or "PowerShell"
 * @param allowRules the active allow rules of this tool (entries with .parsed and .raw)
 * @param texts      the texts a rule is matched against for this command, whole command first
 * @param deepTexts  the same with every wrapper and assignment off (what a deny rule sees), as { text, stripped }
 * @param ignoreCase PowerShell
 */
export function explainMisses({ tool, allowRules, texts, deepTexts, matchesRule, ignoreCase = false }) {
  const out = [];
  const lc = (s) => (ignoreCase ? s.toLowerCase() : s);

  // 1. A rule would match if Claude Code looked through the wrapper or assignment in front.
  for (const d of deepTexts) {
    if (!d.stripped.length || texts.some((t) => t.text === d.text)) continue;
    const hit = allowRules.find((r) => r.parsed && matchesRule(r, d.text));
    if (hit) {
      const names = d.stripped.map((s) => s.replace(/=$/, "="));
      const isEnv = d.stripped.every((s) => /^[A-Za-z_]\w*=$/.test(s));
      const dir = d.stripped.find((s) => s.endsWith("/"));
      if (dir) {
        out.push(`${show(hit.raw)} would match ${show(d.text)}, but an allow rule matches the program as it is written, with ${show(dir)} in front; deny and ask rules also match its name (Claude Code 2.1.309 and newer)`);
        break;
      }
      out.push(isEnv
        ? `${show(hit.raw)} would match without ${names.map(show).join(", ")} in front, but an allow rule does not match past an assignment of a variable that is not on Claude Code's short safe list (deny and ask rules do)`
        : `${show(hit.raw)} would match ${show(d.text)}, but Claude Code does not look through ${names.map((n) => show(n.split(" ")[0])).join(", ")} for allow rules (only timeout, time, nice, nohup, stdbuf, command, builtin and a bare xargs); deny and ask rules do`);
      break;
    }
  }

  // 2. Rules for the same program.
  const programs = new Set(texts.map((t) => lc(firstWord(t.text))));
  for (const r of allowRules) {
    if (out.length >= 3) break;
    if (!r.parsed) continue;
    const content = r.content;
    if (content.includes(":*") && !r.parsed.prefix) {
      out.push(`${show(r.raw)}: the colon is a literal character here, because :* only works at the end of a rule; it matches commands that start with the text before the colon, a colon, and then anything`);
      continue;
    }
    let ruleProgram = "";
    if (r.parsed.type === "exact") ruleProgram = firstWord(r.parsed.command);
    else if (r.parsed.type === "prefix") ruleProgram = firstWord(r.parsed.prefix);
    else ruleProgram = firstWord(r.parsed.pattern);
    if (!ruleProgram || hasStar(ruleProgram) || !programs.has(lc(ruleProgram))) continue;
    const text = texts[texts.length - 1].text; // the command with the most taken off
    switch (r.parsed.type) {
      case "exact":
        out.push(squeeze(text).startsWith(squeeze(r.parsed.command))
          ? `${show(r.raw)} has no *, so it matches only the exact command ${show(r.parsed.command)}; this one continues after it`
          : `${show(r.raw)} has no *, so it matches only the exact command ${show(r.parsed.command)}`);
        break;
      case "prefix": {
        const p = r.parsed.prefix;
        out.push(`${show(r.raw)} needs the command to start with ${show(squeeze(p))}, this one starts with ${show(sample(text, squeeze(p).split(" ").length))}`);
        break;
      }
      default: {
        const rawHead = head(r.parsed.pattern);
        const hw = squeeze(rawHead);
        const spaced = /\s$/.test(rawHead);
        const t = squeeze(tail(r.parsed.pattern));
        const flat = squeeze(text);
        if (hw && !lc(flat).startsWith(lc(hw))) {
          out.push(`${show(r.raw)} stops short: it needs the command to start with ${show(hw)}, this one starts with ${show(sample(text, hw.split(" ").length))}`);
        } else if (hw && spaced && /^\S/.test(flat.slice(hw.length))) {
          out.push(`${show(r.raw)} needs a space after ${show(hw)}, and this command has more letters straight after it`);
        } else if (t) {
          out.push(`${show(r.raw)} needs the command to end with ${show(t.trim())}`);
        }
      }
    }
  }
  return [...new Set(out)].slice(0, 3);
}
