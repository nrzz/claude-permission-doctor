// A reader for the Bash that Claude runs. It finds every simple command in a command line, wherever it
// sits (after &&, in a pipe, inside $( ), a subshell or an if/for body), and it notes the things Claude
// Code cannot check before they run: a command substitution, a variable it does not know, a
// subshell, a while loop, a function, an unquoted heredoc ... Rules are matched against these
// commands, so the splitting here decides "does my rule apply".
//
// This is a reader for permission questions, not a shell: it never expands, evaluates or runs anything.

/** Why an allow rule cannot cover a command line, however it is written. */
export const ISSUE_TEXT = {
  "parse": "Claude Code cannot parse this command line",
  "background": "the & background operator defers execution past the approval checks",
  "subshell": "a subshell ( ... ) cannot be checked before it runs",
  "brace-group": "a group in braces or double parentheses cannot be checked before it runs",
  "substitution": "a command substitution $( ... ) or backticks cannot be checked before it runs",
  "quoted-substitution": "a command substitution inside double quotes cannot be checked before it runs",
  "process-substitution": "a process substitution <( ... ) cannot be checked before it runs",
  "variable": "a variable cannot be checked before it runs",
  "braced-variable": "a variable in braces ${ ... } cannot be checked before it runs",
  "brace-expansion": "a brace expansion {a,b} cannot be checked before it runs",
  "function": "a function definition cannot be checked before it runs",
  "case": "a case statement cannot be checked before it runs",
  "heredoc": "a heredoc with an unquoted delimiter is expanded by the shell, so it cannot be checked before it runs",
  "heredoc-tail": "text after the heredoc marker on the same line cannot be checked before it runs",
  "compound-redirect": "a redirection on an if, for, while, subshell or group cannot be checked before it runs",
  "escaped-whitespace": "a backslash-escaped space or line break cannot be checked before it runs",
  "ansi-c-quote": "text in $'...' quotes, with escape codes, cannot be checked before it runs",
  "locale-quote": "a $\"...\" string cannot be checked before it runs",
  "multiple-assignments": "several variable assignments in one command cannot be checked before it runs",
  "nested-assignment": "a variable assignment inside an if, for, while or group cannot be checked before it runs",
  "eval": "this builtin runs its arguments as shell code",
  "test-brackets": "a test in [ ] with a redirection cannot be checked before it runs",
};

const SAFE_VARIABLES = new Set(["HOME"]);
const EVAL_BUILTINS = new Set(["eval", "source", ".", "exec", "alias", "trap"]);
// Words that are shell syntax when they start a command. "time" is not here: Claude Code treats it
// as a wrapper that rules see through, like timeout and nice.
const RESERVED = new Set(["if", "then", "elif", "else", "fi", "for", "while", "until", "do", "done", "case", "esac", "select", "function", "{", "}", "!", "[[", "coproc"]);
const MAX_STEPS = 200000;

const isSpace = (c) => c === " " || c === "\t" || c === "\r";
const isDigit = (c) => c !== undefined && c >= "0" && c <= "9";
const isNameStart = (c) => c !== undefined && /[A-Za-z_]/.test(c);
const isNameChar = (c) => c !== undefined && /[A-Za-z0-9_]/.test(c);
const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/;

/**
 * Read `src` and return what a permission check needs:
 *   ok       false when Claude Code would call the text unparseable (an operator with nothing after it ...)
 *   problem  the reason, when not ok
 *   cmds     every simple command: { text, argv, assigns, redirs, ctx, start, end }
 *              text    the command as a rule sees it: redirections taken out, spaces trimmed
 *              argv    its words: { raw, value, start, end, dynamic, quoted }  (value has the quotes taken off)
 *              assigns leading VAR=value words
 *              ctx     where it sits: [] at the top, else e.g. ["substitution"], ["if"], ["subshell"]
 *   issues   [{ kind, text }] things that stop an allow rule from covering the line
 *   seps     the separators at the top level, in order
 */
export function parseBash(src) {
  return new Reader(String(src)).run();
}

class Reader {
  constructor(src) {
    this.src = src;
    this.i = 0;
    this.cmds = [];
    this.issues = [];
    this.seps = [];
    this.problem = null;
    this.pending = []; // heredocs waiting for their body
    this.seen = new Set();
    this.steps = 0;
    this.assignValue = false; // reading the value of VAR=... at the start of a command
    this.heredocLine = false; // a heredoc marker was read and its line has not ended
  }

