// Wrappers and leading assignments that Claude Code looks through before it matches a rule.
//
// For an allow rule it strips a short built-in list (docs: timeout, time, nice, nohup, stdbuf,
// command, builtin, noglob, a bare xargs) and a leading VAR=value for a few harmless variables.
// For a deny or ask rule it looks through more: any leading assignment, and also env, sudo, doas,
// ionice, setsid, watch, flock, strace and exec (checked: a deny rule for rm catches sudo rm).
// xargs with a flag, npx, bash -c, docker exec and the like are never looked through.

import { textFrom } from "./shell.mjs";

// Variables whose leading assignment an allow rule steps over. Each one was checked one by one
// against Claude Code 2.1.295 (test/oracle.test.mjs); the docs say only "certain known-safe variables".
export const SAFE_ENV = new Set([
  "GOEXPERIMENT", "GOOS", "GOARCH", "CGO_ENABLED", "GO111MODULE", "RUST_BACKTRACE", "RUST_LOG", "NODE_ENV",
  "PYTHONUNBUFFERED", "PYTHONDONTWRITEBYTECODE", "PYTEST_DISABLE_PLUGIN_AUTOLOAD", "PYTEST_DEBUG", "ANTHROPIC_API_KEY",
  "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "LC_TIME", "CHARSET", "TERM", "COLORTERM", "NO_COLOR", "FORCE_COLOR", "TZ",
  "LS_COLORS", "LSCOLORS", "GREP_COLOR", "GREP_COLORS", "GCC_COLORS", "TIME_STYLE", "BLOCK_SIZE", "BLOCKSIZE", "COLUMNS",
  "LINES", "CLICOLOR", "CLICOLOR_FORCE", "CI", "DEBIAN_FRONTEND", "GIT_TERMINAL_PROMPT",
]);

const DURATION = /^\d+(\.\d+)?[smhd]?$/;

/**
 * How many words, from index i, make up a wrapper and its own arguments? 0 when words[i] is not a
 * wrapper in this mode or its arguments cannot be read.
 *   deep  also look through the wrappers a deny or ask rule sees through
 */
export function wrapperLength(words, i, { deep }) {
  const w = words[i];
  const at = (k) => words[i + k];
  switch (w) {
    case "time": {
      let k = 1;
      while (at(k) === "-p") k++;
      return words[i + k] === undefined ? 0 : k;
    }
    case "nohup": case "builtin": case "noglob": return words[i + 1] === undefined ? 0 : 1;
    case "nice": {
      let k = 1;
      if (at(k) === "-n" && at(k + 1) !== undefined) k += 2;
      else if (at(k) !== undefined && /^(-\d+|--adjustment=\S+|-n\d+)$/.test(at(k))) k += 1;
      return words[i + k] === undefined ? 0 : k;
    }
    case "stdbuf": {
      let k = 1;
      while (at(k) !== undefined && /^(-[ioe]\S+|--(input|output|error)=\S+)$/.test(at(k))) k++;
      if (at(k) !== undefined && at(k).startsWith("-")) return 0;
      return k > 1 && words[i + k] !== undefined ? k : 0;
    }
    case "command": {
      let k = 1;
      while (at(k) === "-p") k++;
      if (at(k) !== undefined && at(k).startsWith("-")) return 0; // command -v looks a command up; it does not run it
      return words[i + k] === undefined ? 0 : k;
    }
    case "timeout": {
      let k = 1;
      for (;;) {
        const f = at(k);
        if (f === undefined) return 0;
        if (f === "--preserve-status" || f === "--foreground" || f === "-v" || f === "--verbose") { k++; continue; }
        if (/^--(kill-after|signal)=[\w.+-]+$/.test(f)) { k++; continue; }
        if ((f === "-k" || f === "-s" || f === "--kill-after" || f === "--signal") && at(k + 1) !== undefined && /^[\w.+-]+$/.test(at(k + 1))) { k += 2; continue; }
        if (f.startsWith("-")) return 0;
        break;
      }
      if (!DURATION.test(at(k) || "")) return 0;
      return words[i + k + 1] === undefined ? 0 : k + 1;
    }
    case "xargs": {
      // only a bare xargs: any flag and it is matched as an xargs command
      if (at(1) === undefined || at(1).startsWith("-")) return 0;
      return 1;
    }
    default:
  }
  if (!deep) return 0;
  switch (w) {
    case "env": {
      let k = 1;
      for (;;) {
        const f = at(k);
        if (f === undefined) return 0;
        if (/^[A-Za-z_]\w*=/.test(f)) { k++; continue; }
        if (f === "-i" || f === "-0" || f === "-v" || f === "--ignore-environment") { k++; continue; }
        if ((f === "-u" || f === "-C" || f === "-S") && at(k + 1) !== undefined) { k += 2; continue; }
        if (f.startsWith("-")) return 0;
        break;
      }
      return words[i + k] === undefined ? 0 : k;
    }
    case "sudo": case "doas": {
      let k = 1;
      const withArg = w === "sudo" ? new Set(["-u", "-g", "-h", "-p", "-C", "-D", "-r", "-t", "-T", "-U"]) : new Set(["-u", "-C"]);
      for (;;) {
        const f = at(k);
        if (f === undefined) return 0;
        if (f === "--") { k++; break; }
        if (withArg.has(f) && at(k + 1) !== undefined) { k += 2; continue; }
        if (f.startsWith("-")) { k++; continue; }
        break;
      }
      return words[i + k] === undefined ? 0 : k;
    }
    case "ionice": case "setsid": case "watch": case "strace": case "flock": case "exec": {
      const withArg = {
        ionice: new Set(["-c", "-n", "-p"]), setsid: new Set(), watch: new Set(["-n", "--interval"]), strace: new Set(["-o", "-e", "-p", "-s", "-u"]),
        flock: new Set(["-w", "-E", "-c"]), exec: new Set(["-a"]),
      }[w];
      let k = 1;
      for (;;) {
        const f = at(k);
        if (f === undefined) return 0;
        if (withArg.has(f) && at(k + 1) !== undefined) { k += 2; continue; }
        if (f.startsWith("-") && f !== "--") { k++; continue; }
        break;
      }
      if (w === "flock") k++; // the lock file
      return words[i + k] === undefined ? 0 : k;
    }
    default:
      return 0;
  }
}

