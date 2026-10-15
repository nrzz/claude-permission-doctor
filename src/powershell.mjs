// A reader for the PowerShell that Claude runs, built for the same question as shell.mjs: which
// commands are in this line, and is there anything Claude Code cannot check before it runs? PowerShell
// rules have the same shape as Bash rules. The docs say a compound command is split at | and ;
// (and at && and || on PowerShell 7 and newer), that rules are not case-sensitive, and that aliases
// are canonicalized, so a rule for Get-ChildItem also matches ls, dir and gci.
//
// Like the Bash reader this one never runs anything and never expands anything.

export const PS_ISSUE_TEXT = {
  "parse": "Claude Code cannot parse this PowerShell",
  "subexpression": "a subexpression $( ) or parenthesized command cannot be checked before it runs",
  "script-block": "a script block { } may execute arbitrary code",
  "variable": "a variable in the arguments cannot be checked before it runs",
  "assignment": "a variable assignment cannot be checked before it runs",
  "environment": "this modifies an environment variable",
  "control-flow": "a control-flow statement (if, foreach, try ...) cannot be checked before it runs",
  "dynamic-command": "the command name is a dynamic expression that cannot be checked before it runs",
  "nested-shell": "this starts a nested PowerShell process, which cannot be checked",
  "invoke-expression": "Invoke-Expression can execute arbitrary code",
  "background": "the & background operator cannot be checked before it runs",
  "dot-source": "dot-sourcing a script cannot be checked before it runs",
  "unc-path": "a // or a double backslash inside the command could be a network (UNC) path, and Claude Code asks about that whatever the rules say",
};

const KEYWORDS = new Set(["if", "elseif", "else", "foreach", "for", "while", "do", "until", "switch", "try", "catch", "finally", "function", "filter", "workflow", "param", "trap", "return", "throw", "break", "continue", "exit", "using", "class", "enum", "data", "dynamicparam", "begin", "process", "end"]);
const NESTED_SHELLS = new Set(["powershell", "powershell.exe", "pwsh", "pwsh.exe"]);
// a // or a double backslash with more text after it, other than the // of a URL: a network path to Windows
const UNC = /(?<!:)(?:\/\/|\\\\)(?=\S)/;
const MAX_STEPS = 200000;

const isSpace = (c) => c === " " || c === "\t" || c === "\r";
const isNameChar = (c) => c !== undefined && /[A-Za-z0-9_:?]/.test(c);

/**
 * Read `src` as PowerShell. Returns the same shape as parseBash: { ok, problem, cmds, issues, seps },
 * where cmds are { text, argv, assigns, redirs, ctx, start, end, src }.
 */
export function parsePowerShell(src) {
  return new PsReader(String(src)).run();
}

class PsReader {
  constructor(src) {
    this.src = src;
    this.i = 0;
    this.cmds = [];
    this.issues = [];
    this.seps = [];
    this.problem = null;
    this.seen = new Set();
    this.steps = 0;
  }

  run() {
    if (UNC.test(this.src)) this.issue("unc-path");
    try {
      this.statements({ ctx: [], close: null, top: true });
    } catch (e) {
      this.fail(`the reader gave up (${e.message})`);
    }
    return { ok: !this.problem, problem: this.problem, cmds: this.cmds, issues: this.issues, seps: this.seps, chain: !!this.chain };
  }

  issue(kind, detail) {
    const key = `${kind}:${detail || ""}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.issues.push({ kind, text: PS_ISSUE_TEXT[kind] + (detail ? ` (${detail})` : "") });
  }

  fail(why) {
    if (!this.problem) this.problem = why;
  }

  tick() {
    if (++this.steps > MAX_STEPS) throw new Error("too long");
  }

  peek(n = 0) {
    return this.src[this.i + n];
  }

  skipBlanks() {
    for (;;) {
      const c = this.src[this.i];
      if (isSpace(c)) { this.i++; continue; }
      if (c === "`" && (this.src[this.i + 1] === "\n" || (this.src[this.i + 1] === "\r" && this.src[this.i + 2] === "\n"))) {
        this.i += this.src[this.i + 1] === "\r" ? 3 : 2;
        continue;
      }
      if (c === "<" && this.src[this.i + 1] === "#") {
        const end = this.src.indexOf("#>", this.i + 2);
        this.i = end === -1 ? this.src.length : end + 2;
        continue;
      }
      break;
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Statements and pipelines
  // ---------------------------------------------------------------------------------------------

