// What Claude Code does with a shell command in default (Manual) mode, given the rules in the
// settings files: it runs, it prompts, or it is refused. The order, from the docs and checked against
// Claude Code 2.1.295 (see "What was verified" in the README):
//
//   1. deny rules, then ask rules, against every command in the line (also inside $( ), a subshell, an
//      if or for body), looking through more wrappers than an allow rule does;
//   2. Read and Edit deny rules against the files the commands name, in a line Claude Code can read;
//   3. a bare Bash allow, or an allow rule that spells out the whole line;
//   4. a line Claude Code cannot parse or check (a command substitution, a variable ...) prompts;
//   5. otherwise every command needs an allow rule or must be read-only, and the folders it names,
//      paths with a .. after a directory name or a // inside, redirections and cd are checked on top,
//      whatever the rules say (a bare Bash allow rule skips them all).
import { parseBash } from "./shell.mjs";
import { parsePowerShell } from "./powershell.mjs";
import { matches, parseContent } from "./pattern.mjs";
import { candidates, innerProgram, strippedWords } from "./wrappers.mjs";
import { readOnly } from "./readonly.mjs";
import { canonicalText, readOnlyPs } from "./psknow.mjs";
import { explainMisses } from "./explain.mjs";
import { inlineCode, operation, ruleFor } from "./propose.mjs";
import { activeRules } from "./settings.mjs";
import { hasDoubleSlash } from "./paths.mjs";
import { denyInsideScript, fileDeny, fileRedirects, readAllowed, redirectDecision } from "./filechecks.mjs";

export { fileDecision } from "./filechecks.mjs";

/**
 * Decide a Bash or PowerShell command.
 *   tool     "Bash" or "PowerShell"
 *   command  the command line
 *   settings the result of loadSettings()
 *   cwd, home   the folder Claude starts in and the home folder
 * Returns { verdict, kind, summary, rule, fix, parts, issues, problem, separators, notes }:
 *   verdict  "allow" (runs without a prompt), "ask" (prompts) or "deny" (refused)
 *   kind     why: deny-rule, ask-rule, tool-denied, allow-rule, read-only, unparseable, cannot-check,
 *            no-rule, path (a folder or redirection), cd
 *   parts    one entry per simple command, each with the status it would have on its own
 */
