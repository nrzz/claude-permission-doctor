// Commands Claude Code runs without a rule or a prompt, because they only read. The permissions
// page says the set exists and names some members ("ls, cat, echo, pwd, head, tail, grep, find, wc,
// which, diff, stat, du, cd, and read-only forms of git") but not the rest, and says it is not
// configurable. This table is what was observed from Claude Code 2.1.295: every command and every
// flag listed here ran without a prompt in test/oracle.test.mjs. Claude Code's own list is longer and
// decides on flags this table does not know, so a command that is missing here is reported as "not
// known to be read-only", never as "will prompt".
import { insideAny, leavesFolder, resolveArg, unsafePath } from "./paths.mjs";

// Commands that only read, whatever their arguments, and that take no file names.
const PLAIN = new Set([
  "echo", "printf", "true", "false", "test", "[", "[[", "which", "type", "help", "man", "basename", "dirname", "expr",
  "seq", "numfmt", "tput", "cal", "uname", "id", "groups", "nproc", "uptime", "free", "locale", "netstat", "lsof",
  "ifconfig", "pgrep", "tr", "sleep", "ss",
  // read-only and not looked at for file names, as checked: du ../x, tree ../x, realpath ../x and readlink -f ../x run without a prompt
  "realpath", "readlink", "du", "df",
]);

// Commands that only read, whatever their flags, and whose file arguments must be inside the
// folders Claude works in.
const FILES = new Set([
  "cat", "head", "tail", "wc", "stat", "file", "strings", "hexdump", "od", "nl", "tac", "rev", "fold", "fmt", "expand",
  "unexpand", "column", "paste", "comm", "cmp", "diff", "cut", "pr", "md5sum", "sha1sum", "sha256sum", "base64",
  "tsort", "ls", "jq",
]);

// The first plain argument of these is a pattern or a program, not a file.
const PATTERN_FIRST = new Set(["grep", "egrep", "fgrep", "rg", "jq"]);

const GREP_SHORT = new Set("ivclLnHhrREFPwxoqsaIzZUbTVABCmedD".split(""));
const GREP_LONG = new Set([
  "--ignore-case", "--invert-match", "--count", "--files-with-matches", "--files-without-match", "--line-number",
  "--with-filename", "--no-filename", "--recursive", "--dereference-recursive", "--extended-regexp", "--fixed-strings",
  "--perl-regexp", "--word-regexp", "--line-regexp", "--only-matching", "--quiet", "--no-messages", "--max-count",
  "--regexp", "--after-context", "--before-context", "--context", "--binary-files", "--text", "--include", "--exclude",
  "--exclude-dir", "--color", "--colour", "--null", "--initial-tab", "--byte-offset", "--version",
]);

const FIND_BLOCKED = new Set(["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fprintf", "-fls", "-files0-from"]);