  /** Read statements until the end, or the `close` bracket (")" or "}"). */
  statements({ ctx, close, top = false }) {
    let cur = { items: [], head: true };
    let haveCmd = false;
    let expect = null;
    const flush = () => {
      if (cur.items.length) {
        this.emit(cur, ctx);
        haveCmd = true;
        expect = null;
      }
      cur = { items: [], head: true };
    };
    const op = (name, chain) => {
      const had = cur.items.length > 0 || haveCmd;
      flush();
      if (!had) this.fail(`"${name}" with no command before it`);
      if (top) this.seps.push(name);
      if (chain) expect = name;
      haveCmd = false;
    };
    for (;;) {
      this.tick();
      this.skipBlanks();
      if (this.i >= this.src.length) break;
      const c = this.peek();
      if (c === "\n") {
        this.i++;
        const had = cur.items.length > 0 || haveCmd;
        flush();
        if (top && had && !expect) this.seps.push("\n");
        if (!expect) haveCmd = false;
        continue;
      }
      if (c === "#") {
        while (this.i < this.src.length && this.peek() !== "\n") this.i++;
        continue;
      }
      if (close && c === close) {
        this.i++;
        flush();
        return true;
      }
      if (c === ";") { this.i++; const had = cur.items.length > 0 || haveCmd; flush(); if (!had && !top) { /* empty statement */ } if (top) this.seps.push(";"); haveCmd = false; continue; }
      if (c === "|" && this.peek(1) === "|") { this.i += 2; this.chain = true; op("||", true); continue; }
      if (c === "&" && this.peek(1) === "&") { this.i += 2; this.chain = true; op("&&", true); continue; }
      if (c === "|") { this.i++; op("|", true); continue; }
      if (c === "&" && cur.items.length === 0) {
        // the call operator: & command args
        this.i++;
        cur.items.push({ type: "word", word: this.fake("&") });
        cur.call = true;
        continue;
      }
      if (c === "&") { this.i++; this.issue("background"); op("&", false); continue; }
      if (c === ">" || c === "<" || (/[0-9*]/.test(c) && /^[0-9*]>/.test(this.src.slice(this.i, this.i + 2)))) {
        if (c === "<" && this.peek(1) === "<") { /* not PowerShell syntax: read as a word */ } else { this.redirect(cur, ctx); continue; }
      }
      if (c === ")" || c === "}") {
        this.fail(`an unexpected "${c}"`);
        this.i++;
        continue;
      }
      const head = cur.items.length === 0 || (cur.call && cur.items.length === 1);
      const w = this.word(ctx, { head });
      if (!w) continue;
      if (head) {
        const r = this.headWord(w, cur);
        if (r === "assignment") { cur = { items: [] }; continue; } // the right-hand side is a command of its own
        if (r === "keyword") cur.keyword = true;
      }
      cur.items.push({ type: "word", word: w });
    }
    flush();
    if (expect) this.fail(`"${expect}" with nothing after it`);
    return false;
  }