export function decideShell({ tool, command, settings, cwd, home, platform = process.platform }) {
  const ps = tool === "PowerShell";
  const text = String(command).trim();
  const parsed = ps ? parsePowerShell(command, { unc: platform === "win32" }) : parseBash(command);
  const rules = activeRules(settings, { tool });
  const ctx = { cwd, home, platform, dirs: [cwd, ...settings.additionalDirectories] };

  // --- matching helpers -------------------------------------------------------------------------
  const ruleParsed = (r) => {
    if (!ps) return r.parsed;
    if (!r.psParsed && r.content !== undefined) r.psParsed = parseContent(canonicalText(r.content));
    return r.psParsed;
  };
  const hitsText = (r, t) => {
    const p = ruleParsed(r);
    return !!p && matches(p, ps ? canonicalText(t) : t, { ignoreCase: ps });
  };
  const textsFor = (cmd, behavior) => (ps ? psTexts(cmd, behavior) : candidates(cmd, behavior));
  const firstHit = (list, cmd, behavior) => {
    const texts = textsFor(cmd, behavior);
    for (const r of list) {
      if (r.bare || !ruleParsed(r)) continue;
      for (const t of texts) if (hitsText(r, t.text)) return { rule: r, via: t };
    }
    return null;
  };

  // --- the parts: every simple command, or the line itself when the reader found none -------------
  const cmds = parsed.cmds.filter((c) => c.argv.length || c.assigns.length || c.redirs.length);
  const subjects = cmds.length ? cmds : [{ text, argv: [], assigns: [], redirs: [], cut: [], ctx: [], src: text, start: 0, end: text.length }];
  const d = {
    tool, command, text, verdict: null, kind: null, rule: null, summary: "", fix: null,
    parts: subjects.map((cmd) => ({ cmd, text: cmd.text || text, ctx: cmd.ctx || [], status: null, rule: null, via: null, detail: "", misses: [] })),
    issues: parsed.issues.slice(), problem: parsed.ok ? null : parsed.problem, separators: parsed.seps,
    notes: parsed.chain ? ["&& and || split a PowerShell command only in PowerShell 7 and newer, as the docs say; Windows PowerShell 5.1 cannot parse them, and the command then prompts"] : [],
  };
  const hasFor = d.parts.some((p) => p.ctx.includes("for")); // a for loop takes the read-only shortcut away from the whole line
  // a file outside the working folders that a Read allow rule covers is as good as one inside
  const withRead = (c) => ({ ...c, allowed: (a) => readAllowed(a, settings, c) });

  /** How one command stands on its own: covered by an allow rule, read-only, or neither. */
  const coverage = (cmd, here, exact) => {
    if (cmd.inert) return { status: "inert", detail: "the cat that feeds a quoted heredoc is not judged" };
    if (!cmd.argv.length && !cmd.redirs.length) return { status: "assign", detail: "only sets a variable" };
    const inner = innerWords(cmd, ps);
    let ro = inner.ok && cmd.argv.length ? (ps ? readOnlyPs(inner.words, { ...ctx, cwd: here }) : readOnly(inner.words, withRead({ ...ctx, cwd: here }))) : { ok: false, why: inner.why || "" };
    // a // in the text could be a network path: the command is no longer one that is known to only read
    if (!ps && platform === "win32" && ro.ok && hasDoubleSlash(cmd.text)) ro = { ok: false, why: "a // inside the command could be a network path, so it does not count as read-only" };
    // [ and jq are read-only, but not with a variable in front (observed)
    if (!ps && ro.ok && cmd.assigns.length && (inner.words[0] === "[" || inner.words[0] === "jq")) ro = { ok: false, why: `${inner.words[0]} with a variable in front is not one Claude Code runs without asking` };
    const hit = exact ? { rule: exact.rule, via: exact.via } : firstHit(rules.allow, cmd, "allow");
    const prog = inner.ok ? inner.words[0] : "";
    if (hit) return { status: "allow", rule: hit.rule, via: hit.via, ro, prog };
    if (!(cmd.needsRule || hasFor) && ro.ok) return { status: "read-only", detail: ro.why, ro, prog };
    const why = cmd.needsRule ? "a command inside an assignment is judged by rules only" : hasFor ? "inside a for loop only an allow rule counts, never the read-only shortcut" : ro.why || "";
    return { status: "no-rule", detail: why, ro, prog };
  };

  const finish = (verdict, kind, rule, summary) => {
    for (const part of d.parts) {
      if (part.status) continue; // show what each command would be on its own, whatever decided the verdict
      const c = coverage(part.cmd, cwd, null);
      part.status = c.status;
      part.rule = c.rule || null;
      part.via = c.via || null;
      part.detail = c.detail || "";
    }
    Object.assign(d, { verdict, kind, rule, summary });
    if (!d.fix) d.fix = defaultFix(d);
    return d;
  };

  // 0. a bare tool rule governs every call
  const bareDeny = rules.deny.find((r) => r.bare);
  if (bareDeny) return finish("deny", "tool-denied", bareDeny, `${bareDeny.raw} removes the ${tool} tool from Claude, so it cannot run any command`);

  // 1. deny rules, then ask rules, against every part (an exact rule can also name the whole line)
  for (const part of d.parts) {
    const hit = firstHit(rules.deny, part.cmd, "deny") || exactWhole(rules.deny, text, ruleParsed);
    if (hit) { part.status = "deny"; part.rule = hit.rule; part.via = hit.via; }
  }
  const denied = d.parts.find((p) => p.status === "deny");
  if (denied) return finish("deny", "deny-rule", denied.rule, `${denied.rule.raw} (${denied.rule.label}) matches ${denied.text}`);
  for (const part of d.parts) {
    const hit = firstHit(rules.ask, part.cmd, "ask") || exactWhole(rules.ask, text, ruleParsed);
    if (hit) { part.status = "ask"; part.rule = hit.rule; part.via = hit.via; continue; }
    const inScript = ps ? null : denyInsideScript(part.cmd, rules.deny, ruleParsed);
    if (inScript) { part.status = "ask"; part.rule = inScript.rule; part.detail = inScript.text; }
  }
  const asked = d.parts.find((p) => p.status === "ask");
  if (asked) return finish("ask", "ask-rule", asked.rule, asked.detail ? `${asked.rule.raw} (${asked.rule.label}): ${asked.detail}` : `${asked.rule.raw} (${asked.rule.label}) matches ${asked.text}`);
  const bareAsk = rules.ask.find((r) => r.bare);
  if (bareAsk) return finish("ask", "ask-rule", bareAsk, `${bareAsk.raw} makes every ${tool} command prompt`);

  // 2. Read and Edit deny rules reach the files that file commands name, in a line Claude Code can read through
  if (!ps && parsed.ok && !d.issues.length) {
    for (const part of d.parts) {
      const f = fileDeny(part.cmd, settings, ctx);
      if (f) { part.status = "deny"; part.rule = f.rule; part.detail = f.text; }
    }
    const f = d.parts.find((p) => p.status === "deny");
    if (f) return finish("deny", "deny-rule", f.rule, `${f.rule.raw} (${f.rule.label}): ${f.detail}`);
  }

  // 3./4. a bare allow, or an exact rule for the whole line, skips the analysis; otherwise a line Claude Code cannot check prompts
  const background = d.issues.find((i) => i.kind === "background");
  const bareAllow = rules.allow.find((r) => r.bare);
  const exact = exactWhole(rules.allow, text, ruleParsed);
  if (!exact && !bareAllow) {
    if (!parsed.ok) return finish("ask", "unparseable", null, `Claude Code cannot parse the command line: ${parsed.problem}`);
    if (d.issues.length) return finish("ask", "cannot-check", null, d.issues.map((i) => i.text).join("; "));
  }
  if (bareAllow && !background) {
    for (const part of d.parts) { part.status = "allow"; part.rule = bareAllow; }
    return finish("allow", "allow-rule", bareAllow, `${bareAllow.raw} allows every ${tool} command`);
  }

  // 5. every command needs a rule or must be read-only; folders, redirections and cd are checked either way
  const state = { here: cwd, moved: false, cds: 0, outSeen: false, inSeen: false, git: null };
  const problems = [];
  let covered = false;
  for (const part of d.parts) {
    const cmd = part.cmd;
    const c = coverage(cmd, state.here, exact);
    part.status = c.status;
    part.rule = c.rule || null;
    part.via = c.via || null;
    part.detail = c.detail || "";
    if (c.status === "inert" || c.status === "assign") continue;
    if (c.status === "allow" || c.status === "read-only") covered = true;
    const block = (kind, detail, extra = {}) => {
      Object.assign(part, { status: "no-rule", detail, blockKind: kind }, extra);
      problems.push(part);
    };
    const here = { ...ctx, cwd: state.here };

    // folders: Claude Code checks these commands' arguments whatever the Bash rules say, also behind timeout and the like
    const wide = !ps && cmd.argv.length ? readOnly(strippedWords(cmd, "path"), withRead(here)) : c.ro;
    const unsafe = c.ro.unsafe !== undefined ? c.ro.unsafe : wide.unsafe;
    if (unsafe !== undefined) { block("path", c.ro.unsafe !== undefined ? c.ro.why : wide.why, { unsafePath: unsafe }); continue; }
    const outside = c.ro.outside || wide.outside;
    if (outside && !readAllowed(outside, settings, here)) { block("path", c.ro.outside ? c.ro.why : wide.why, { outside }); continue; }
    // redirections
    const red = redirectDecision(cmd, settings, here);
    if (red) { block("path", red.text, { redirect: red }); continue; }
    // cd and redirections: after a cd into another folder a relative target is ambiguous
    const out = fileRedirects(cmd, "out");
    const inn = fileRedirects(cmd, "in");
    if (!ps && out && state.moved) { block("cd", "it writes through a redirection after a cd into another folder, so the path is ambiguous"); continue; }
    if (!ps && inn && state.moved) { block("cd", `it reads ${inn} after a cd into another folder, so the file it names depends on the directory change`); continue; }
    if (out) state.outSeen = true;
    if (inn) state.inSeen = true;
    if (!ps && c.prog === "cd") {
      state.cds++;
      if (state.cds > 1) { block("cd", "several directory changes in one command prompt"); continue; }
      if (inn) { block("cd", `a cd with an input redirection (< ${inn}) prompts: the file it names depends on the directory change`); continue; }
      if (c.ro.cd) { if (c.ro.cd !== state.here) state.moved = true; state.here = c.ro.cd; }
      if (cmd.assigns.length) state.moved = true; // with a variable in front Claude Code no longer reads it as a plain cd, and treats it as a move
      if (state.outSeen) { block("cd", "a cd after a command that writes through a redirection leaves the path ambiguous"); continue; }
      if (state.moved && state.inSeen) { block("cd", "a cd into another folder in a command that reads a file through a redirection leaves the path ambiguous"); continue; }
    }
    if (!ps && c.prog === "git") state.git = state.git || part;
    if (!ps && c.prog === "git" && state.moved) { block("cd", "git after a cd into another folder prompts, because that folder's git hooks could run"); continue; }
    if (c.status === "no-rule") problems.push(part);
  }
  // git before the cd is no better: the line mixes git with a move into another folder
  if (state.moved && state.git && !problems.includes(state.git)) {
    Object.assign(state.git, { status: "no-rule", detail: "git in a line that moves into another folder with cd prompts, because that folder's git hooks could run", blockKind: "cd" });
    problems.push(state.git);
  }

  // the & operator prompts a line that a rule or the read-only list would otherwise have allowed
  if (background && covered && parsed.ok && problems.length === 0 && d.issues.every((i) => i.kind === "background")) {
    d.fix = { rule: null, why: "no rule fixes this: run the command without the & (a rule that spells out the whole line does not help either)" };
    return finish("ask", "cannot-check", null, background.text);
  }
  if (bareAllow) {
    for (const part of d.parts) { part.status = "allow"; part.rule = bareAllow; }
    return finish("allow", "allow-rule", bareAllow, `${bareAllow.raw} allows every ${tool} command`);
  }

  const first = problems[0];
  if (first) {
    // say what keeps the first few unresolved commands from matching, and which rule each one would need
    d.fixes = [];
    for (const p of [...new Set(problems)].slice(0, 4)) {
      explainPart(p, { tool, rules, ps, ruleParsed, hitsText, textsFor });
      const f = proposeFix(p, tool);
      if (f && f.rule && !d.fixes.some((x) => x.rule === f.rule)) d.fixes.push({ ...f, part: p.text });
    }
    d.fix = proposeFix(first, tool);
    const kind = first.blockKind || "no-rule";
    return finish("ask", kind, null, kind !== "no-rule" ? `${first.text}: ${first.detail}` : `no allow rule covers ${first.text}${first.detail ? ` (${first.detail})` : ""}`);
  }
  const used = d.parts.filter((p) => p.rule).map((p) => p.rule);
  return finish("allow", used.length ? "allow-rule" : "read-only", used[0] || null, used.length ? "every command is covered by an allow rule or is read-only" : "every command is read-only");
}

