// A permission rule is a string: "Tool" or "Tool(content)". This module reads one, says whether Claude
// Code accepts it, and names the warnings Claude Code prints at startup for the ones it accepts but
// that do not do what they look like. Every message here was checked against Claude Code 2.1.295
// (`claude doctor` lists the rules it skips, the debug log the startup warnings);
// test/oracle.test.mjs repeats that check when a binary is available.

/** Evaluation order: the first kind with a matching rule decides. */
export const KINDS = ["deny", "ask", "allow"];

export const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);

// Tool names Claude Code knows. A deny or ask rule naming anything else (and without "_" or "*" in it)
// draws a "matches no known tool" warning at startup. Claude Code builds its list from the tools of
// the session, so this one is a snapshot: a name missing here is reported as a possible typo, never
// as an error.
export const KNOWN_TOOLS = new Set([
  "Agent", "AskUserQuestion", "Artifact", "Bash", "BashOutput", "Cd", "CronCreate", "CronDelete", "CronList", "Edit",
  "EnterPlanMode", "EnterWorktree", "ExitPlanMode", "ExitWorktree", "Glob", "Grep", "KillShell", "LSP", "ListAgents",
  "Monitor", "NotebookEdit", "PowerShell", "Read", "ReportFindings", "ScheduleWakeup", "SendMessage",
  "ShareOnboardingGuide", "Skill", "SlashCommand", "Task", "TaskCreate", "TaskGet", "TaskList", "TaskOutput", "TaskStop",
  "TaskUpdate", "TodoWrite", "ToolSearch", "WebFetch", "WebSearch", "Workflow", "Write",
]);

// For each tool, the input field that a "Tool(field:value)" rule would be pointing at. Claude Code
// ignores such a deny or ask rule (the field is the tool's own content) and says so at startup.
const RAW_FIELDS = {
  Bash: "command", PowerShell: "command", Read: "file_path", Edit: "file_path", Write: "file_path",
  Grep: "path", Glob: "path", NotebookEdit: "notebook_path", WebFetch: "url",
};

function escapedAt(s, i) {
  let n = 0;
  for (let j = i - 1; j >= 0 && s[j] === "\\"; j--) n++;
  return n % 2 === 1;
}

/** Does `s` hold a "*" that is not escaped with a backslash? */
export function hasStar(s) {
  for (let i = 0; i < s.length; i++) if (s[i] === "*" && !escapedAt(s, i)) return true;
  return false;
}

function countUnescaped(s, ch) {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s[i] === ch && !escapedAt(s, i)) n++;
  return n;
}

/** "mcp__server__tool" -> { server, tool }; null when it is not an MCP name. */
export function parseMcp(name) {
  if (!name.startsWith("mcp__")) return null;
  const rest = name.slice(5);
  const i = rest.indexOf("__");
  if (i === -1) return { server: rest, tool: null };
  return { server: rest.slice(0, i), tool: rest.slice(i + 2) };
}

/**
 * Split a rule string. Returns { raw, tool, content, shape } where shape is "name" (no
 * parentheses), "call" (Tool(content)) or "malformed".
 */
export function splitRule(raw) {
  const s = String(raw);
  const open = s.indexOf("(");
  if (open === -1) return { raw: s, tool: s.trim(), content: undefined, shape: s.includes(")") ? "malformed" : "name" };
  if (!s.endsWith(")")) return { raw: s, tool: s.slice(0, open).trim(), content: undefined, shape: "malformed" };
  return { raw: s, tool: s.slice(0, open).trim(), content: s.slice(open + 1, -1), shape: "call" };
}

/**
 * Check one rule the way Claude Code does when it loads settings.
 *   raw       the rule as written (anything that is not a string is a problem)
 *   behavior  "allow", "ask" or "deny": some checks apply to one of them only
 * Returns { rule, problem, warnings }:
 *   problem   null, or { code, message, fix }: Claude Code skips the rule (`claude doctor` lists it)
 *   warnings  [{ code, message, fix, silent }]: the rule is kept but does not do what it looks like.
 *             silent is true when Claude Code itself prints nothing at startup for it.
 */
