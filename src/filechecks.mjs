// The file side of a shell command: Read and Edit rules that reach the files a command names, the
// output and input redirections, and the one place where a shell -c script is looked into. Claude Code
// checks these whatever the Bash allow rules say (the docs: "Read and Edit deny rules apply ... to
// file commands Claude Code recognizes in Bash, such as cat, head, tail, sed and tee, and to the
// targets of Bash redirections").
import { fileArguments } from "./readonly.mjs";
import { matches } from "./pattern.mjs";
import { pathRuleMatches } from "./pathrules.mjs";
import { parseBash } from "./shell.mjs";
import { activeRules } from "./settings.mjs";
import { insideAny, resolveArg, unsafePath } from "./paths.mjs";
import { candidates, strippedWords } from "./wrappers.mjs";

export const OUTPUT_OPS = new Set([">", ">>", ">|", "&>", "&>>", "<>"]);
// Targets with no file behind them: Claude Code does not check these.
export const NO_FILE = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty", "-"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const FD_TARGET = /^(\d+|-)$/;

/**
 * Which path rule (if any) decides for this file? { behavior, rule, bare } for the first match in
 * deny, ask, allow order. A bare Read or Edit rule is flagged bare: it governs the tool, not a path.
 */
export function fileDecision(tool, abs, settings, ctx) {
  const all = activeRules(settings);
  for (const behavior of ["deny", "ask", "allow"]) {
    for (const r of all[behavior]) {
      if (r.tool !== tool) continue;
      if (r.content === undefined) { if (behavior !== "allow") return { behavior, rule: r, bare: true }; continue; }
      if (pathRuleMatches(r.content, abs, { behavior, scope: r.scope, cwd: ctx.cwd, home: ctx.home, configDir: settings.configDir })) return { behavior, rule: r };
    }
  }
  return null;
}

/** Does a Read allow rule with a path cover the folder behind this out-of-bounds argument? */
export function readAllowed(arg, settings, ctx) {
  const abs = resolveArg(arg, ctx.cwd, ctx.home);
  if (!abs) return false;
  const dec = fileDecision("Read", abs, settings, ctx);
  return !!dec && dec.behavior === "allow" && !dec.bare;
}

const isDup = (r, target) => (r.op === ">&" || r.op === "<&") && FD_TARGET.test(target);

/**
 * Read deny rules apply to the files that cat, head, grep, sed ... name, and Edit deny rules to the
 * files that tee, cp, mv, touch, mkdir, rm and sed -i write, and to > and < redirection targets.
 * Returns { rule, text } for the first denied file, or null.
 */
export function fileDeny(cmd, settings, ctx) {
  for (const r of cmd.redirs || []) {
    if (r.heredoc || r.op === "<<<" || !r.target) continue;
    const value = r.target.value;
    if (NO_FILE.has(value) || r.target.dynamic || isDup(r, value)) continue;
    if (unsafePath(value)) return null; // a path Claude Code asks about: the prompt comes first
    const tool = OUTPUT_OPS.has(r.op) || r.op === ">&" ? "Edit" : r.op === "<" ? "Read" : null;
    const abs = tool ? resolveArg(value, ctx.cwd, ctx.home) : null;
    if (!abs) continue;
    const dec = fileDecision(tool, abs, settings, ctx);
    if (dec && dec.behavior === "deny") return { rule: dec.rule, text: `${tool === "Edit" ? "writes" : "reads"} ${value}, which ${dec.rule.raw} denies` };
  }
  const words = strippedWords(cmd, "path");
  if (!words.length) return null;
  const files = fileArguments(words);
  for (const [tool, list] of [["Read", files.reads], ["Edit", files.writes]]) {
    for (const a of list) {
      if (unsafePath(a)) return null; // a path Claude Code asks about: the prompt comes first
      const abs = resolveArg(a, ctx.cwd, ctx.home);
      if (!abs) continue;
      const dec = fileDecision(tool, abs, settings, ctx);
      if (dec && dec.behavior === "deny") return { rule: dec.rule, text: `${words[0]} ${tool === "Edit" ? "writes" : "reads"} ${a}, which ${dec.rule.raw} denies` };
    }
  }
  return null;
}