/** Does an exact rule spell out this whole line? */
function exactWhole(list, text, ruleParsed) {
  for (const r of list) {
    if (r.bare) continue;
    const p = ruleParsed(r);
    if (p && p.type === "exact" && p.command === text) return { rule: r, via: { text, stripped: [] } };
  }
  return null;
}

/** The texts a PowerShell rule is matched against: the text as written, and the words without quotes. */
function psTexts(cmd, behavior) {
  const out = [];
  const add = (t, stripped = []) => { const x = t.trim(); if (x && !out.some((o) => o.text === x)) out.push({ text: x, stripped }); };
  add(cmd.text);
  if (!cmd.call || behavior !== "allow") add(cmd.argv.map((w) => w.value).join(" "));
  if (cmd.call && behavior !== "allow") add(cmd.text.replace(/^&\s*/, ""), ["&"]);
  return out;
}

/** The words of the program a command runs, once the few things allow rules look through are off. */
function innerWords(cmd, ps) {
  if (ps) return { ok: true, words: cmd.argv.map((w) => w.value) };
  const inner = innerProgram(cmd);
  if (cmd.assigns.length && inner.index < cmd.assigns.length) {
    return { ok: false, why: `a leading ${cmd.assigns[inner.index].raw.split("=")[0]}= assignment stops the command from counting as read-only` };
  }
  if (!inner.words.length) return { ok: false, why: "nothing to run" };
  return { ok: true, words: inner.words };
}