// git: per subcommand, the flags seen to run without a prompt. Flags that take a value are written
// without it; "--format=%h" and "--format %h" both count as "--format".
const LOG_FLAGS = [
  "--abbrev-commit", "--no-merges", "--merges", "--first-parent", "--stat", "--shortstat", "--name-only", "--name-status",
  "--decorate", "--graph", "--format", "--pretty", "--date", "--relative-date", "--reverse", "--follow", "--author",
  "--since", "--grep", "--all", "--branches", "--remotes", "--tags", "--oneline", "--max-count", "-n", "--skip",
  "--until", "--after", "--before", "--diff-filter", "--numstat", "--patch", "-p", "--ancestry-path", "--left-right",
  "--cherry-pick", "-G", "-S", "--no-color", "--topo-order", "--date-order", "--boundary", "--summary",
];
const GIT = {
  status: ["-s", "--short", "-b", "--branch", "--porcelain", "--long", "--ignored", "--untracked-files"],
  log: LOG_FLAGS,
  diff: ["--name-status", "--numstat", "--shortstat", "--check", "--color", "--no-color", "--word-diff", "--ignore-space-change", "--minimal", "--patience", "-M", "--find-renames", "--exit-code", "--quiet", "--diff-filter", "--summary", "--no-index", "--stat", "--name-only", "--cached", "--staged"],
  show: ["--stat", "--name-only", "--pretty", "--format", "-s", "--no-patch", "--oneline"],
  branch: ["--contains", "--merged", "--no-merged", "--remotes", "-r", "--all", "-a", "-v", "-vv", "-l", "--list", "--show-current", "--sort"],
  tag: ["-l", "--list", "--points-at", "--contains", "--sort"],
  remote: ["-v"],
  stash: ["-p"],
  config: ["--get"],
  "rev-parse": ["--short", "--is-inside-work-tree", "--verify", "--show-prefix", "--git-common-dir", "--show-toplevel", "--abbrev-ref", "--git-dir"],
  "rev-list": ["--max-count", "--count", "--all"],
  "ls-files": ["--others", "-o", "-m", "--stage", "-s", "--exclude-standard"],
  blame: ["-L", "-w", "--porcelain"],
  describe: ["--tags", "--always", "--abbrev"],
  "cat-file": ["-t", "-s", "-e", "-p"],
  reflog: ["show"],
  shortlog: ["-s", "-n", "-e"],
  grep: ["-n", "-i", "--count", "-l", "-e"],
  "for-each-ref": [],
  "merge-base": ["--is-ancestor"],
  worktree: [],
};
// Flags that take a value (after "=" or as the next word).
const GIT_VALUE_FLAGS = new Set(["--untracked-files", "--format", "--pretty", "--date", "--author", "--since", "--grep", "--max-count", "-n", "--skip", "--until", "--after", "--before", "--diff-filter", "-G", "-S", "--sort", "--contains", "--merged", "--no-merged", "--points-at", "--short", "--abbrev", "-L", "-e", "--abbrev-ref"]);
// Flags that take their value as the next word, so that word is not a path or a name.
const GIT_NEXT_WORD = new Set(["-n", "-L", "-S", "-G", "-e", "--max-count", "--skip", "--author", "--since", "--until", "--after", "--before", "--grep", "--sort", "--contains", "--merged", "--no-merged", "--points-at"]);

// Subcommands that are read-only in one form only.
const GIT_FORMS = {
  stash: (rest) => (rest[0] === "list" && rest.length === 1) || rest[0] === "show",
  worktree: (rest) => rest[0] === "list",
  config: (rest) => rest[0] === "--get" && rest.length === 2,
  remote: (rest) => rest.every((a) => a === "-v"),
  reflog: (rest) => rest.every((a) => a === "show" || /^-\d+$/.test(a)),
};

function gitCheck(args) {
  const sub = args[0];
  if (!sub || sub.startsWith("-")) return { ok: false, why: `git ${sub || ""}: options before the subcommand are not on the list of read-only forms` };
  const rest = args.slice(1);
  if (!(sub in GIT)) return { ok: false, why: `git ${sub} is not on the list of read-only git subcommands` };
  if (GIT_FORMS[sub] && !GIT_FORMS[sub](rest)) return { ok: false, why: `this form of git ${sub} is not read-only` };
  const allowed = GIT[sub];
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--") break;
    if (!a.startsWith("-") || a === "-") { positional.push(a); continue; }
    if (["config", "stash", "reflog", "worktree", "remote"].includes(sub)) continue; // judged by the form above
    if (/^-\d+$/.test(a)) continue; // git log -5
    const eq = a.indexOf("=");
    const name = eq === -1 ? a : a.slice(0, eq);
    let ok = allowed.includes(name);
    if (!ok && eq === -1 && /^-[A-Za-z]{2,}$/.test(a)) ok = [...a.slice(1)].every((ch) => allowed.includes(`-${ch}`)); // -sb
    if (!ok) return { ok: false, why: `git ${sub} ${a}: this flag is not on the list of flags that run without a prompt` };
    if (eq !== -1 && !GIT_VALUE_FLAGS.has(name)) return { ok: false, why: `git ${sub} ${a}: this flag is not on the list in that form` };
    if (eq === -1 && GIT_NEXT_WORD.has(name) && rest[i + 1] !== undefined) i++;
  }
  // git tag NAME and git branch NAME create something
  if ((sub === "tag" || sub === "branch") && positional.length && !rest.includes("-l") && !rest.includes("--list")) {
    const values = new Set();
    rest.forEach((a, i) => { if (GIT_NEXT_WORD.has(a) && rest[i + 1] !== undefined) values.add(i + 1); });
    const named = rest.filter((a, i) => !a.startsWith("-") && !values.has(i));
    if (named.length) return { ok: false, why: `git ${sub} with a name creates one` };
  }
  return { ok: true };
}