export function checkRule(raw, behavior) {
  const out = { rule: splitRule(raw), problem: null, warnings: [] };
  const r = out.rule;
  const bad = (code, message, fix) => { out.problem = { code, message, fix }; return out; };
  const warn = (code, message, fix, silent = false) => out.warnings.push({ code, message, fix, silent });

  if (typeof raw !== "string") {
    out.rule = { raw: String(raw), tool: "", content: undefined, shape: "malformed" };
    return bad("not-a-string", `${raw === null ? "null" : typeof raw} where a rule string belongs`, "Remove it, or write it as a string.");
  }
  if (raw.trim() === "") return bad("empty", "an empty rule", "Remove it.");
  if (r.shape === "malformed") return bad("malformed", "the parentheses do not end the rule", 'A rule is Tool or Tool(content) and ends at the closing ")".');
  if (r.shape === "call" && r.content === "") {
    if (!r.tool) return bad("no-tool-name", "empty parentheses with no tool name", "Name the tool before the parentheses.");
    return bad("empty-parentheses", `${r.tool}() has nothing inside the parentheses`, `Write ${r.tool} to match every use, or ${r.tool}(something).`);
  }
  const mcp = parseMcp(r.tool);
  if (mcp) {
    if (r.shape === "call") return bad("mcp-parentheses", "an MCP rule cannot have a pattern in parentheses", `Use ${r.tool} without parentheses, or mcp__${mcp.server}__* for every tool of the server.`);
    if (behavior === "allow" && hasStar(r.tool) && (hasStar(`mcp__${mcp.server}`) || mcp.tool === null)) {
      return bad("allow-glob", `the wildcard tool name ${r.tool} is not allowed in an allow rule`, "Allow rules accept a glob only after a literal mcp__server__ prefix: mcp__server__* is fine, mcp__* is not.");
    }
    return out;
  }
  // "(x)" with text in the parentheses but no tool name is accepted without a word and matches no tool
  if (behavior === "allow" && hasStar(r.tool)) {
    return bad("allow-glob", `the wildcard tool name ${r.tool} is not allowed in an allow rule`, "Allow rules accept a glob only after a literal mcp__server__ prefix; deny and ask rules accept globs anywhere.");
  }
  if (r.tool && !r.tool.includes("_") && r.tool[0] !== r.tool[0].toUpperCase()) {
    return bad("lowercase", `the tool name ${r.tool} starts with a lowercase letter`, `Use ${r.tool[0].toUpperCase()}${r.tool.slice(1)}.`);
  }
  const content = r.content;
  if (r.shape === "call" && /(?:^|[^\\])\\[()]/.test(content) && countUnescaped(content, "(") !== countUnescaped(content, ")")) {
    return bad("ambiguous-parenthesis", "a backslash beside an unescaped parenthesis is ambiguous", "Write a Windows path with forward slashes, or spell a literal parenthesis as [(] or [)].");
  }
  if (r.tool === "WebFetch" && content !== undefined && !/^\s*domain\s*:/.test(content)) {
    return bad("webfetch-domain", "WebFetch rules must start with domain:", "Write WebFetch(domain:example.com).");
  }
  if (r.tool === "Bash" && content === ":*") {
    return bad("empty-prefix", "a :* rule with no command before it", "Write the command before :*, as in Bash(npm:*).");
  }
  if ((r.tool === "Read" || r.tool === "Edit" || r.tool === "Write" || r.tool === "Glob" || r.tool === "Grep" || r.tool === "NotebookEdit") && content !== undefined && content.includes(":*")) {
    return bad("colon-star-file", "the :* syntax is only for Bash and PowerShell rules", "Use glob patterns such as * or ** for files.");
  }

  // Warnings. Claude Code looks at deny and ask rules for the tool name and the raw field first.
  if (behavior !== "allow") {
    const known = KNOWN_TOOLS.has(r.tool) || r.tool.includes("_") || r.tool.includes("*");
    if (!known) warn("unknown-tool", r.tool ? `${raw} names ${r.tool}, which is not a tool this tool knows` : `${raw} has no tool name before the parentheses, so it matches no tool`, "Check the spelling against the tools reference.");
    else if (content !== undefined && RAW_FIELDS[r.tool]) {
      const k = content.indexOf(":");
      if (k > 0 && content.slice(0, k).trim() === RAW_FIELDS[r.tool]) {
        warn("raw-field", `${raw} points at the ${RAW_FIELDS[r.tool]} field as a raw string, so Claude Code ignores it`, `Write ${r.tool}(...) with the pattern itself.`);
      }
    }
  } else if (SHELL_TOOLS.has(r.tool) && content !== undefined && content.split(":")[0].trim() === "command") {
    warn("raw-field-allow", `${raw} can never match: no command starts with "command:"`, `Write ${r.tool}(...) with the command pattern itself.`, true);
  }

  // The rest are skipped by Claude Code for contents that read like field:value (git:* push).
  const k = content === undefined ? -1 : content.indexOf(":");
  const fieldLike = k > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(content.slice(0, k).trim()) && !/^[A-Za-z]:[\\/]/.test(content.trim());
  if (SHELL_TOOLS.has(r.tool) && content !== undefined) {
    if (behavior === "allow") {
      const program = wildcardBeforeSubcommand(content);
      if (program) {
        warn("wildcard-before-subcommand", `${raw} has a * before the rest of the command, so it also matches any options inserted at that position and approves them without a prompt${program === "git" ? "; git options such as -c and --exec-path can run arbitrary commands" : ""}`, "Replace that * with the exact value you mean, or put the * after the subcommand.", fieldLike);
      }
    }
    const prefix = content.match(/^(.+):\*$/);
    if (prefix) {
      if (hasStar(prefix[1].trimEnd())) warn("star-with-prefix", `${raw} mixes * with the trailing :* prefix syntax, so the * is taken literally and the rule will likely never match`, "Use either Bash(prefix:*) or Bash(prefix *), not both.", fieldLike);
    } else if (content.includes(":*") && content !== ":*") {
      warn("colon-star-not-at-end", `${raw} has a :* that is not at the end, so it is a * wildcard with a literal colon, not the :* prefix syntax`, "Put the :* at the end, or write the wildcard with a space: Bash(git * push).", fieldLike);
    }
  }
  if (r.tool === "PowerShell" && content === ":*") {
    warn("empty-prefix", `${raw} is accepted, but with no command before the :* it matches nothing`, "Write the command before :*, as in PowerShell(npm:*).", true);
  }
  if (content !== undefined) {
    const to = r.tool === "Write" || r.tool === "NotebookEdit" || r.tool === "MultiEdit" ? "Edit" : r.tool === "Glob" ? "Read" : null;
    if (to) warn("file-rule-not-consulted", `${raw} is not matched by file permission checks: only ${to}(path) rules are`, `Use ${to}(${content}); ${to} rules cover all file-${to === "Edit" ? "editing" : "reading"} tools.`, fieldLike);
    if (hasBackslashPath(r.tool, content)) {
      warn("backslash-in-path", `${raw} has a backslash, and Claude Code does not read that as a folder separator (a rule written as sub\\a.txt did not match sub/a.txt when it was tried)`, "Write the path with forward slashes: Read(sub/a.txt). A Windows drive path such as C:\\Users\\me\\x is the exception and works.", true);
    }
  }
  return out;
}

/** A Read or Edit path with a backslash that is not part of a drive path (those work). */
export function hasBackslashPath(tool, content) {
  return (tool === "Read" || tool === "Edit") && typeof content === "string" && content.includes("\\") && !/^\s*[A-Za-z]:[\\/]/.test(content);
}

/**
 * The allow-rule shape Claude Code warns about: after the program name, a "*" stands where the
 * subcommand would be, as in "git * main". Returns the program name, or null.
 */
export function wildcardBeforeSubcommand(content) {
  if (content.endsWith(":*")) return null;
  const tokens = content.trim().split(/\s+/).filter(Boolean);
  const program = tokens[0];
  if (tokens.length < 3 || program === undefined || hasStar(program)) return null;
  let seenStar = false;
  for (const t of tokens.slice(1)) {
    if (/^(?:[|&;<>]|\d+[<>])/.test(t)) return null; // a shell operator ends the command
    if (hasStar(t)) { seenStar = true; continue; }
    if (t.startsWith("-")) continue;
    return seenStar ? program : null; // the first plain word: was there a * before it?
  }
  return null;
}

/** Rebuild the string of a rule. */
export function ruleString(tool, content) {
  return content === undefined ? tool : `${tool}(${content})`;
}