/**
 * Every text a rule could be matched against for this simple command, from the whole command down to
 * what is left after each wrapper or assignment is stripped.
 *   behavior  "allow" strips the short list and safe assignments; "deny" and "ask" strip more
 * Claude Code also reads the command word without its quotes and backslashes ("rm" x, \rm x), so each
 * text comes with that spelling too when it differs. Returns [{ text, stripped }], the command as
 * written first; stripped names what was taken off ("timeout 30", "NODE_ENV=").
 */
export function candidates(cmd, behavior) {
  const deep = behavior !== "allow";
  const all = [...cmd.assigns, ...cmd.argv];
  if (!all.length) return [];
  const values = all.map((w) => w.value);
  const out = [];
  const add = (i, stripped) => {
    const text = textFrom({ ...cmd, argv: all, assigns: [] }, i);
    if (text && !out.some((o) => o.text === text)) out.push({ text, stripped: [...stripped] });
    const head = all[i];
    // the command word without its quotes: only when that leaves one plain word
    if (head && head.quoted && !head.dynamic && head.value && !/\s/.test(head.value) && i >= cmd.assigns.length && text.startsWith(head.raw)) {
      const plain = `${head.value}${text.slice(head.raw.length)}`.trim();
      if (plain && !out.some((o) => o.text === plain)) out.push({ text: plain, stripped: [...stripped] });
    }
  };
  add(0, []);
  let i = 0;
  const stripped = [];
  for (let guard = 0; guard < 20 && i < all.length; guard++) {
    if (i < cmd.assigns.length) {
      const name = values[i].slice(0, values[i].indexOf("="));
      if (!deep && !SAFE_ENV.has(name)) break;
      stripped.push(`${name}=`);
      i++;
    } else {
      const n = wrapperLength(values, i, { deep });
      if (!n) break;
      stripped.push(values.slice(i, i + n).join(" "));
      i += n;
    }
    if (i >= all.length) break;
    add(i, stripped);
  }
  return out;
}

/**
 * The program a simple command runs, for the question "is it read-only?": only a harmless variable in
 * front and command, builtin or noglob are looked through (timeout, nice, env, xargs ... make a
 * read-only command prompt). Returns { index, words } into [...assigns, ...argv]; index is smaller than
 * the number of assignments when an unsafe one is in the way.
 */
export function innerProgram(cmd) {
  const all = [...cmd.assigns, ...cmd.argv];
  const values = all.map((w) => w.value);
  let i = 0;
  for (let guard = 0; guard < 20 && i < all.length; guard++) {
    if (i < cmd.assigns.length) {
      const name = values[i].slice(0, values[i].indexOf("="));
      if (!SAFE_ENV.has(name)) break;
      i++;
      continue;
    }
    if (values[i] === "command" || values[i] === "builtin" || values[i] === "noglob") {
      const n = wrapperLength(values, i, { deep: false });
      if (!n) break;
      i += n;
      continue;
    }
    break;
  }
  return { index: i, words: values.slice(i), total: all.length };
}

/**
 * The words of the command once every wrapper and assignment the given kind of rule looks through is
 * off: "allow" is the short list, "deny" the longer one. "path" is what Claude Code looks through to
 * find the files a command names (any assignment, the short list and env, but not sudo, exec or xargs).
 * Used to find the program a file check applies to.
 */
export function strippedWords(cmd, behavior) {
  const deep = behavior === "deny" || behavior === "ask";
  const all = [...cmd.assigns, ...cmd.argv];
  const values = all.map((w) => w.value);
  let i = 0;
  for (let guard = 0; guard < 20 && i < all.length; guard++) {
    if (i < cmd.assigns.length) {
      const name = values[i].slice(0, values[i].indexOf("="));
      if (!deep && behavior !== "path" && !SAFE_ENV.has(name)) break;
      i++;
      continue;
    }
    if (behavior === "path" && values[i] === "xargs") break; // Claude Code does not follow the folders of what xargs will run
    let n = wrapperLength(values, i, { deep });
    if (!n && behavior === "path" && values[i] === "env") n = wrapperLength(values, i, { deep: true });
    if (!n) break;
    i += n;
  }
  return values.slice(i);
}