/**
 * First argument that points outside the folders Claude may work in, or null. A path that a Read allow
 * rule covers (ctx.allowed says so) counts as inside.
 */
function outsideArg(args, { cwd, home, dirs, allowed }) {
  for (const a of args) {
    if (a.startsWith("-") || !leavesFolder(a)) continue;
    const abs = resolveArg(a, cwd, home);
    if (abs !== null && !insideAny(abs, dirs) && !(allowed && allowed(a))) return a;
  }
  return null;
}

function firstPositionalRemoved(args) {
  const out = [];
  let dropped = false;
  for (const a of args) {
    if (!dropped && !a.startsWith("-")) { dropped = true; continue; }
    out.push(a);
  }
  return out;
}

/**
 * Is this command (a word list, quotes removed, wrappers already taken off) one Claude Code runs
 * without asking? Folder checks use `dirs`, the folders Claude may work in, and `cwd`.
 * Returns { ok, why, cd, outside, unsafe }:
 *   ok       it runs without a prompt (as far as this table knows)
 *   why      a sentence the report shows
 *   cd       for a cd that stays inside the folders: the folder it goes to
 *   outside  an argument that points outside the folders; set even when the command is not read-only,
 *            because Claude Code checks folders for these commands whatever the Bash rules say
 *   unsafe   a path argument with a .. after a directory name or a // inside it: Claude Code asks about
 *            these for the file commands whatever the Bash rules say
 */
export function readOnly(argv, ctx) {
  const bad = pathArguments(argv).find((a) => unsafePath(a, ctx.platform));
  if (bad !== undefined) return { ok: false, why: `${argv[0]} ${bad}: the path ${unsafePath(bad, ctx.platform)}`, unsafe: bad };
  return classify(argv, ctx);
}

/** The words of a command that name files or folders: the ones Claude Code checks as paths. */
function pathArguments(argv) {
  const name = argv[0];
  if (name === "cd") return argv.slice(1);
  if (name === "find") return argv.slice(1).filter((a) => !a.startsWith("-"));
  const f = fileArguments(argv);
  return [...f.reads, ...f.writes];
}