/**
 * A shell -c script: Claude Code does not apply deny rules inside it, with one exception found in
 * testing: when a deny rule matches an rm or rmdir in the script it asks instead of running.
 * Returns { rule, text } or null.
 */
export function denyInsideScript(cmd, denyRules, ruleParsed) {
  const words = cmd.argv.map((w) => w.value);
  const base = (words[0] || "").replace(/^.*[\\/]/, "");
  if (!SHELLS.has(base)) return null;
  const k = words.findIndex((w, i) => i > 0 && /^-[A-Za-z]*c[A-Za-z]*$/.test(w));
  if (k === -1 || words[k + 1] === undefined) return null;
  for (const inner of parseBash(words[k + 1]).cmds) {
    const prog = strippedWords(inner, "deny")[0];
    if (prog !== "rm" && prog !== "rmdir") continue;
    for (const r of denyRules) {
      if (r.bare || !ruleParsed(r)) continue;
      for (const t of candidates(inner, "deny")) {
        if (matches(ruleParsed(r), t.text)) return { rule: r, text: `${r.raw} matches ${prog} inside this ${base} -c script; Claude Code cannot check what the script does, so it asks` };
      }
    }
  }
  return null;
}

/** The first file a command redirects its output to ("out") or reads through "<" ("in"), or null. */
export function fileRedirects(cmd, direction) {
  for (const r of cmd.redirs || []) {
    if (r.heredoc || r.op === "<<<" || !r.target) continue;
    const target = r.target.value;
    if (NO_FILE.has(target) || isDup(r, target)) continue;
    if (direction === "out" && (OUTPUT_OPS.has(r.op) || r.op === ">&")) return target;
    if (direction === "in" && r.op === "<") return target;
  }
  return null;
}

/**
 * Redirections that need approval: { behavior, target, rule, text } for the first one, or null.
 * Output needs an Edit allow rule with a path for the file (or no file behind it), input a Read rule
 * when the file is outside the working folders. A target that is a variable or a glob can only be
 * approved by hand.
 */
export function redirectDecision(cmd, settings, ctx) {
  for (const r of cmd.redirs || []) {
    if (r.heredoc || r.op === "<<<" || !r.target) continue;
    const target = r.target.value;
    const isOut = OUTPUT_OPS.has(r.op) || (r.op === ">&" && !FD_TARGET.test(target));
    const isIn = r.op === "<";
    if ((!isOut && !isIn) || NO_FILE.has(target)) continue;
    const reason = unsafePath(target);
    if (reason) return { behavior: "ask", target, unsafe: true, text: `${isOut ? "its output goes to" : "it reads"} ${target}, which ${reason}` };
    const dynamic = r.target.dynamic || /[*?[\]]/.test(target) || (target.startsWith("~") && !/^~([\\/]|$)/.test(target));
    const abs = dynamic ? null : resolveArg(target, ctx.cwd, ctx.home);
    if (!abs) return { behavior: "unknown", target, text: `${isOut ? "its output goes to" : "it reads"} ${target}, which cannot be known before it runs` };
    if (isOut) {
      const dec = fileDecision("Edit", abs, settings, ctx);
      if (dec && !dec.bare && dec.behavior === "allow") continue;
      return { behavior: "ask", target, rule: dec ? dec.rule : null, text: `its output goes to ${target}, and writing a file needs an Edit rule for it (or your approval)` };
    }
    if (insideAny(abs, ctx.dirs)) continue;
    const dec = fileDecision("Read", abs, settings, ctx);
    if (dec && !dec.bare && dec.behavior === "allow") continue;
    return { behavior: "ask", target, text: `it reads ${target}, outside the folders Claude may work in` };
  }
  return null;
}
