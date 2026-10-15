// The questions `why` answers for tools other than the shell: Read, Edit and Write on a file, WebFetch
// on a URL, and any other tool by name (an MCP tool, WebSearch ...). Same order as everywhere: deny,
// then ask, then allow, across all files; then what happens by default in default (Manual) mode.
import path from "node:path";
import { toPosix } from "./paths.mjs";
import { insideAny, resolveArg } from "./paths.mjs";
import { activeRules } from "./settings.mjs";
import { fileDecision } from "./filechecks.mjs";
import { hasStar, parseMcp } from "./rule.mjs";

/** Read, Edit or Write on one file. */
export function decideFile({ tool, file, settings, cwd, home }) {
  const abs = resolveArg(file, cwd, home) || path.resolve(cwd, file);
  const dirs = [cwd, ...settings.additionalDirectories];
  const ctx = { cwd, home };
  const d = { tool, target: abs, verdict: null, kind: null, rule: null, summary: "", notes: [], fix: null };
  const rulesTool = tool === "Read" ? "Read" : "Edit"; // Write and NotebookEdit follow the Edit rules
  const dec = fileDecision(rulesTool, abs, settings, ctx);
  const readDeny = tool !== "Read" ? fileDecision("Read", abs, settings, ctx) : null;

  // a bare Write rule is honored; a path rule for Write is never consulted
  const all = activeRules(settings);
  if (tool === "Write") {
    for (const b of ["deny", "ask", "allow"]) {
      const bare = all[b].find((r) => r.tool === "Write" && r.content === undefined);
      if (bare) {
        if (b === "deny") return done(d, "deny", "deny-rule", bare, `${bare.raw} (${bare.label}) denies every use of Write`);
        if (b === "ask") return done(d, "ask", "ask-rule", bare, `${bare.raw} (${bare.label}) asks before every use of Write`);
      }
    }
    const pathRules = [...all.deny, ...all.ask, ...all.allow].filter((r) => r.tool === "Write" && r.content !== undefined);
    if (pathRules.length) d.notes.push(`Write(path) rules are never consulted (${pathRules.map((r) => r.raw).join(", ")}): use Edit(path) rules, which cover Write as well`);
  }

  if (dec && dec.behavior === "deny") return done(d, "deny", "deny-rule", dec.rule, `${dec.rule.raw} (${dec.rule.label}) matches ${toPosix(abs)}`);
  if (readDeny && readDeny.behavior === "deny") return done(d, "deny", "deny-rule", readDeny.rule, `${readDeny.rule.raw} (${readDeny.rule.label}) matches ${toPosix(abs)}; a Read deny rule also blocks Edit and Write on the same file`);
  if (dec && dec.behavior === "ask") return done(d, "ask", "ask-rule", dec.rule, `${dec.rule.raw} (${dec.rule.label}) matches ${toPosix(abs)}`);
  if (dec && dec.behavior === "allow") return done(d, "allow", "allow-rule", dec.rule, `${dec.rule.raw} (${dec.rule.label}) matches ${toPosix(abs)}`);
  // a bare Read, Edit or Write allow rule allows every use of the tool (a bare Edit rule covers Write as well)
  const bareAllow = all.allow.find((r) => r.content === undefined && (r.tool === rulesTool || r.tool === tool));
  if (bareAllow) return done(d, "allow", "allow-rule", bareAllow, `${bareAllow.raw} (${bareAllow.label}) allows every use of ${bareAllow.tool}`);
  if (tool === "Read") {
    if (insideAny(abs, dirs)) return done(d, "allow", "inside", null, "a read inside the working folders needs no rule");
    d.fix = { rule: `Read(//${abs.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (m, l) => `${l.toLowerCase()}`).replace(/^\//, "")}/**)`.replace("///", "//"), why: "allows reading that folder, or add it with /add-dir or permissions.additionalDirectories" };
    return done(d, "ask", "no-rule", null, `${toPosix(abs)} is outside the working folders and no Read rule allows it`);
  }
  d.fix = { rule: `Edit(${insideAny(abs, dirs) ? relative(cwd, abs) : `//${abs.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (m, l) => l.toLowerCase()).replace(/^\//, "")}`})`, why: "allows editing that file; Claude Code asks before every edit in default mode" };
  return done(d, "ask", "no-rule", null, `default mode asks before ${tool === "Write" ? "writing" : "editing"} a file, and no Edit rule allows ${toPosix(abs)}`);
}

const relative = (cwd, abs) => path.relative(cwd, abs).split(path.sep).join("/");

/** WebFetch on one URL: rules are WebFetch(domain:host), matched on the host name. */
export function decideFetch({ url, settings }) {
  let host;
  try { host = new URL(url).hostname.toLowerCase().replace(/\.$/, ""); } catch { host = String(url).toLowerCase(); }
  const all = activeRules(settings, { tool: "WebFetch" });
  const d = { tool: "WebFetch", target: host, verdict: null, kind: null, rule: null, summary: "", notes: [], fix: null };
  for (const b of ["deny", "ask", "allow"]) {
    for (const r of all[b]) {
      if (r.content === undefined) {
        // a bare WebFetch rule: allow = no prompt, deny = the tool is gone, ask = always prompt
        return done(d, b, `${b}-rule`, r, `${r.raw} (${r.label}) ${b === "deny" ? "removes WebFetch" : b === "ask" ? "asks before every fetch" : "allows every fetch"}`);
      }
      const m = /^\s*domain\s*:\s*(.+?)\s*$/.exec(r.content);
      if (m && domainMatches(m[1], host)) return done(d, b, `${b}-rule`, r, `${r.raw} (${r.label}) matches ${host}`);
    }
  }
  d.fix = { rule: `WebFetch(domain:${host})`, why: "allows fetches from that host (add WebFetch(domain:*.example.com) for its subdomains)" };
  d.notes.push("Claude Code skips the prompt for a built-in set of documentation hosts that this tool does not list");
  return done(d, "ask", "no-rule", null, `no WebFetch rule allows ${host}`);
}

/** The matching the docs describe: case-insensitive, a trailing dot ignored, "*." for any depth of subdomain, "*" between dots. */
export function domainMatches(pattern, host) {
  const p = pattern.toLowerCase().replace(/\.$/, "");
  if (p === "*") return true;
  if (p.startsWith("*.") && !p.slice(2).includes("*")) return host.endsWith(p.slice(1)) && host.length > p.length - 1;
  if (!p.includes("*")) return host === p;
  const re = new RegExp(`^${p.split(".").map((seg) => (seg === "*" ? "[^.]+" : seg.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))).join("\\.")}$`);
  return re.test(host);
}

/** Any tool without a path or command: Skill, WebSearch, an MCP tool ... matched on its name. */
export function decideTool({ tool, settings }) {
  const all = activeRules(settings);
  const d = { tool, target: tool, verdict: null, kind: null, rule: null, summary: "", notes: [], fix: null };
  const mcp = parseMcp(tool);
  const hit = (r) => {
    if (r.content !== undefined && !(r.tool === tool)) return false;
    if (r.tool === tool) return r.content === undefined;
    if (mcp) {
      const rm = parseMcp(r.tool);
      if (!rm || r.content !== undefined) return false;
      if (rm.server !== mcp.server) return false;
      if (rm.tool === null || rm.tool === "*") return true;
      return globName(rm.tool, mcp.tool || "");
    }
    return hasStar(r.tool) && globName(r.tool, tool);
  };
  for (const b of ["deny", "ask", "allow"]) {
    const r = all[b].find(hit);
    if (r) return done(d, b, `${b}-rule`, r, `${r.raw} (${r.label}) matches ${tool}`);
  }
  if (mcp) d.fix = { rule: `mcp__${mcp.server}__${mcp.tool}`, why: `allows that tool; mcp__${mcp.server}__* allows every tool of the server` };
  else d.fix = { rule: tool, why: "allows every use of the tool" };
  return done(d, "ask", "no-rule", null, `no rule matches ${tool}; default mode asks`);
}

function globName(pattern, name) {
  const re = new RegExp(`^${pattern.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
  return re.test(name);
}

function done(d, verdict, kind, rule, summary) {
  d.verdict = verdict;
  d.kind = kind;
  d.rule = rule;
  d.summary = summary;
  if (!d.fix && rule) d.fix = { rule: null, why: `${verdict === "allow" ? "nothing to do" : `remove or narrow ${rule.raw} in ${rule.label}`}` };
  return d;
}