function classify(argv, ctx) {
  const name = argv[0];
  if (!name) return { ok: false, why: "no command" };
  const args = argv.slice(1);
  const out = (why, outside) => ({ ok: false, why, outside });

  if (name === "cd") {
    if (args.length !== 1) return { ok: false, why: "cd with no folder, or with several, is not one Claude Code checks" };
    const abs = resolveArg(args[0], ctx.cwd, ctx.home);
    if (abs === null) return { ok: false, why: `cd ${args[0]}: the folder cannot be known before it runs` };
    if (!insideAny(abs, ctx.dirs)) return out(`cd goes to ${args[0]}, outside the folders Claude may work in`, args[0]);
    return { ok: true, why: "cd inside the working folders", cd: abs };
  }
  if (PLAIN.has(name)) return { ok: true, why: `${name} only reads` };

  let fileArgs = args;
  if (name === "grep" || name === "egrep" || name === "fgrep") {
    for (const a of args) {
      if (a === "--") break;
      if (a.startsWith("--")) {
        if (!GREP_LONG.has(a.includes("=") ? a.slice(0, a.indexOf("=")) : a)) return { ok: false, why: `${name} ${a}: this flag is not on the list of read-only flags`, outside: outsideArg(firstPositionalRemoved(args), ctx) || undefined };
      } else if (a.startsWith("-") && a.length > 1 && !/^-\d+$/.test(a)) {
        for (const ch of a.slice(1)) if (!GREP_SHORT.has(ch)) return { ok: false, why: `${name} ${a}: this flag is not on the list of read-only flags`, outside: outsideArg(firstPositionalRemoved(args), ctx) || undefined };
      }
    }
    fileArgs = args.some((a) => a === "-e" || a === "--regexp" || a.startsWith("--regexp=")) ? args : firstPositionalRemoved(args);
  } else if (PATTERN_FIRST.has(name)) {
    fileArgs = firstPositionalRemoved(args);
  } else if (name === "sed") {
    const script = args.find((a) => !a.startsWith("-"));
    const rest = args.filter((a) => a !== script);
    const outside = outsideArg(rest.filter((a) => !a.startsWith("-")), ctx) || undefined;
    const quiet = args.some((a) => a === "-n" || a === "--quiet" || a === "--silent");
    const printOnly = script !== undefined && /^(\d+|\d+,\d+)p(;(\d+|\d+,\d+)p)*$/.test(script);
    if (quiet && printOnly && args.filter((a) => a.startsWith("-")).every((f) => ["-n", "--quiet", "--silent", "-E", "-r"].includes(f))) {
      return outside ? out(`sed reads ${outside}, outside the folders Claude may work in`, outside) : { ok: true, why: "sed -n with a print-only script only reads" };
    }
    return { ok: false, why: "sed is read-only here only as sed -n with a line-range print script (sed -n 1,5p file)", outside };
  }

  const outside = outsideArg(fileArgs, ctx);
  const blocked = (why) => ({ ok: false, why, outside: outside || undefined });
  const done = (why) => (outside ? out(`${name} reads ${outside}, outside the folders Claude may work in`, outside) : { ok: true, why });

  if (name === "find") {
    for (const a of args) if (FIND_BLOCKED.has(a)) return blocked(`find ${a} runs commands or writes files, so a prefix rule cannot approve it and it prompts`);
    if (args.includes("(")) return blocked("find with a parenthesized expression is not one Claude Code checks");
    const starts = [];
    for (const a of args) { if (a.startsWith("-") || a === "!" || a === "(") break; starts.push(a); }
    const o = outsideArg(starts, ctx);
    return o ? out(`find searches ${o}, outside the folders Claude may work in`, o) : { ok: true, why: "find only reads (no -exec, -delete or -fprint)" };
  }
  if (name === "sort") {
    if (args.some((a) => a === "-o" || a.startsWith("--output") || /^-[A-Za-z]*o/.test(a))) return blocked("sort -o writes a file");
    return done("sort only reads without -o");
  }
  if (name === "tree") {
    if (args.includes("-o")) return { ok: false, why: "tree -o writes a file" };
    return { ok: true, why: "tree only reads without -o" };
  }
  if (name === "fd" || name === "fdfind") {
    // fd -x and -X run a command for every match
    if (args.some((a) => a === "-x" || a === "-X" || a.startsWith("--exec") || /^-[A-Za-z]*[xX]/.test(a))) return { ok: false, why: "fd with -x or -X runs a command for every match, so it prompts" };
    return { ok: true, why: "fd only reads without -x and -X" };
  }
  if (name === "stat") {
    if (args.some((a) => a === "-c" || a === "--format")) return blocked("stat with a format string is not one Claude Code checks");
    return done("stat only reads");
  }
  if (FILES.has(name) || PATTERN_FIRST.has(name) || name === "grep" || name === "egrep" || name === "fgrep") return done(`${name} only reads`);

  switch (name) {
    case "ps": {
      const ok = args.length === 0 || args.every((a, i) => ["aux", "auxf", "-ef", "-e", "-f", "--forest"].includes(a) || a === "-p" || (args[i - 1] === "-p" && /^\d+$/.test(a)));
      return ok ? { ok: true, why: "ps only reads in this form" } : { ok: false, why: "this form of ps is not one Claude Code runs without asking (ps aux and ps -ef are)" };
    }
    case "date": {
      const ok = args.length === 0 || args.every((a, i) => a === "-u" || a.startsWith("+") || a === "-d" || args[i - 1] === "-d");
      return ok ? { ok: true, why: "date only reads in this form" } : { ok: false, why: "this form of date could set the clock, so it prompts" };
    }
    case "pwd": return args.length === 0 ? { ok: true, why: "pwd only reads" } : { ok: false, why: "pwd with flags is not one Claude Code checks" };
    case "hostname": return args.every((a) => a === "-f") ? { ok: true, why: "hostname only reads" } : { ok: false, why: "hostname with a name would set it" };
    case "whoami": return args.length === 0 ? { ok: true, why: "whoami only reads" } : { ok: false, why: "whoami takes no arguments" };
    case "uniq": return args.every((a) => a.startsWith("-")) ? { ok: true, why: "uniq with no file arguments only reads" } : { ok: false, why: "uniq with a file argument could write its output to a second file" };
    case "node": return args.length === 1 && (args[0] === "-v" || args[0] === "--version") ? { ok: true, why: "a version check only reads" } : { ok: false, why: "node runs code" };
    case "python": case "python3": return args.length === 1 && args[0] === "--version" ? { ok: true, why: "a version check only reads" } : { ok: false, why: `${name} runs code` };
    case "docker": {
      const sub = args[0];
      if (args.some((a) => ["-H", "--host", "--context", "--url", "--connection"].some((f) => a === f || a.startsWith(`${f}=`)))) return { ok: false, why: "docker pointed at another daemon prompts" };
      return ["ps", "images", "logs", "inspect"].includes(sub) ? { ok: true, why: `docker ${sub} only reads` } : { ok: false, why: `docker ${sub || ""} is not on the list of read-only docker commands` };
    }
    case "git": {
      const r = gitCheck(args);
      return r.ok ? { ok: true, why: `git ${args[0]} is a read-only form of git` } : { ok: false, why: r.why };
    }
    default:
      return { ok: false, why: `${name} is not a command this tool knows Claude Code treats as read-only` };
  }
}