function explainPart(part, { tool, rules, ps, ruleParsed, hitsText, textsFor }) {
  if (!part.cmd.argv.length || part.outside || part.redirect) return;
  part.misses = explainMisses({
    tool,
    allowRules: rules.allow.filter((r) => !r.bare && ruleParsed(r)).map((r) => ({ ...r, parsed: ruleParsed(r) })),
    texts: textsFor(part.cmd, "allow"),
    deepTexts: textsFor(part.cmd, "deny"),
    matchesRule: (r, t) => hitsText(r, t),
    ignoreCase: ps,
  });
}

/** The one rule that would stop this prompt. */
function proposeFix(part, tool) {
  const words = part.cmd.argv.map((w) => w.value);
  if (part.unsafePath !== undefined || (part.redirect && part.redirect.unsafe)) {
    return { rule: null, why: "no rule fixes this: Claude Code asks about a path with a .. after a directory name or a // inside it; write the path another way" };
  }
  if (part.redirect) {
    if (part.redirect.behavior === "unknown") return { rule: null, why: "a redirection target that is a variable or a glob can only be approved by hand" };
    return { rule: `Edit(${part.redirect.target})`, why: "Claude Code checks a redirection against Edit rules, not against the Bash rule" };
  }
  if (part.outside) return { rule: null, why: "add the folder with /add-dir or permissions.additionalDirectories, or allow reading it with a Read(//path/**) rule" };
  if (!words.length) return null;
  if (part.blockKind === "cd") return { rule: null, why: "no rule fixes this: run the command without the cd, or start Claude Code in that folder" };
  if (inlineCode(words)) return { rule: `${tool}(${part.text})`, why: "inline code can only be approved by a rule that spells out the whole command" };
  const inner = tool === "Bash" ? innerProgram(part.cmd).words : words;
  const op = operation(inner.length ? inner : words);
  if (!op) return null;
  return { rule: ruleFor(tool, op.key), why: `a prefix rule for ${op.key}`, risk: op.risk };
}

function defaultFix(d) {
  switch (d.kind) {
    case "deny-rule":
    case "ask-rule":
      return d.rule ? { rule: null, why: `${d.verdict === "deny" ? "remove or narrow" : "remove"} ${d.rule.raw} in ${d.rule.label}` } : null;
    case "tool-denied":
      return { rule: null, why: `remove ${d.rule.raw} from ${d.rule.label}` };
    case "cannot-check":
      if (d.issues.length && d.issues.every((i) => i.kind === "background")) return { rule: null, why: "no rule fixes this: run the command without the & (a rule that spells out the whole line does not help either)" };
      return { rule: `${d.tool}(${d.text})`, why: "only a rule that spells out the whole command line can approve it; or split it into plain commands that each have a rule" };
    case "unparseable":
      return { rule: `${d.tool}(${d.text})`, why: "only a rule that spells out the whole command line can approve it; or split it into plain commands that each have a rule" };
    default:
      return null;
  }
}