  run() {
    try {
      this.sequence({ ctx: [], close: false, top: true });
    } catch (e) {
      this.fail(`the reader gave up (${e.message})`);
    }
    return { ok: !this.problem, problem: this.problem, cmds: this.cmds, issues: this.issues, seps: this.seps };
  }

  issue(kind, detail) {
    const key = `${kind}:${detail || ""}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.issues.push({ kind, text: ISSUE_TEXT[kind] + (detail ? ` (${detail})` : "") });
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
    while (this.i < this.src.length && isSpace(this.src[this.i])) this.i++;
  }

  // ---------------------------------------------------------------------------------------------
  // A run of commands: the top level, a $( ) body, a ( ) body, or the body of a compound command
  // ---------------------------------------------------------------------------------------------

  /**
   * Read commands until the end, a closing ")" (when `close`), or a reserved word in `stop`.
   * Returns { stopped } with that word or ")" (null at the end of the text).
   */
  sequence({ ctx, close, top = false, stop = null }) {
    let cur = { items: [] };
    let atStart = true; // the next word is in command position
    let haveCmd = false; // a command (simple or compound) is complete since the last separator
    let expect = null; // "&&" or "||" while a command must still follow

    const flush = () => {
      if (cur.items.length) {
        this.emit(cur, ctx);
        haveCmd = true;
        expect = null;
      }
      cur = { items: [] };
      atStart = true;
    };
    const hasLeft = () => cur.items.length > 0 || haveCmd;
    const operator = (name, { chain }) => {
      const had = hasLeft();
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

      // anything after a heredoc marker on its line (a word, a pipe, a comment ...) is unreadable to Claude Code
      if (this.heredocLine && c !== "\n") {
        this.issue("heredoc-tail");
        this.heredocLine = false;
      }
      if (c === "\n") {
        this.heredocLine = false;
        this.i++;
        const had = hasLeft();
        flush();
        if (this.pending.length) this.readHeredocBodies();
        if (top && had && !expect) this.seps.push("\n");
        if (!expect) haveCmd = false;
        continue;
      }
      if (c === "#") {
        while (this.i < this.src.length && this.peek() !== "\n") this.i++;
        continue;
      }
      if (c === "\\" && this.peek(1) === "\n") {
        this.issue("escaped-whitespace");
        this.i += 2;
        continue;
      }
      if (c === "&" && this.peek(1) === "&") { this.i += 2; operator("&&", { chain: true }); continue; }
      if (c === "|" && this.peek(1) === "|") { this.i += 2; operator("||", { chain: true }); continue; }
      if (c === "|") { const n = this.peek(1) === "&" ? "|&" : "|"; this.i += n.length; operator(n, { chain: false }); continue; }
      if (c === ";") {
        if (this.peek(1) === ";") {
          this.i += this.peek(2) === "&" ? 3 : 2;
          flush();
          haveCmd = false;
          if (stop && stop.has(";;")) return { stopped: ";;" };
          continue;
        }
        this.i++;
        const had = hasLeft();
        flush();
        if (!had) this.fail('";" with no command before it');
        if (top) this.seps.push(";");
        haveCmd = false;
        continue;
      }
      if (c === "&" && this.peek(1) !== ">") {
        this.i++;
        const had = hasLeft();
        flush();
        if (!had) this.fail('"&" with no command before it');
        this.issue("background");
        if (top) this.seps.push("&");
        haveCmd = false;
        continue;
      }
      if (c === ")") {
        if (close) {
          this.i++;
          flush();
          return { stopped: ")" };
        }
        this.fail('an unexpected ")"');
        this.i++;
        continue;
      }
      if (c === "(") {
        if (atStart && cur.items.length === 0) {
          this.i++;
          if (this.peek() === "(") {
            this.i++;
            this.skipArithmetic();
            this.issue("brace-group");
          } else {
            this.issue("subshell");
            this.sequence({ ctx: [...ctx, "subshell"], close: true });
          }
          haveCmd = true;
          expect = null;
          atStart = false;
          continue;
        }
        if (cur.items.length === 1 && cur.items[0].type === "word" && this.peek(1) === ")") {
          // name() { ... }
          this.i += 2;
          this.issue("function");
          cur = { items: [] };
          atStart = true;
          continue;
        }
        this.fail('an unexpected "("');
        this.i++;
        continue;
      }
      if (c === "<" || c === ">" || (c === "&" && this.peek(1) === ">") || (isDigit(c) && this.redirectAhead())) {
        if ((c === "<" || c === ">") && this.peek(1) === "(") {
          // a process substitution is a word, not a redirection
        } else {
          if (cur.items.length === 0 && haveCmd) this.issue("compound-redirect"); // done < file, fi > out, ) 2>&1
          this.readRedirect(cur, ctx);
          continue;
        }
      }

      // a word
      const wasAssign = atStart && (cur.items.length === 0 || cur.items.every((it) => it.assign || it.type === "redir")) && ASSIGN.test(this.src.slice(this.i, this.i + 256));
      this.assignValue = wasAssign;
      const w = this.readWord(ctx);
      this.assignValue = false;
      if (!w) continue;
      if (atStart && cur.items.length === 0 && !w.quoted) {
        if (stop && stop.has(w.raw)) {
          flush();
          return { stopped: w.raw };
        }
        if (RESERVED.has(w.raw)) {
          const r = this.reserved(w, cur, ctx);
          if (r === "construct") { haveCmd = true; expect = null; atStart = false; continue; }
          if (r === "syntax") { atStart = true; continue; }
          if (r === "command") { atStart = false; continue; }
        }
      }
      cur.items.push({ type: "word", word: w, assign: wasAssign && ASSIGN.test(w.raw) });
      if (!(wasAssign && ASSIGN.test(w.raw))) atStart = false;
    }
    flush();
    if (expect) this.fail(`"${expect}" with nothing after it`);
    return { stopped: null };
  }

  // ---------------------------------------------------------------------------------------------
  // Reserved words and compound commands
  // ---------------------------------------------------------------------------------------------

  /**
   * "construct": a whole compound command was read; "syntax": a word that is only syntax ({ } ! then
   * do ...); "command": the words were added to the current command ([[ ... ]]); undefined: not special.
   */
  reserved(w, cur, ctx) {
    switch (w.raw) {
      case "if": case "elif": {
        const r = this.sequence({ ctx: [...ctx, "if"], close: false, stop: new Set(["then"]) });
        if (r.stopped === "then") this.thenPart(ctx);
        return "construct";
      }
      case "while": case "until": {
        const r = this.sequence({ ctx: [...ctx, "while"], close: false, stop: new Set(["do"]) });
        if (r.stopped === "do") this.sequence({ ctx: [...ctx, "while"], close: false, stop: new Set(["done"]) });
        return "construct";
      }
      case "for": case "select": {
        this.forHeader(ctx);
        return "construct";
      }
      case "case": {
        this.issue("case");
        this.caseBody(ctx);
        return "construct";
      }
      case "function": {
        this.issue("function");
        this.skipBlanks();
        this.readWord(ctx);
        this.skipBlanks();
        if (this.peek() === "(" && this.peek(1) === ")") this.i += 2;
        return "syntax";
      }
      case "{": {
        this.issue("brace-group");
        return "syntax";
      }
      case "}": return "construct";
      case "then": case "do": case "else": case "fi": case "done": case "esac": case "!": return "syntax";
      case "coproc": this.issue("function"); return "syntax";
      case "[[": {
        cur.items.push({ type: "word", word: w });
        for (;;) {
          this.tick();
          this.skipBlanks();
          const ch = this.peek();
          if (ch === undefined || ch === "\n") break;
          if (ch === "&" && this.peek(1) === "&") { cur.items.push({ type: "word", word: this.fake("&&") }); this.i += 2; continue; }
          if (ch === "|" && this.peek(1) === "|") { cur.items.push({ type: "word", word: this.fake("||") }); this.i += 2; continue; }
          if (ch === ";" || ch === "&" || ch === "|") break;
          if (ch === "(" || ch === ")") { cur.items.push({ type: "word", word: this.fake(ch) }); this.i++; continue; }
          const x = this.readWord(ctx);
          if (!x) break;
          cur.items.push({ type: "word", word: x });
          if (x.raw === "]]") break;
        }
        return "command";
      }
      default: return undefined;
    }
  }

  fake(raw) {
    return { raw, value: raw, start: this.i, end: this.i + raw.length, dynamic: false, quoted: false };
  }

  thenPart(ctx) {
    const r = this.sequence({ ctx: [...ctx, "if"], close: false, stop: new Set(["elif", "else", "fi"]) });
    if (r.stopped === "elif") {
      const r2 = this.sequence({ ctx: [...ctx, "if"], close: false, stop: new Set(["then"]) });
      if (r2.stopped === "then") this.thenPart(ctx);
    } else if (r.stopped === "else") {
      this.sequence({ ctx: [...ctx, "if"], close: false, stop: new Set(["fi"]) });
    }
  }

  /** for NAME in WORDS ; do BODY ; done -- the header is words, not commands. */
  forHeader(ctx) {
    this.skipBlanks();
    this.readWord(ctx);
    this.skipBlanks();
    if (this.src.startsWith("in", this.i) && (isSpace(this.src[this.i + 2]) || this.src[this.i + 2] === "\n" || this.src[this.i + 2] === ";")) {
      this.i += 2;
      for (;;) {
        this.tick();
        this.skipBlanks();
        const ch = this.peek();
        if (ch === undefined || ch === ";" || ch === "\n" || ch === "#") break;
        if (!this.readWord(ctx)) break;
      }
    }
    for (;;) {
      this.tick();
      this.skipBlanks();
      const ch = this.peek();
      if (ch === ";" || ch === "\n") { this.i++; if (ch === "\n" && this.pending.length) this.readHeredocBodies(); continue; }
      break;
    }
    if (this.src.startsWith("do", this.i) && !isNameChar(this.src[this.i + 2])) {
      this.i += 2;
      this.sequence({ ctx: [...ctx, "for"], close: false, stop: new Set(["done"]) });
    }
  }

  /** case WORD in pattern) commands ;; ... esac -- read the commands, ignore the patterns. */
  caseBody(ctx) {
    this.skipBlanks();
    this.readWord(ctx); // the subject
    this.skipBlanks();
    if (this.src.startsWith("in", this.i)) this.i += 2;
    for (let guard = 0; guard < 10000; guard++) {
      this.tick();
      this.skipBlanks();
      if (this.i >= this.src.length) return;
      const ch = this.peek();
      if (ch === "\n" || ch === ";") { this.i++; continue; }
      if (/^esac\b/.test(this.src.slice(this.i, this.i + 5))) { this.i += 4; return; }
      // the pattern list, up to its ")"
      if (ch === "(") this.i++;
      while (this.i < this.src.length && this.peek() !== ")") {
        this.tick();
        if (this.peek() === "|" || isSpace(this.peek())) { this.i++; continue; }
        if (!this.readWord(ctx)) this.i++;
      }
      if (this.peek() === ")") this.i++;
      const r = this.sequence({ ctx: [...ctx, "case"], close: false, stop: new Set(["esac", ";;"]) });
      if (r.stopped === "esac" || r.stopped === null) return;
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Words
  // ---------------------------------------------------------------------------------------------

  skipArithmetic() {
    let depth = 1;
    while (this.i < this.src.length && depth > 0) {
      const c = this.src[this.i];
      if (c === "(") depth++;
      else if (c === ")") depth--;
      this.i++;
    }
    if (this.src[this.i] === ")") this.i++;
  }

  /**
   * Read one word starting at this.i. Handles quotes, escapes, $( ), backticks, ${ }, $VAR and
   * process substitution, and records an issue for each one Claude Code cannot check.
   */
  readWord(ctx) {
    const src = this.src;
    const start = this.i;
    const assignValue = this.assignValue;
    let value = "";
    let quoted = false;
    let dynamic = false;
    let braceDepth = 0;
    let braceSep = false;
    let braceExpansion = false;
    while (this.i < src.length) {
      this.tick();
      const c = src[this.i];
      if (isSpace(c) || c === "\n" || c === ";" || c === ")" || c === "|" || c === "&" || c === "(") break;
      if (c === "<" || c === ">") {
        if (src[this.i + 1] === "(") {
          this.i += 2;
          this.sequence({ ctx: [...ctx, "substitution"], close: true });
          if (src[this.i - 1] !== ")") this.fail("a process substitution with no closing )");
          this.issue("process-substitution");
          dynamic = true;
          continue;
        }
        break;
      }
      if (c === "\\") {
        const n = src[this.i + 1];
        if (n === undefined) { this.fail("a backslash at the end of the command"); this.i++; break; }
        if (n === "\n") { this.issue("escaped-whitespace"); this.i += 2; continue; }
        if (n === " " || n === "\t") this.issue("escaped-whitespace");
        quoted = true;
        value += n;
        this.i += 2;
        continue;
      }
      if (c === "'") {
        quoted = true;
        const end = src.indexOf("'", this.i + 1);
        if (end === -1) { value += src.slice(this.i + 1); this.i = src.length; break; }
        value += src.slice(this.i + 1, end);
        this.i = end + 1;
        continue;
      }
      if (c === '"') {
        quoted = true;
        this.i++;
        value += this.doubleQuoted(ctx, () => { dynamic = true; });
        continue;
      }
      if (c === "`") {
        this.i++;
        let j = this.i;
        while (j < src.length && src[j] !== "`") j += src[j] === "\\" ? 2 : 1;
        const body = src.slice(this.i, j).replace(/\\([`\\$])/g, "$1");
        this.i = Math.min(j + 1, src.length);
        const made = this.cmds.length;
        this.backtick(body, ctx);
        if (assignValue) for (const inner of this.cmds.slice(made)) inner.needsRule = true;
        else this.issue("substitution");
        dynamic = true;
        continue;
      }
      if (c === "$") {
        const n = src[this.i + 1];
        if (n === "(" && src[this.i + 2] === "(") {
          this.i += 3;
          this.skipArithmetic();
          continue;
        }
        if (n === "(") {
          this.i += 2;
          const before = this.cmds.length;
          this.sequence({ ctx: [...ctx, "substitution"], close: true });
          if (src[this.i - 1] !== ")") this.fail("a $( with no matching )");
          this.afterSubstitution(before, false, assignValue);
          dynamic = true;
          continue;
        }
        if (n === "{") {
          this.i = this.skipBraces(this.i + 2);
          this.issue("braced-variable");
          dynamic = true;
          continue;
        }
        if (n === '"') {
          this.issue("locale-quote");
          this.i++; // the $ goes, the string is read as an ordinary double-quoted one
          continue;
        }
        if (n === "'") {
          this.issue("ansi-c-quote");
          quoted = true;
          let j = this.i + 2;
          let text = "";
          while (j < src.length && src[j] !== "'") {
            if (src[j] === "\\") { text += src[j + 1] ?? ""; j += 2; } else { text += src[j]; j++; }
          }
          value += text;
          this.i = Math.min(j + 1, src.length);
          continue;
        }
        const v = this.variableAt(this.i);
        if (v) {
          if (!SAFE_VARIABLES.has(v.name)) this.issue("variable", `$${v.name}`);
          value += `$${v.name}`;
          this.i = v.end;
          dynamic = true;
          continue;
        }
        value += c;
        this.i++;
        continue;
      }
      if (c === "{") braceDepth++;
      else if (c === "}" && braceDepth > 0) { braceDepth--; if (braceSep && braceDepth === 0) braceExpansion = true; }
      else if (braceDepth > 0 && (c === "," || (c === "." && src[this.i + 1] === "."))) braceSep = true;
      value += c;
      this.i++;
    }
    if (this.i === start) {
      if (this.i < src.length && !isSpace(src[this.i]) && src[this.i] !== "\n") this.i++;
      return null;
    }
    if (braceExpansion) this.issue("brace-expansion");
    return { raw: src.slice(start, this.i), value, start, end: this.i, dynamic, quoted };
  }

  /** $name, $1, $@ ... at index i (which holds the "$"): { name, end } or null. */
  variableAt(i) {
    const n = this.src[i + 1];
    if (isNameStart(n)) {
      let j = i + 1;
      while (isNameChar(this.src[j])) j++;
      return { name: this.src.slice(i + 1, j), end: j };
    }
    if (isDigit(n) || (n !== undefined && "@*#?$!-".includes(n))) return { name: n, end: i + 2 };
    return null;
  }

  /** Inside "...": variables, $( ) and backticks are live; everything else is text. */
  doubleQuoted(ctx, markDynamic) {
    const src = this.src;
    let text = "";
    while (this.i < src.length) {
      this.tick();
      const c = src[this.i];
      if (c === '"') { this.i++; return text; }
      if (c === "\\") {
        const n = src[this.i + 1];
        if (n === undefined) { this.i++; return text; }
        if (n === "\n") { this.issue("escaped-whitespace"); this.i += 2; continue; }
        if ('"\\$`'.includes(n)) { text += n; this.i += 2; continue; }
        text += c;
        this.i++;
        continue;
      }
      if (c === "`") {
        this.i++;
        let j = this.i;
        while (j < src.length && src[j] !== "`") j += src[j] === "\\" ? 2 : 1;
        const body = src.slice(this.i, j).replace(/\\([`\\$])/g, "$1");
        this.i = Math.min(j + 1, src.length);
        this.backtick(body, ctx);
        this.issue("quoted-substitution");
        markDynamic();
        continue;
      }
      if (c === "$") {
        const n = src[this.i + 1];
        if (n === "(" && src[this.i + 2] === "(") {
          this.i += 3;
          this.skipArithmetic();
          continue;
        }
        if (n === "(") {
          this.i += 2;
          const before = this.cmds.length;
          this.sequence({ ctx: [...ctx, "substitution"], close: true });
          if (src[this.i - 1] !== ")") this.fail("a $( with no matching )");
          this.afterSubstitution(before, true, false);
          markDynamic();
          continue;
        }
        if (n === "{") {
          this.i = this.skipBraces(this.i + 2);
          this.issue("braced-variable");
          markDynamic();
          continue;
        }
        const v = this.variableAt(this.i);
        if (v) {
          if (!SAFE_VARIABLES.has(v.name)) this.issue("variable", `$${v.name}`);
          text += `$${v.name}`;
          this.i = v.end;
          markDynamic();
          continue;
        }
      }
      text += c;
      this.i++;
    }
    return text;
  }

  /**
   * A $( ) just ended. Claude Code lets one shape through unchecked: a quoted heredoc that only
   * feeds cat, inside double quotes, as in git commit -m "$(cat <<'EOF' ... EOF)". Anything else
   * cannot be checked before it runs, except the value of a plain VAR=$(command) assignment, where
   * the command inside is judged on its own.
   */
  afterSubstitution(cmdsBefore, quotedContext, assignValue) {
    const added = this.cmds.slice(cmdsBefore);
    if (quotedContext && added.length === 1 && isCatHeredoc(added[0])) {
      added[0].inert = true; // not judged by allow rules, but deny and ask rules still see it
      return;
    }
    if (assignValue && !quotedContext) {
      for (const c of added) c.needsRule = true;
      return;
    }
    this.issue(quotedContext ? "quoted-substitution" : "substitution");
  }

  /** The commands inside backticks are read as a run of their own and merged. */
  backtick(body, ctx) {
    const inner = new Reader(body);
    inner.sequence({ ctx: [...ctx, "substitution"], close: false });
    for (const c of inner.cmds) this.cmds.push(c);
    for (const is of inner.issues) this.issue(is.kind);
    if (inner.problem) this.fail(inner.problem);
  }

  /** this.i is just after "${"; return the index after the matching "}". */
  skipBraces(i) {
    let depth = 1;
    const src = this.src;
    while (i < src.length) {
      const c = src[i];
      if (c === "\\") { i += 2; continue; }
      if (c === "'") { const e = src.indexOf("'", i + 1); i = e === -1 ? src.length : e + 1; continue; }
      if (c === '"') { i++; while (i < src.length && src[i] !== '"') i += src[i] === "\\" ? 2 : 1; i++; continue; }
      if (c === "{") depth++;
      if (c === "}") { depth--; if (depth === 0) return i + 1; }
      i++;
    }
    return src.length;
  }

  // ---------------------------------------------------------------------------------------------
  // Redirections and heredocs
  // ---------------------------------------------------------------------------------------------

  /** Is the digit run at this.i the file descriptor of a redirection, as in 2>&1? */
  redirectAhead() {
    let j = this.i;
    while (isDigit(this.src[j])) j++;
    if (this.src[j] !== ">" && this.src[j] !== "<") return false;
    const prev = this.src[this.i - 1];
    return prev === undefined || isSpace(prev) || prev === "\n" || ";&|()".includes(prev);
  }

  readRedirect(cur, ctx) {
    const src = this.src;
    const start = this.i;
    let fd = null;
    while (isDigit(src[this.i])) { fd = (fd || "") + src[this.i]; this.i++; }
    let op;
    if (src[this.i] === "&" && src[this.i + 1] === ">") op = src[this.i + 2] === ">" ? "&>>" : "&>";
    else if (src[this.i] === "<") {
      op = ["<<<", "<<-", "<<", "<&", "<>"].find((o) => src.startsWith(o, this.i)) || "<";
    } else {
      op = [">>", ">&", ">|"].find((o) => src.startsWith(o, this.i)) || ">";
    }
    this.i += op.length;
    this.skipBlanks();
    const target = this.readWord(ctx);
    if (!target) { this.fail(`a redirection "${op}" with no target`); return; }
    const r = { op, fd, target, start, end: this.i };
    if (op === "<<" || op === "<<-") {
      r.heredoc = true;
      r.strip = op === "<<-";
      r.quotedDelimiter = target.quoted;
      this.pending.push({ redir: r, delimiter: target.value, strip: r.strip });
      if (!target.quoted) this.issue("heredoc");
      this.heredocLine = true;
    }
    cur.items.push({ type: "redir", redir: r });
  }

  /** Consume the bodies of the heredocs started on the line that just ended. */
  readHeredocBodies() {
    const src = this.src;
    for (const h of this.pending) {
      let found = false;
      let body = "";
      while (this.i < src.length) {
        this.tick();
        let eol = src.indexOf("\n", this.i);
        if (eol === -1) eol = src.length;
        const line = src.slice(this.i, eol);
        const cmp = h.strip ? line.replace(/^\t+/, "") : line;
        this.i = Math.min(eol + 1, src.length);
        if (cmp === h.delimiter) { found = true; break; }
        body += `${line}\n`;
      }
      h.redir.body = body;
    }
    this.pending = [];
  }

  // ---------------------------------------------------------------------------------------------
  // Turning a run of words into a command
  // ---------------------------------------------------------------------------------------------

  emit(cur, ctx) {
    const argv = [];
    const assigns = [];
    const redirs = [];
    for (const it of cur.items) {
      if (it.type === "redir") redirs.push(it.redir);
      else if (it.assign) assigns.push(it.word);
      else argv.push(it.word);
    }
    const spans = cur.items.filter((it) => it.type === "word").map((it) => it.word);
    if (!spans.length) {
      this.cmds.push({ text: "", argv: [], assigns: [], redirs, cut: redirs, ctx, start: 0, end: 0, src: this.src });
      return;
    }
    const firstWord = Math.min(...spans.map((w) => w.start));
    const lastWord = Math.max(...spans.map((w) => w.end));
    // Claude Code takes redirections out of the text a rule sees, but not a here-string, and not one in front of the command
    const kept = redirs.filter((r) => r.op === "<<<" || r.start < firstWord);
    const cut = redirs.filter((r) => !kept.includes(r));
    const start = Math.min(firstWord, ...kept.map((r) => r.start));
    const end = Math.max(lastWord, ...kept.map((r) => r.end));
    const cmd = { text: "", argv, assigns, redirs, cut, ctx, start, end, src: this.src };
    cmd.text = cutText(this.src, start, end, cut).trim();
    this.cmds.push(cmd);
    if (!argv.length && assigns.length > 1) this.issue("multiple-assignments");
    if (!argv.length && assigns.length && ctx.length) this.issue("nested-assignment");
    if (argv.length && !argv[0].quoted && EVAL_BUILTINS.has(argv[0].value)) this.issue("eval", argv[0].value);
    if (argv.length && argv[0].value === "[" && redirs.length) this.issue("test-brackets");
  }
}

function isCatHeredoc(cmd) {
  return cmd.argv.length === 1 && cmd.argv[0].value === "cat" && cmd.assigns.length === 0 && cmd.redirs.length === 1 && cmd.redirs[0].heredoc === true && cmd.redirs[0].quotedDelimiter === true && !cmd.redirs[0].strip;
}

/** The text of src[start, end) with the given redirections taken out. */
function cutText(src, start, end, redirs) {
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

/**
 * The text of a command from word `from` on, with redirections taken out: what a rule is matched
 * against once a wrapper or an assignment has been stripped off the front. With includeAssigns the
 * leading VAR=value words stay.
 */
export function textFrom(cmd, from = 0, includeAssigns = false) {
  const first = cmd.argv[from];
  if (!first) return "";
  let start = from === 0 ? cmd.start : first.start; // from 0, a redirection in front of the command stays in the text
  if (includeAssigns && cmd.assigns.length) start = Math.min(start, cmd.assigns[0].start);
  return cutText(cmd.src, start, cmd.end, cmd.cut || cmd.redirs).trim();
}