  /** Notes on the first word of a statement: a keyword, a variable assignment, a dynamic name. */
  headWord(w, cur) {
    const raw = w.raw;
    if (cur.call) {
      if (/^[$({@]/.test(raw)) this.issue("dynamic-command", raw);
      return null;
    }
    if (raw === "." && !w.quoted) {
      this.issue("dot-source");
      return null;
    }
    if (!w.quoted && KEYWORDS.has(raw.toLowerCase())) {
      this.issue("control-flow", raw.toLowerCase());
      return "keyword";
    }
    if (raw.startsWith("$") && !w.quoted) {
      this.skipBlanks();
      const op = /^[-+*/%]?=(?!=)/.exec(this.src.slice(this.i, this.i + 3));
      if (op) {
        this.issue(/^\$env:/i.test(raw) ? "environment" : "assignment");
        this.i += op[0].length;
        return "assignment";
      }
      this.issue("dynamic-command", raw);
    }
    return null;
  }

  fake(raw) {
    return { raw, value: raw, start: this.i - raw.length, end: this.i, dynamic: false, quoted: false };
  }

  // ---------------------------------------------------------------------------------------------
  // Words
  // ---------------------------------------------------------------------------------------------

  /** One argument or command name. Brackets and expansions are read for the commands inside them. */
  word(ctx, { head = false } = {}) {
    const src = this.src;
    const start = this.i;
    let value = "";
    let quoted = false;
    let dynamic = false;
    while (this.i < src.length) {
      this.tick();
      const c = src[this.i];
      if (isSpace(c) || c === "\n" || c === ";" || c === "|" || c === ")" || c === "}") break;
      if (c === "&" || c === ">" || c === "<") {
        if (c === "&" && this.i === start) { this.i++; value += c; continue; }
        break;
      }
      if (c === "`") {
        const n = src[this.i + 1];
        if (n === undefined) { this.i++; break; }
        value += n;
        quoted = true;
        this.i += 2;
        continue;
      }
      if (c === "'") {
        quoted = true;
        this.i++;
        for (;;) {
          const e = src.indexOf("'", this.i);
          if (e === -1) { value += src.slice(this.i); this.i = src.length; break; }
          value += src.slice(this.i, e);
          this.i = e + 1;
          if (src[this.i] === "'") { value += "'"; this.i++; continue; } // '' is a quote
          break;
        }
        continue;
      }
      if (c === '"') {
        quoted = true;
        this.i++;
        value += this.dquote(ctx, () => { dynamic = true; });
        continue;
      }
      if (c === "@" && (src[this.i + 1] === '"' || src[this.i + 1] === "'") && /^\s*\r?\n/.test(src.slice(this.i + 2, this.i + 6) || "\n")) {
        // here-string: @" ... "@ on lines of their own
        const q = src[this.i + 1];
        const close = src.indexOf(`\n${q}@`, this.i + 2);
        const body = close === -1 ? src.slice(this.i + 2) : src.slice(this.i + 2, close);
        if (q === '"' && /\$/.test(body)) { this.issue("variable"); dynamic = true; }
        this.i = close === -1 ? src.length : close + 3;
        quoted = true;
        value += body;
        continue;
      }
      if (c === "$") {
        const n = src[this.i + 1];
        if (n === "(") {
          this.i += 2;
          this.statements({ ctx: [...ctx, "subexpression"], close: ")" });
          this.issue("subexpression");
          dynamic = true;
          continue;
        }
        if (n === "{") {
          const e = src.indexOf("}", this.i + 2);
          this.i = e === -1 ? src.length : e + 1;
          this.issue("variable");
          dynamic = true;
          continue;
        }
        let j = this.i + 1;
        while (isNameChar(src[j])) j++;
        if (j === this.i + 1 && "$?^_".includes(src[j] || "")) j++;
        const name = src.slice(this.i + 1, j);
        if (!head) this.issue("variable", `${name}`);
        value += src.slice(this.i, j);
        this.i = j;
        dynamic = true;
        continue;
      }
      if (c === "@" && (src[this.i + 1] === "(" || src[this.i + 1] === "{")) {
        const open = src[this.i + 1];
        this.i += 2;
        this.statements({ ctx: [...ctx, "subexpression"], close: open === "(" ? ")" : "}" });
        this.issue(open === "(" ? "subexpression" : "script-block");
        dynamic = true;
        continue;
      }
      if (c === "(") {
        this.i++;
        this.statements({ ctx: [...ctx, "subexpression"], close: ")" });
        this.issue("subexpression");
        dynamic = true;
        continue;
      }
      if (c === "{") {
        this.i++;
        this.statements({ ctx: [...ctx, "script-block"], close: "}" });
        this.issue("script-block");
        dynamic = true;
        continue;
      }
      value += c;
      this.i++;
    }
    if (this.i === start) {
      if (this.i < src.length && !isSpace(src[this.i]) && src[this.i] !== "\n") this.i++;
      return null;
    }
    return { raw: src.slice(start, this.i), value, start, end: this.i, dynamic, quoted };
  }

  dquote(ctx, markDynamic) {
    const src = this.src;
    let text = "";
    while (this.i < src.length) {
      this.tick();
      const c = src[this.i];
      if (c === '"') {
        if (src[this.i + 1] === '"') { text += '"'; this.i += 2; continue; }
        this.i++;
        return text;
      }
      if (c === "`") { text += src[this.i + 1] ?? ""; this.i += 2; continue; }
      if (c === "$") {
        const n = src[this.i + 1];
        if (n === "(") {
          this.i += 2;
          this.statements({ ctx: [...ctx, "subexpression"], close: ")" });
          this.issue("subexpression");
          markDynamic();
          continue;
        }
        if (n === "{") {
          const e = src.indexOf("}", this.i + 2);
          this.i = e === -1 ? src.length : e + 1;
          this.issue("variable");
          markDynamic();
          continue;
        }
        let j = this.i + 1;
        while (isNameChar(src[j])) j++;
        if (j > this.i + 1) {
          const name = src.slice(this.i + 1, j);
          this.issue("variable", `$${name}`);
          text += src.slice(this.i, j);
          this.i = j;
          markDynamic();
          continue;
        }
      }
      text += c;
      this.i++;
    }
    return text;
  }

  redirect(cur, ctx) {
    const src = this.src;
    const start = this.i;
    const m = /^([0-9*]?)(>>|>|<)(&?)/.exec(src.slice(this.i, this.i + 5));
    if (!m) { this.i++; return; }
    this.i += m[0].length;
    this.skipBlanks();
    const target = this.word(ctx);
    if (!target) { this.fail(`a redirection "${m[2]}" with no target`); return; }
    cur.items.push({ type: "redir", redir: { op: m[2] + m[3], fd: m[1] || null, target, start, end: this.i } });
  }

  emit(cur, ctx) {
    const argv = [];
    const redirs = [];
    for (const it of cur.items) {
      if (it.type === "redir") redirs.push(it.redir);
      else argv.push(it.word);
    }
    if (cur.keyword) return; // if, foreach, try ...: the commands inside were read already
    if (cur.call) argv.shift(); // the & itself is not part of the command
    if (!argv.length) return;
    // a variable, a number or a string at the head is an expression, not a command
    if (!cur.call && argv[0].raw !== "." && (argv[0].raw.startsWith("$") || /^[\d.,+-]+$/.test(argv[0].raw) || /^["']/.test(argv[0].raw))) return;
    const start = argv[0].start;
    const end = argv[argv.length - 1].end;
    const cmd = { text: "", argv, assigns: [], redirs, ctx, start, end, src: this.src, call: !!cur.call };
    cmd.text = cutPs(this.src, start, end, redirs).trim();
    if (cur.call) cmd.text = `& ${cmd.text}`;
    this.cmds.push(cmd);
    const name = argv[0].value.toLowerCase();
    if (NESTED_SHELLS.has(name) && !cur.call) this.issue("nested-shell");
    if (name === "invoke-expression" || name === "iex") this.issue("invoke-expression");
  }
}

function cutPs(src, start, end, redirs) {
  const inside = redirs.filter((r) => r.start >= start && r.end <= end).sort((a, b) => a.start - b.start);
  if (!inside.length) return src.slice(start, end);
  let out = "";
  let at = start;
  for (const r of inside) {
    out += src.slice(at, r.start);
    at = r.end;
  }
  return out + src.slice(at, end);
}