/** Programs whose file arguments Claude Code checks against Read deny rules (it recognizes these file commands in Bash). */
export const READS_FILES = new Set([...FILES, ...PATTERN_FIRST, "sed", "grep", "egrep", "fgrep", "cp", "mv", "sort", "uniq"]);
/** Programs whose file arguments Claude Code checks against Edit deny rules. */
export const WRITES_FILES = new Set(["tee", "cp", "mv", "touch", "mkdir", "rm", "rmdir", "sed"]);

/** The file arguments of a command that reads or writes files, for the Read and Edit rules. */
export function fileArguments(argv) {
  const name = argv[0];
  const rest = argv.slice(1);
  // After "--" every word is a name, even one that starts with a dash.
  const plain = [];
  const args = [];
  let dashes = false;
  for (const a of rest) {
    if (!dashes && a === "--") { dashes = true; continue; }
    if (dashes || !a.startsWith("-")) plain.push(a);
    if (!dashes) args.push(a);
  }
  if (name === "cp" || name === "mv") return { reads: plain.slice(0, -1), writes: plain.slice(-1) };
  if (name === "tee" || name === "touch" || name === "mkdir" || name === "rm" || name === "rmdir") return { reads: [], writes: plain };
  if (name === "sed") {
    const inPlace = args.some((a) => /^-[A-Za-z]*i/.test(a) || a.startsWith("--in-place"));
    const files = plain.slice(1);
    return inPlace ? { reads: [], writes: files } : { reads: files, writes: [] };
  }
  if (name === "grep" || name === "egrep" || name === "fgrep" || name === "rg") return { reads: args.some((a) => a === "-e") ? plain : plain.slice(1), writes: [] };
  if (name === "jq") return { reads: plain.slice(1), writes: [] };
  if (name === "find") {
    // the folders it starts from, and the files named by -newer and its relatives; a -name pattern is not a file
    const reads = [];
    let starting = true;
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (starting && !a.startsWith("-") && a !== "!" && a !== "(") { reads.push(a); continue; }
      starting = false;
      if (["-newer", "-anewer", "-cnewer", "-samefile"].includes(a) && rest[i + 1] !== undefined) reads.push(rest[++i]);
    }
    return { reads, writes: [] };
  }
  if (READS_FILES.has(name)) return { reads: plain, writes: [] };
  return { reads: [], writes: [] };
}
