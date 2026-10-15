// Which rules make other rules pointless? A deny rule beats an ask rule beats an allow rule whatever
// file they are in, so an allow rule that a deny or ask rule covers completely never does anything,
// and an ask rule under a deny rule never gets to ask. "Covers" is decided on the rule patterns
// (src/pattern.mjs); for tools other than Bash and PowerShell only an identical rule, or the bare tool
// name, counts, because comparing two path globs is not worth guessing at.
import { covers, parseContent } from "./pattern.mjs";
import { canonicalText } from "./psknow.mjs";
import { SHELL_TOOLS } from "./rule.mjs";

const RANK = { deny: 0, ask: 1, allow: 2 };

const parsedFor = (r) => {
  if (!r.parsed) return null;
  if (r.tool !== "PowerShell") return r.parsed;
  if (!r.psParsed) r.psParsed = parseContent(canonicalText(r.content));
  return r.psParsed;
};

/**
 * Does rule `outer` (a deny or ask rule) cover rule `inner` completely, so that `inner` can never
 * decide anything? Returns true or false.
 */
export function overrides(outer, inner) {
  if (outer === inner || outer.problem || inner.problem || outer.ignored || inner.ignored) return false;
  if (RANK[outer.behavior] >= RANK[inner.behavior]) return false;
  if (outer.tool !== inner.tool) return false;
  if (outer.bare) return true; // Bash, Bash(*), Read ...: the whole tool
  if (inner.bare) return false;
  if (SHELL_TOOLS.has(outer.tool)) {
    const a = parsedFor(outer);
    const b = parsedFor(inner);
    return !!a && !!b && covers(a, b, { ignoreCase: outer.tool === "PowerShell" });
  }
  return outer.content === inner.content;
}

/** The rule that overrides this one, or null. A deny rule is reported before an ask rule. */
export function overriddenBy(rule, rules) {
  let found = null;
  for (const other of rules) {
    if (!overrides(other, rule)) continue;
    if (!found || RANK[other.behavior] < RANK[found.behavior]) found = other;
  }
  return found;
}

/**
 * The key two rules share when they mean the same thing: the same tool, the same behavior and, for
 * Bash and PowerShell, the same content once `ls:*` is read as `ls *` and runs of spaces are one space.
 */
export function ruleKey(rule) {
  let content = rule.content === undefined ? "" : rule.content;
  if (SHELL_TOOLS.has(rule.tool) && rule.parsed) {
    if (rule.parsed.type === "prefix") content = `${rule.parsed.prefix.trim().replace(/[ \t]+/g, " ")} *`;
    else if (rule.parsed.type === "wildcard") content = content.trim().replace(/[ \t]+/g, " ");
    if (rule.tool === "PowerShell") content = canonicalText(content);
  }
  if (rule.bare) content = "";
  return `${rule.behavior}\u0000${rule.tool}\u0000${content}`;
}
