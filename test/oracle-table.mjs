// The table behind two tests:
//
//   test/table.test.mjs   no binary needed: what `why` says for each row must equal `expect`;
//   test/oracle.test.mjs  with E2E_CLAUDE set: what the real Claude Code binary does with the same
//                         row (fake model API, `-p`, default permission mode) must equal `expect` too.
//
// A row is one tool call under one set of settings files. `expect` is what Claude Code does with it:
//   "allow"  it runs without a prompt
//   "ask"    it needs approval (`claude -p` cannot ask, so it is refused and listed under permission_denials)
//   "deny"   a deny rule refuses it
// Every row that is here was run against Claude Code 2.1.295; a row whose result surprised us says why in `note`.
//
// A row may carry `platform` (the oracle runs it only there: the PowerShell tool is Windows-only here) and
// `engine` (test/table.test.mjs runs it only on that system, because how Windows reads a path is its subject).
//
// Placeholders in strings: {WORK} the folder Claude starts in, {HOME} the home folder, {ROOT} the folder that
// holds both, {CFG} Claude's config folder; add _POSIX for the form a rule or a Git Bash command uses
// (/c/Users/... on Windows). Every row also gets the files listed in DEFAULT_FILES in {WORK}.
//
// Commands that these rows can run, because a rule allows them, only touch the throwaway {WORK} folder:
// `mytool` and `othertool` do not exist (the shell answers "command not found"), the rest only read.

import { denyRows } from "./path-table.mjs";

export const DEFAULT_FILES = {
  "a.txt": "hello\n",
  "b.txt": "world\n",
  "a.json": "{\"name\":\"x\"}\n",
  "sub/a.txt": "hello\n",
  "src/a.ts": "hello\n",
};

export const rows = [];

/** "allow Bash(ls *)" -> { allow: ["Bash(ls *)"] } */
function ruleSet(spec) {
  const out = {};
  for (const s of [].concat(spec || [])) {
    const m = /^(allow|ask|deny) ([^]+)$/.exec(s);
    if (!m) throw new Error(`bad rule spec: ${s}`);
    (out[m[1]] ||= []).push(m[2]);
  }
  return out;
}

/** spec: "allow Bash(x)" | ["allow ...", "deny ..."] | { user, project, local, dirs } (each of the first three like the first two) */
function settingsFor(spec) {
  const files = spec && !Array.isArray(spec) && typeof spec === "object" ? spec : { user: spec };
  const settings = {};
  for (const where of ["user", "project", "local"]) {
    if (files[where] === undefined && where !== "user") continue;
    const permissions = ruleSet(files[where]);
    if (where === "user" && files.dirs) permissions.additionalDirectories = files.dirs;
    // WebFetch would ask api.anthropic.com about the host before fetching it, without this
    settings[where] = where === "user" ? { skipWebFetchPreflight: true, permissions } : { permissions };
  }
  return settings;
}

let count = 0;
function add(group, tool, input, spec, expect, extra = {}) {
  const { files, ...rest } = extra;
  rows.push({ id: `${group}-${String(++count).padStart(3, "0")}`, group, tool, input, settings: settingsFor(spec), expect, files: { ...DEFAULT_FILES, ...(files || {}) }, ...rest });
}
const bash = (group, spec, command, expect, extra) => add(group, "Bash", { command }, spec, expect, extra);
const ps = (group, spec, command, expect, extra) => add(group, "PowerShell", { command }, spec, expect, { platform: "win32", ...extra });
const read = (group, spec, file, expect, extra) => add(group, "Read", { file_path: file }, spec, expect, extra);
const edit = (group, spec, file, expect, extra) => add(group, "Edit", { file_path: file, old_string: "hello", new_string: "hullo" }, spec, expect, extra);
const write = (group, spec, file, expect, extra) => add(group, "Write", { file_path: file, content: "x" }, spec, expect, extra);
const fetch = (group, spec, url, expect, extra) => add(group, "WebFetch", { url, prompt: "p" }, spec, expect, extra);
const each = (group, spec, list, extra) => { for (const [command, expect] of list) bash(group, spec, command, expect, extra); };

const MT = "allow Bash(mytool *)";

// --- allow rules: exact, prefix, wildcard -------------------------------------------------------------------
each("exact", "allow Bash(mytool deploy)", [["mytool deploy", "allow"], ["mytool deploy --prod", "ask"], ["mytool", "ask"], ["mytool  deploy", "ask"], ["mytool deployx", "ask"]]);
each("wildcard", MT, [["mytool", "allow"], ["mytool deploy --prod", "allow"], ["mytool  deploy", "allow"], ["mytool \"two words\"", "allow"], ["mytoolx", "ask"], ["othertool a", "ask"], ["MYTOOL a", "ask"]]);
each("prefix", "allow Bash(mytool:*)", [["mytool", "allow"], ["mytool a b", "allow"], ["mytoolx a", "ask"], ["othertool a", "ask"]]);
each("prefix", "allow Bash(mytool a:*)", [["mytool a", "allow"], ["mytool a b", "allow"], ["mytool ab", "ask"], ["mytool b", "ask"]]);
each("glob-end", "allow Bash(mytool*)", [["mytoolx deploy", "allow"], ["mytool", "allow"], ["mytool a", "allow"], ["mytoo a", "ask"]]);
each("leading-star", "allow Bash(* --version)", [["mytool --version", "allow"], ["mytool -v", "ask"], ["mytool --version --verbose", "ask"]]);
each("middle-star", "allow Bash(mytool * main)", [["mytool a b main", "allow"], ["mytool main", "ask"], ["mytool a main x", "ask"]]);
each("trailing-star", "allow Bash(mytool deploy *)", [["mytool deploy", "allow"], ["mytool deploy prod", "allow"], ["mytool deployx", "ask"], ["mytool", "ask"]]);
each("escaped-star", "allow Bash(mytool \\*)", [["mytool \\*", "allow"], ["mytool x", "ask"]]);
each("double-star", "allow Bash(mytool **)", [["mytool x", "allow"], ["mytool", "ask"]], { note: "** is a plain * here, and without the space before it the bare command does not match" });
each("subcommand-star", "allow Bash(git * main)", [["git checkout main", "allow"], ["git -c core.pager=x checkout main", "allow"], ["git checkout dev", "ask"]], { note: "a * before the rest of the command: Claude Code warns at startup because the rule also matches git options such as -c; it does allow the command" });

// --- compound commands: every part needs a rule --------------------------------------------------------------
each("compound", MT, [
  ["mytool a && mytool b", "allow"], ["mytool a || mytool b", "allow"], ["mytool a ; mytool b", "allow"], ["mytool a | mytool b", "allow"],
  ["mytool a |& mytool b", "allow"], ["mytool a\nmytool b", "allow"], ["mytool a;", "allow"], ["mytool a && mytool b && mytool c", "allow"],
  ["mytool a && othertool b", "ask"], ["othertool b && mytool a", "ask"], ["mytool a ; othertool b", "ask"], ["mytool a | othertool", "ask"],
  ["mytool a || othertool", "ask"], ["mytool a\nothertool b", "ask"], ["mytool a |& othertool", "ask"],
  ["mytool a &", "ask"], ["mytool a & mytool b", "ask"], ["mytool a &&", "ask"], ["&& mytool a", "ask"],
  ["mytool 'a && b'", "allow"], ["mytool \"a ; b\"", "allow"], ["mytool a # othertool b", "allow"], ["mytool \"a\nb\"", "allow"],
]);

// --- deny and ask rules see every part, also inside substitutions and behind wrappers ---------------------------
const DENY_RM = ["allow Bash(mytool *)", "deny Bash(rm *)"];
each("deny-part", DENY_RM, [
  ["rm nothing", "deny"], ["rm", "deny"], ["mytool a && rm nothing", "deny"], ["rm nothing && mytool a", "deny"], ["mytool a ; rm nothing", "deny"],
  ["mytool a | rm nothing", "deny"], ["mytool a || rm nothing", "deny"], ["mytool a\nrm nothing", "deny"], ["mytool a & rm nothing", "deny"],
  ["echo $(rm nothing)", "deny"], ["echo `rm nothing`", "deny"], ["(rm nothing)", "deny"], ["{ rm nothing; }", "deny"],
  ["if true; then rm nothing; fi", "deny"], ["for i in 1; do rm nothing; done", "deny"], ["echo ok | (rm nothing)", "deny"],
  ["rmdir nothing", "ask"], ["/bin/rm nothing", "ask"], ["mytool a", "allow"],
]);
each("deny-wrapper", DENY_RM, [
  ["sudo rm nothing", "deny"], ["env rm nothing", "deny"], ["env FOO=1 rm nothing", "deny"], ["timeout 5 rm nothing", "deny"], ["nice rm nothing", "deny"],
  ["nohup rm nothing", "deny"], ["time rm nothing", "deny"], ["FOO=1 rm nothing", "deny"], ["exec rm nothing", "deny"], ["command rm nothing", "deny"],
  ["echo x | xargs rm", "deny"], ["stdbuf -oL rm nothing", "deny"], ["setsid rm nothing", "deny"], ["doas rm nothing", "deny"], ["watch rm nothing", "deny"],
  ["flock f rm nothing", "deny"], ["ionice rm nothing", "deny"], ["strace rm nothing", "deny"],
  ["\"rm\" nothing", "deny"], ["'rm' nothing", "deny"], ["\\rm nothing", "deny"],
  ["bash -c 'rm nothing'", "ask"], ["sh -c \"rm nothing\"", "ask"], ["bash -c 'echo hi'", "ask"],
], { note: "deny and ask rules look through more wrappers than allow rules; a shell -c script is not searched, except that a deny rule matching rm inside it makes it ask" });
each("ask-part", ["allow Bash(git *)", "ask Bash(git push *)"], [
  ["git push origin", "ask"], ["git push", "ask"], ["git status", "allow"], ["git commit -m x", "allow"], ["git status && git push", "ask"],
  ["echo $(git push)", "ask"], ["sudo git push", "ask"], ["git pull", "allow"], ["FOO=1 git push", "ask"],
]);
each("ask-readonly", "ask Bash(ls *)", [["ls", "ask"], ["ls -la", "ask"], ["cat a.txt", "allow"], ["echo hi | ls", "ask"]]);
each("deny-readonly", "deny Bash(cat *)", [["cat a.txt", "deny"], ["echo hi | cat", "deny"], ["ls", "allow"], ["head -1 a.txt", "allow"]]);
each("deny-narrow", ["allow Bash(mytool *)", "deny Bash(mytool danger *)"], [["mytool danger x", "deny"], ["mytool danger", "deny"], ["mytool safe x", "allow"], ["mytool a && mytool danger", "deny"]]);

// --- wrappers: what an allow rule sees through ----------------------------------------------------------------
each("wrapper-allow", MT, [
  ["timeout 5 mytool a", "allow"], ["timeout -s KILL 5 mytool a", "allow"], ["timeout --signal=KILL 5s mytool a", "allow"], ["nice mytool a", "allow"],
  ["nice -n 5 mytool a", "allow"], ["nohup mytool a", "allow"], ["time mytool a", "allow"], ["stdbuf -oL mytool a", "allow"], ["command mytool a", "allow"],
  ["nice -n 5 timeout 3 mytool a", "allow"], ["echo a | xargs mytool b", "allow"],
  ["env mytool a", "ask"], ["sudo mytool a", "ask"], ["watch mytool a", "ask"], ["exec mytool a", "ask"], ["setsid mytool a", "ask"], ["flock f mytool a", "ask"],
  ["timeout mytool a", "ask"], ["timeout --weird 5 mytool a", "ask"], ["FOO=1 mytool a", "ask"], ["bash -c 'mytool a'", "ask"],
]);
for (const name of [
  "GOEXPERIMENT", "GOOS", "GOARCH", "CGO_ENABLED", "GO111MODULE", "RUST_BACKTRACE", "RUST_LOG", "NODE_ENV", "PYTHONUNBUFFERED", "PYTHONDONTWRITEBYTECODE",
  "PYTEST_DISABLE_PLUGIN_AUTOLOAD", "PYTEST_DEBUG", "ANTHROPIC_API_KEY", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "LC_TIME", "CHARSET", "TERM", "COLORTERM",
  "NO_COLOR", "FORCE_COLOR", "TZ", "LS_COLORS", "LSCOLORS", "GREP_COLOR", "GREP_COLORS", "GCC_COLORS", "TIME_STYLE", "BLOCK_SIZE", "BLOCKSIZE", "COLUMNS",
  "LINES", "CLICOLOR", "CLICOLOR_FORCE", "CI", "DEBIAN_FRONTEND", "GIT_TERMINAL_PROMPT",
]) bash("env-safe", MT, `${name}=1 mytool a`, "allow");
for (const name of ["FOO", "PATH", "HOME", "LD_PRELOAD", "NODE_OPTIONS", "PYTHONPATH", "GIT_DIR", "EDITOR", "SHELL", "USER", "LC_MESSAGES", "NODE_PATH"]) bash("env-unsafe", MT, `${name}=1 mytool a`, "ask");
each("env-mixed", MT, [["NODE_ENV=test CI=1 mytool a", "allow"], ["NODE_ENV=test FOO=1 mytool a", "ask"], ["FOO=1 NODE_ENV=test mytool a", "ask"], ["NODE_ENV=test timeout 5 mytool a", "allow"]]);

// --- substitutions, subshells, variables: allow rules do not reach inside ---------------------------------------
each("cannot-check", ["allow Bash(mytool *)", "allow Bash(echo *)"], [
  ["echo $(mytool a)", "ask"], ["echo `mytool a`", "ask"], ["(mytool a)", "ask"], ["{ mytool a; }", "ask"], ["echo <(mytool a)", "ask"],
  ["mytool a $(echo b)", "ask"], ["mytool \"$(echo b)\"", "ask"], ["mytool $HOME", "allow"], ["mytool $HOME/x", "allow"], ["mytool \"$HOME/x\"", "allow"], ["mytool $FOO", "ask"], ["mytool $PWD", "ask"], ["mytool $USER", "ask"], ["mytool $1", "ask"], ["mytool \"a $FOO\"", "ask"], ["mytool '$FOO'", "allow"], ["mytool ${HOME}", "ask"], ["echo $((1 + 2))", "allow"],
  ["mytool a{b,c}", "ask"], ["mytool $'x y'", "ask"], ["mytool \"a\" $'b'", "ask"], ["echo $'x'", "ask"], ["echo $\"x\"", "ask"], ["echo \"$'x'\"", "allow"], ["mytool 'a'\"b\"", "allow"], ["echo hi", "allow"],
]);
bash("compound", MT, "mytool a |", "allow", { note: "a trailing | is not a parse failure for Claude Code, a trailing && is" });
each("compound-statements", MT, [
  ["if true; then mytool a; fi", "allow"], ["for i in 1 2; do mytool a; done", "allow"], ["for i in 1 2; do ls; done", "ask"], ["for i in 1 2; do mytool $i; done", "ask"],
]);
bash("heredoc", "allow Bash(git commit *)", "git commit -m \"$(cat <<'EOF'\nmessage\nEOF\n)\"", "allow", { note: "the quoted-heredoc commit message is the one substitution Claude Code can check" });
bash("heredoc", "allow Bash(git commit *)", "git commit -m \"$(date)\"", "ask");
bash("heredoc", "allow Bash(git commit *)", "git commit -m \"$(cat <<EOF\nmessage\nEOF\n)\"", "ask");
bash("exact-line", "allow Bash(echo $(mytool a))", "echo $(mytool a)", "allow", { note: "a rule that spells out the whole line skips the substitution check" });
bash("exact-line", "allow Bash(echo $(mytool a))", "echo $(mytool b)", "ask");

// --- commands that only read need no rule ------------------------------------------------------------------------
each("read-only", null, [
  ["ls", "allow"], ["ls -la", "allow"], ["ls sub", "allow"], ["cat a.txt", "allow"], ["head -2 a.txt", "allow"], ["tail -n 1 a.txt", "allow"], ["wc -l a.txt", "allow"],
  ["echo hi", "allow"], ["pwd", "allow"], ["grep hello a.txt", "allow"], ["grep -rn hello .", "allow"], ["find . -name a.txt", "allow"], ["sort a.txt", "allow"],
  ["diff a.txt b.txt", "allow"], ["stat a.txt", "allow"], ["du -sh .", "allow"], ["which node", "allow"], ["date", "allow"], ["uname", "allow"], ["whoami", "allow"],
  ["id", "allow"], ["hostname", "allow"], ["sed -n 1,2p a.txt", "allow"], ["git status", "allow"], ["git log --oneline -3", "allow"], ["git diff", "allow"],
  ["git branch", "allow"], ["git remote -v", "allow"], ["true", "allow"], ["basename a/b", "allow"], ["cut -d, -f1 a.txt", "allow"], ["file a.txt", "allow"],
  ["cat a.txt | grep h", "allow"], ["ls | head -3", "allow"], ["ls && pwd", "allow"], ["cat a.txt 2>&1", "allow"], ["ls > /dev/null 2>&1", "allow"],
  ["NODE_ENV=test ls", "allow"], ["command ls", "allow"], ["echo \"a && b\"", "allow"],
  ["rm a.txt", "ask"], ["touch c.txt", "ask"], ["mkdir d", "ask"], ["cp a.txt c.txt", "ask"], ["mv a.txt c.txt", "ask"], ["curl http://pd-probe.invalid", "ask"],
  ["git commit -m x", "ask"], ["git push", "ask"], ["git add .", "ask"], ["git checkout main", "ask"], ["git branch newbranch", "ask"], ["git stash", "ask"],
  ["sed -i s/h/j/ a.txt", "ask"], ["sed s/h/j/ a.txt", "ask"], ["sort -o c.txt a.txt", "ask"], ["find . -exec echo x ;", "ask"], ["find . -fprint c.txt", "ask"],
  ["node -e 1", "ask"], ["python3 -c 1", "ask"], ["mytool a", "ask"], ["echo hi > c.txt", "ask"], ["cat a.txt | tee c.txt", "ask"], ["ls ..", "ask"],
  ["cat /etc/hostname", "ask"], ["ls ~", "ask"], ["cat ../x", "ask"], ["for i in 1 2; do echo $i; done", "ask"], ["echo $HOME", "allow"],
]);
each("read-only-flags", null, [
  ["git log --format=%h", "allow"], ["git log -n 3", "allow"], ["git log --graph --oneline --decorate --all", "allow"], ["git diff --stat", "allow"],
  ["git diff --cached", "allow"], ["git status -sb", "allow"], ["git show --stat HEAD", "allow"], ["git tag -l", "allow"], ["git stash list", "allow"],
  ["git config --get user.name", "allow"], ["git rev-parse --show-toplevel", "allow"], ["git ls-files", "allow"], ["git blame a.txt", "allow"],
  ["git log --output=x", "ask"], ["git diff --output=x", "ask"], ["git -c core.pager=x log", "ask"], ["git config user.name x", "ask"], ["git tag v1", "ask"],
  ["git remote add o x", "ask"], ["git stash pop", "ask"], ["git fetch", "ask"], ["git pull", "ask"],
  ["grep --count hello a.txt", "allow"], ["grep -i -e hello a.txt", "allow"], ["find . -type f -name a.txt", "allow"], ["find . -delete", "ask"],
  ["sort -r a.txt", "allow"], ["date -u", "allow"], ["date +%Y", "allow"], ["date -s 2020-01-01", "ask"], ["ps aux", "allow"], ["tree -o c.txt", "ask"],
  ["docker ps", "allow"], ["docker run x", "ask"], ["node --version", "allow"], ["node x.js", "ask"], ["python3 --version", "allow"],
]);

// --- folders: the working folder and --add-dir ----------------------------------------------------------------------
each("folders", null, [
  ["cat {ROOT_POSIX}/outside.txt", "ask"], ["ls {ROOT_POSIX}/extra", "ask"], ["cat {ROOT_POSIX}/extra/a.txt", "ask"], ["cat sub/a.txt", "allow"], ["ls ./sub/../sub", "ask"],
], { files: { "{ROOT}/outside.txt": "o\n", "{ROOT}/extra/a.txt": "e\n" } });
each("folders-extra", { user: null, dirs: ["{ROOT}/extra"] }, [
  ["cat {ROOT_POSIX}/extra/a.txt", "allow"], ["ls {ROOT_POSIX}/extra", "allow"], ["cat {ROOT_POSIX}/outside.txt", "ask"], ["cat sub/a.txt", "allow"],
], { files: { "{ROOT}/outside.txt": "o\n", "{ROOT}/extra/a.txt": "e\n" } });
each("folders-read-rule", "allow Read(/{ROOT_POSIX}/shared/**)", [
  ["cat {ROOT_POSIX}/shared/a.txt", "allow"], ["cat {ROOT_POSIX}/outside.txt", "ask"],
], { files: { "{ROOT}/outside.txt": "o\n", "{ROOT}/shared/a.txt": "s\n" } });
each("folders-wrapper", MT, [["timeout 5 cat ../x", "ask"], ["mytool ../x", "allow"], ["cat ../x", "ask"]], { note: "a folder check applies to the file commands, whatever the Bash rules say" });

// --- cd ------------------------------------------------------------------------------------------------------------
each("cd", MT, [
  ["cd sub", "allow"], ["cd sub && ls", "allow"], ["cd .", "allow"], ["cd .. && ls", "ask"], ["cd sub && cd ..", "ask"], ["cd sub && git status", "ask"],
  ["git status && cd sub", "ask"], ["cd sub && mytool a", "allow"], ["cd sub && echo hi > out.txt", "ask"], ["cd", "ask"], ["cd /", "ask"], ["cd sub && cat a.txt", "allow"],
  ["cd {ROOT_POSIX}", "ask"], ["cd nosuchfolder", "allow"],
]);

// --- paths Claude Code asks about whatever the rules say: a .. after a directory name, a // inside a path ----------------
// The docs do not mention either. For the commands that take file names (ls, cat, head, grep, find, sed, rm, touch,
// mkdir, cp, mv, cd ...) and for redirection targets, a path like sub/../x or a//b is asked about even when a rule
// allows the command; a command that is not a file command (mytool, echo, git) is not looked at for the ..
each("traversal", null, [
  ["ls sub/..", "ask"], ["ls ./sub/..", "ask"], ["ls sub/../sub", "ask"], ["cat sub/../a.txt", "ask"], ["cd sub/..", "ask"], ["ls sub/../..", "ask"],
  ["ls a/../b", "ask"], ["ls sub/./..", "ask"], ["ls ../work/../work", "ask"], ["grep hello sub/../a.txt", "ask"], ["find sub/.. -name x", "ask"],
  ["sed -n 1p sub/../a.txt", "ask"], ["head sub/../a.txt", "ask"], ["ls -la sub/../", "ask"], ["cat \"sub/../a.txt\"", "ask"], ["ls --color=never sub/..", "ask"],
  ["cat < sub/../a.txt", "ask"], ["find . -path \"*/../*\"", "ask"], ["grep -e \"x\" sub/../a.txt", "ask"], ["ls ./sub/../", "ask"], ["ls sub/.. sub", "ask"],
  ["cat a.txt sub/../b.txt", "ask"], ["wc -l sub/../a.txt", "ask"], ["stat sub/../a.txt", "ask"], ["cd sub/.. && ls", "ask"], ["rm sub/../nosuchfile", "ask"],
  ["touch sub/../c1.txt", "ask"], ["timeout 5 cat sub/../a.txt", "ask"],
  ["ls ../work", "allow"], ["ls ./../work", "allow"], ["ls .", "allow"], ["ls ./", "allow"], ["ls sub/./x", "allow"], ["ls ./sub", "allow"], ["cat ./sub/a.txt", "allow"],
  ["ls ..a", "allow"], ["ls a..b", "allow"], ["ls sub/..foo", "allow"], ["ls ...", "allow"], ["ls foo..bar/x", "allow"], ["ls ../work/sub", "allow"],
  ["echo sub/../x", "allow"], ["echo \"a/../b\"", "allow"], ["echo ..", "allow"], ["grep -rn \"..\" .", "allow"], ["grep \"sub/../x\" a.txt", "allow"],
  ["git log -- sub/../a.txt", "allow"], ["git diff HEAD~1..HEAD", "allow"], ["git log main..dev", "allow"], ["ls ../..", "ask"], ["ls ../../work", "ask"],
]);
each("traversal-rule", ["allow Bash(cat *)", "allow Bash(head *)", "allow Bash(cd *)", "allow Bash(find *)", "allow Bash(rm *)", "allow Bash(touch *)", "allow Bash(mkdir *)", "allow Bash(cp *)", "allow Bash(mv *)", "allow Bash(sed *)", "allow Bash(mytool *)", "allow Bash(python3 *)"], [
  ["cat sub/../a.txt", "ask"], ["head sub/../a.txt", "ask"], ["cd sub/..", "ask"], ["find . -path \"*/../*\"", "ask"], ["rm sub/../nosuchfile", "ask"], ["touch sub/../c1.txt", "ask"],
  ["mkdir sub/../d1", "ask"], ["cp a.txt sub/../b2.txt", "ask"], ["mv b.txt sub/../b3.txt", "ask"], ["sed -i s/h/j/ sub/../a.txt", "ask"],
  ["mytool --out sub/../x", "allow"], ["mytool sub/../x", "allow"], ["mytool ../../x", "allow"], ["python3 sub/../x.py", "allow"],
], { note: "an allow rule does not help: the path is asked about; mytool and python3 are not file commands" });
each("traversal-other-rules", "allow Bash", [["cat sub/../a.txt", "allow"]], { note: "a bare Bash allow rule skips the check" });
each("traversal-other-rules", "allow Bash(cat sub/../a.txt)", [["cat sub/../a.txt", "ask"]], { note: "a rule that spells out the whole line does not skip it" });
each("traversal-other-rules", "deny Read(./a.txt)", [["cat a.txt", "deny"], ["cat sub/../a.txt", "ask"]], { note: "the path is asked about before the deny rule gets to judge it" });
each("traversal-other-rules", "allow Read(./sub/**)", [["ls sub/..", "ask"]]);
each("traversal-redirect", ["allow Edit(./x.txt)", "allow Edit(./sub/x.txt)"], [["echo hi > sub/../x.txt", "ask"], ["echo hi > sub//x.txt", "ask"], ["echo hi > sub/./x.txt", "allow"], ["echo hi > sub/x.txt", "allow"]]);
each("double-slash", null, [
  ["ls .//sub", "ask"], ["ls sub///x", "ask"], ["ls //sub", "ask"], ["cat sub//a.txt", "ask"], ["cd sub//x", "ask"], ["ls \"a b//c\"", "ask"], ["ls ..///work", "ask"],
  ["cat .//a.txt", "ask"], ["ls sub/\\/x", "ask"], ["echo a//b", "ask"], ["echo \"a//b\"", "ask"], ["echo //x", "ask"], ["echo \"x\"//y", "ask"], ["printf '%s' a//b", "ask"],
  ["test -f a//b", "ask"], ["grep \"//\" a.txt", "ask"], ["grep -rn \"//\" .", "ask"], ["git log --format=%h//x", "ask"], ["git log --since=1//2", "ask"],
  ["find . -name \"*//*\"", "ask"], ["echo hi | grep \"//\"", "ask"], ["echo \"see https://x.com//a\"", "ask"], ["echo a//b > /dev/null", "ask"],
  ["ls sub//", "allow"], ["ls sub/", "allow"], ["ls ./sub/", "allow"], ["cd sub//", "allow"], ["cd ./sub/", "allow"], ["wc -l sub//", "allow"], ["echo sub//", "allow"],
  ["echo http://x.com", "allow"], ["echo \"http://x.com\"", "allow"], ["jq '.a // 1' a.json", "allow"], ["echo \"a // b\"", "allow"], ["grep -rn 'https://x.com' .", "allow"],
  ["ls a//", "allow"], ["ls ././sub", "allow"], ["cat ./a.txt", "allow"],
], { note: "a // inside a path could be a network share: file commands ask whatever the rules say, other read-only commands stop counting as read-only" });
each("double-slash-rule", ["allow Bash(cat *)", "allow Bash(ls *)", "allow Bash(cd *)", "allow Bash(rm *)", "allow Bash(cp *)", "allow Bash(echo *)", "allow Bash(git log *)", "allow Bash(grep *)", "allow Bash(mytool *)"], [
  ["cat sub//a.txt", "ask"], ["ls sub//x", "ask"], ["cd sub//x", "ask"], ["rm sub//nosuchfile", "ask"], ["cp a.txt sub//b2.txt", "ask"],
  ["echo a//b", "allow"], ["git log --format=%h//x", "allow"], ["grep \"//\" a.txt", "allow"], ["mytool a//b", "allow"], ["mytool sub//x", "allow"],
], { note: "a file command asks about the path whatever the rule says; a rule does cover a // that is not a path argument" });
each("double-slash-rule", "allow Bash(echo a//b)", [["echo a//b", "allow"]]);
each("double-slash-rule", ["allow Bash(mytool *)", "allow Edit(./out.txt)"], [["mytool a//b > out.txt", "allow"]]);

// --- which commands take file names ---------------------------------------------------------------------------------
// ls, cat, grep, find, sed ... have their arguments checked: the working folders, .., //, and the Read deny rules.
// du, df, tree, realpath, readlink, dirname, basename and test are read-only and are not looked at that way.
each("not-path-commands", null, [
  ["du ../x", "allow"], ["du -sh ../x", "allow"], ["tree ../x", "allow"], ["realpath ../x", "allow"], ["readlink -f ../x", "allow"], ["df -h", "allow"], ["du sub/../a.txt", "allow"],
  ["realpath sub//x", "ask"], ["dirname ../x", "allow"], ["basename ../x", "allow"], ["test -f ../x", "allow"], ["fd x", "allow"], ["tree -o c.txt", "ask"],
  ["fd -x echo hi", "ask"], ["fd --exec echo hi", "ask"], ["fd -X echo hi", "ask"],
]);
for (const prog of ["cat", "head", "tail", "wc", "stat", "file", "strings", "hexdump", "od", "nl", "tac", "rev", "fold", "fmt", "expand", "unexpand", "column", "paste", "comm", "cmp", "diff", "cut", "pr", "md5sum", "sha1sum", "sha256sum", "base64", "tsort", "ls", "sort", "uniq"]) {
  bash("path-command-deny", "deny Read(a.txt)", `${prog} a.txt`, "deny");
  bash("path-command-outside", null, `${prog} ../x`, "ask");
}
for (const prog of ["grep x", "egrep x", "fgrep x", "rg x", "jq x", "sed -n 1p"]) {
  bash("path-command-deny", "deny Read(a.txt)", `${prog} a.txt`, "deny");
  bash("path-command-outside", null, `${prog} ../x`, "ask");
}
each("path-command-deny", "deny Read(a.txt)", [
  ["find a.txt -name x", "deny"], ["find . -name a.txt", "allow"], ["find sub a.txt", "deny"], ["find . -newer a.txt", "deny"], ["du a.txt", "allow"], ["tree a.txt", "allow"], ["readlink -f a.txt", "allow"],
  ["touch a.txt", "ask"], ["rm a.txt", "ask"],
]);
each("deny-read-wrapper", "deny Read(a.txt)", [
  ["builtin cat a.txt", "deny"], ["command cat a.txt", "deny"], ["nohup cat a.txt", "deny"], ["timeout 5 cat a.txt", "deny"], ["time cat a.txt", "deny"], ["nice cat a.txt", "deny"],
  ["stdbuf -oL cat a.txt", "deny"], ["env cat a.txt", "deny"], ["FOO=1 cat a.txt", "deny"], ["sudo cat a.txt", "ask"], ["echo x | xargs cat a.txt", "ask"], ["exec cat a.txt", "ask"],
], { note: "the files a command names are found through the short list of wrappers and env, not through sudo, xargs or exec" });
each("wrapper-outside", null, [["env cat ../x", "ask"], ["FOO=1 cat sub/../a.txt", "ask"], ["env cat sub/../a.txt", "ask"], ["sudo cat ../x", "ask"]]);
each("deny-read-dir", "deny Read(./sub/**)", [
  ["ls sub", "deny"], ["ls sub/", "deny"], ["ls ./sub", "deny"], ["cat sub", "deny"], ["grep -r hello sub", "deny"], ["find sub", "deny"], ["ls sub/a.txt", "deny"], ["cat sub/a.txt", "deny"],
  ["ls", "allow"], ["ls src", "allow"], ["du sub", "allow"], ["tree sub", "allow"],
], { note: "dir/** reaches the folder itself, not only what is inside it" });
each("deny-read-dir", "deny Read(./**)", [["ls", "allow"], ["ls .", "allow"], ["cat a.txt", "deny"]], { note: "the working folder itself is never matched" });
each("deny-read-dir", "deny Read(/sub/**)", [["ls sub", "allow"]], { note: "/sub is tied to the folder of the settings file, here the config folder" });
read("read-deny-dir", "deny Read(./sub/**)", "{WORK}/sub", "deny", { note: "the folder itself is reached by dir/**" });
read("read-deny-dir", "deny Read(./sub/**)", "{WORK}/sub/", "deny");
read("read-deny-dir", "deny Read(sub/**)", "{WORK}/sub", "deny");
read("read-deny-dir", "deny Read(sub)", "{WORK}/sub", "deny");
read("read-deny-dir", "deny Read(sub/)", "{WORK}/sub", "allow", { note: "sub/ names folders, and the path given has no trailing slash" });

// --- cd with a redirection or a variable ---------------------------------------------------------------------------
each("cd-redirect", null, [
  ["cd . < a.txt", "ask"], ["cd ./ < a.txt", "ask"], ["cd sub < a.txt", "ask"], ["cd . > out.txt", "ask"], ["cd . > /dev/null", "allow"], ["cd . 2>&1", "allow"], ["cd . 2>/dev/null", "allow"],
  ["cd . && cat < a.txt", "allow"], ["cd sub; ls < a.txt", "ask"], ["echo hi > out.txt; cd .", "ask"], ["cd . ; echo hi > out.txt", "ask"],
  ["git status && cd .", "allow"], ["cd . && git status", "allow"], ["git log; cd .", "allow"], ["TZ=UTC cd .", "allow"], ["TZ=UTC cd sub", "allow"],
  ["TZ=UTC cd . && git status", "ask"], ["NODE_ENV=test cd . && git status", "ask"], ["TZ=UTC cd . < a.txt", "ask"], ["NODE_ENV=test git log --oneline -5; TZ=UTC cd . 2>/dev/null", "ask"],
], { note: "a cd with a variable in front is no longer a plain cd to Claude Code; any cd with an input redirection asks" });

// --- assignments on their own, and a variable in front of a read-only command ---------------------------------------
each("assignments", null, [
  ["x=1", "allow"], ["A=1; B=2", "allow"], ["A=1 B=2", "ask"], ["A=1 B=2 x=1", "ask"], ["A=1 B=2 x=1; ls", "ask"], ["x=1 y=2", "ask"],
  ["if true; then x=1; fi", "ask"], ["if true; then A=1; fi", "ask"], ["if true; then A=1 B=2; fi", "ask"], ["for i in 1; do x=1 y=2; done", "ask"], ["if true; then ls; fi", "allow"],
], { note: "one assignment alone is fine; two in one command, or one inside an if, for or while, is not" });
each("env-prefix-readonly", null, [
  ["NODE_ENV=test test -f a", "allow"], ["NODE_ENV=test echo hi", "allow"], ["NODE_ENV=test ls", "allow"], ["NODE_ENV=test true", "allow"], ["NODE_ENV=test git status", "allow"],
  ["NODE_ENV=test cat a.txt", "allow"], ["NODE_ENV=test date", "allow"], ["NODE_ENV=test uname", "allow"], ["NODE_ENV=test printf hi", "allow"], ["NODE_ENV=test pwd", "allow"],
  ["NODE_ENV=test which node", "allow"], ["NODE_ENV=test basename a", "allow"], ["NODE_ENV=test [[ -f a ]]", "allow"], ["[ -f a ]", "allow"], ["test -f a", "allow"],
  ["NODE_ENV=test [ -f a ]", "ask"], ["CI=1 [ -f a ]", "ask"], ["NODE_ENV=test CI=1 [ -f a ]", "ask"], ["NODE_ENV=test [ -f a ] && git branch -a", "ask"], ["NODE_ENV=test jq . a.json", "ask"],
], { note: "[ and jq lose their read-only status behind a variable; the other read-only commands keep it" });

// --- redirections----------------------------------------------------------------------------------------------------
each("redirect", MT, [["mytool a > out.txt", "ask"], ["mytool a >> out.txt", "ask"], ["mytool a > /dev/null", "allow"], ["mytool a 2>&1", "allow"], ["mytool a 2>/dev/null", "allow"], ["mytool a < a.txt", "allow"], ["mytool a &> out.txt", "ask"]]);
each("redirect-rule", ["allow Bash(mytool *)", "allow Edit(./out.txt)"], [["mytool a > out.txt", "allow"], ["mytool a >> out.txt", "allow"], ["mytool a > other.txt", "ask"], ["echo hi > out.txt", "allow"], ["echo hi > sub/out.txt", "allow"], ["echo hi > sub/other.txt", "ask"]]);
each("redirect-rule", ["allow Bash(mytool *)", "allow Edit(./sub/out.txt)"], [["mytool a > sub/out.txt", "allow"], ["mytool a > out.txt", "ask"], ["mytool a > src/sub/out.txt", "ask"]], { note: "./out.txt has no slash left once the ./ is taken off, so it matches at any depth; ./sub/out.txt is tied to the working folder" });
each("redirect-deny", ["allow Bash(mytool *)", "deny Edit(./out.txt)"], [["mytool a > out.txt", "deny"], ["echo hi > out.txt", "deny"], ["touch out.txt", "deny"], ["cp a.txt out.txt", "deny"], ["rm out.txt", "deny"], ["mkdir d", "ask"], ["echo hi > other.txt", "ask"]]);
each("file-deny", "deny Read(./a.txt)", [
  ["cat a.txt", "deny"], ["grep x a.txt", "deny"], ["head -3 a.txt", "deny"], ["sed -n 1p a.txt", "deny"], ["cat < a.txt", "deny"], ["cat b.txt", "allow"], ["ls", "allow"], ["wc -l a.txt", "deny"],
]);

// --- bare tool rules, exact lines, rules Claude Code skips -------------------------------------------------------------
each("bare-allow", "allow Bash", [["mytool a", "allow"], ["rm nothing", "allow"], ["echo $(mytool a)", "allow"], ["ls &", "ask"], ["mytool a &", "allow"]], { note: "a bare Bash rule allows everything but a line with & that the read-only list or a prefix rule would have allowed" });
each("bare-allow", "allow Bash(*)", [["mytool a", "allow"]]);
each("bare-allow-deny", ["allow Bash", "deny Bash(rm *)"], [["rm nothing", "deny"], ["mytool a", "allow"]]);
each("bare-ask", "ask Bash", [["ls", "ask"], ["echo hi", "ask"], ["mytool a", "ask"]]);
each("bare-deny", "deny Bash", [["echo hi", "deny"], ["mytool a", "deny"]], { note: "a bare deny rule takes the tool away" });
each("skipped-rule", "allow Bash(:*)", [["mytool a", "ask"]], { note: "Claude Code skips this rule (doctor: Invalid settings)" });
each("skipped-rule", "allow bash(mytool *)", [["mytool a", "ask"]]);
each("skipped-rule", "allow Bash(mytool *", [["mytool a", "ask"]]);
each("skipped-rule", "allow Bash(mytool a) x", [["mytool a", "ask"]]);
each("skipped-rule", "allow Bash()", [["mytool a", "ask"]]);
each("skipped-deny", "deny Bash(rm *", [["rm nothing", "ask"]], { note: "a deny rule that is skipped protects nothing" });
each("skipped-deny", "deny bash(rm *)", [["rm nothing", "ask"]]);
each("skipped-deny", "deny Bash(command:rm *)", [["rm nothing", "ask"]], { note: "Claude Code warns at startup that this does not match" });
each("skipped-deny", "deny Bash(rm *)", [["rm nothing", "deny"]]);
each("skipped-allow", "allow Bash(command:mytool *)", [["mytool a", "ask"]]);
each("colon-star", "allow Bash(mytool:* x)", [["mytool:a x", "allow"], ["mytool a x", "ask"], ["mytool", "ask"]], { note: ":* that is not at the end is a wildcard with a literal colon" });
each("colon-and-space", ["allow Bash(mytool:*)", "allow Bash(othertool *)"], [["mytool a", "allow"], ["othertool a", "allow"], ["thirdtool a", "ask"]]);

// --- precedence across files: deny beats ask beats allow, wherever the rule is --------------------------------------------
const P = (spec, command, expect, note) => bash("precedence", spec, command, expect, note ? { note } : {});
P({ user: "deny Bash(mytool *)", project: "allow Bash(mytool *)" }, "mytool a", "deny", "a user deny rule beats a project allow rule");
P({ project: "allow Bash(mytool *)" }, "mytool a", "allow", "positive control: the project allow rule alone allows it");
P({ project: "ask Bash(mytool *)", local: "allow Bash(mytool *)" }, "mytool a", "ask", "a local allow rule does not outrank a project ask rule");
P({ local: "allow Bash(mytool *)" }, "mytool a", "allow", "positive control: the local allow rule alone allows it");
P({ user: "allow Bash(mytool *)", project: "deny Bash(mytool *)" }, "mytool a", "deny");
P({ user: "allow Bash(mytool *)", local: "deny Bash(mytool *)" }, "mytool a", "deny");
P({ user: "ask Bash(mytool *)", project: "allow Bash(mytool *)" }, "mytool a", "ask");
P({ user: "allow Bash(mytool *)", local: "ask Bash(mytool deploy *)" }, "mytool deploy x", "ask");
P({ user: "allow Bash(mytool *)", local: "ask Bash(mytool deploy *)" }, "mytool build", "allow");
P({ user: "allow Bash(mytool *)", project: "deny Bash(mytool b)" }, "mytool a", "allow");
P({ user: "allow Bash(mytool *)", project: "deny Bash(mytool b)" }, "mytool b", "deny");
P({ user: "deny Bash(mytool *)", local: "allow Bash(mytool *)" }, "mytool a", "deny");
P({ user: "allow Bash(mytool *)", project: "allow Bash(mytool *)" }, "mytool a", "allow");
P({ user: "ask Bash(mytool *)", project: "deny Bash(mytool *)" }, "mytool a", "deny", "deny beats ask");
P({ user: "allow Bash(mytool *)", project: "allow Bash(othertool *)" }, "mytool a && othertool b", "allow", "rules from different files cover different parts of one line");
read("precedence", { user: "deny Read(./a.txt)", project: "allow Read(./a.txt)" }, "{WORK}/a.txt", "deny", { note: "a user deny rule beats a project allow rule for files as well" });

// --- Read -----------------------------------------------------------------------------------------------------------------
const OUT = { "{HOME}/notes/a.txt": "n\n", "{HOME}/x.txt": "x\n", "{ROOT}/outside/a.txt": "o\n", "{ROOT}/shared/a.txt": "s\n", "{HOME}/.ssh/id_rsa": "k\n" };
read("read", null, "{WORK}/a.txt", "allow", { note: "a read inside the working folder needs no rule" });
read("read", null, "{WORK}/sub/a.txt", "allow");
read("read", null, "{HOME}/x.txt", "ask", { files: OUT });
read("read", null, "{ROOT}/outside/a.txt", "ask", { files: OUT });
read("read-allow", "allow Read(~/notes/**)", "{HOME}/notes/a.txt", "allow", { files: OUT });
read("read-allow", "allow Read(~/notes/**)", "{HOME}/x.txt", "ask", { files: OUT });
read("read-allow", "allow Read(/{ROOT_POSIX}/shared/**)", "{ROOT}/shared/a.txt", "allow", { files: OUT });
read("read-allow", "allow Read(/{ROOT_POSIX}/shared/**)", "{ROOT}/outside/a.txt", "ask", { files: OUT });
read("read-allow", { user: null, dirs: ["{ROOT}/shared"] }, "{ROOT}/shared/a.txt", "allow", { files: OUT });
read("read-allow", "allow Read", "{HOME}/x.txt", "allow", { files: OUT, note: "a bare Read allow rule allows every read" });
read("read-deny", "deny Read(./.env)", "{WORK}/.env", "deny", { files: { ".env": "S=1\n" } });
read("read-deny", "deny Read(./.env)", "{WORK}/sub/.env", "deny", { note: "./.env is not tied to the working folder: with the ./ off it is a bare name, which matches at any depth", files: { "sub/.env": "S=1\n" } });
read("read-deny", "deny Read(./.env)", "{WORK}/a.txt", "allow");
read("read-deny", "deny Read(./sub/a.txt)", "{WORK}/sub/a.txt", "deny");
read("read-deny", "deny Read(./sub/a.txt)", "{WORK}/src/sub/a.txt", "allow", { files: { "src/sub/a.txt": "x" } });
read("read-deny", "deny Read(.env)", "{WORK}/sub/.env", "deny", { files: { "sub/.env": "S=1\n" }, note: "a bare name matches at any depth" });
read("read-deny", "deny Read(**/.env)", "{WORK}/sub/.env", "deny", { files: { "sub/.env": "S=1\n" } });
read("read-deny", "deny Read(**/.env)", "{WORK}/.env", "deny", { files: { ".env": "S=1\n" } });
read("read-deny", "deny Read(*.env)", "{WORK}/prod.env", "deny", { files: { "prod.env": "S=1\n" } });
read("read-deny", "deny Read(*.env)", "{WORK}/sub/prod.env", "deny", { files: { "sub/prod.env": "S=1\n" } });
read("read-deny", "deny Read(secrets/**)", "{WORK}/secrets/key.txt", "deny", { files: { "secrets/key.txt": "k\n" } });
read("read-deny", "deny Read(secrets/**)", "{WORK}/sub/secrets/key.txt", "deny", { files: { "sub/secrets/key.txt": "k\n" }, note: "a deny rule of the form dir/** matches the folder at any depth" });
read("read-deny", "deny Read(secrets/**)", "{WORK}/src/a.ts", "allow");
read("read-deny", { project: "deny Read(/secrets/**)" }, "{WORK}/secrets/key.txt", "deny", { files: { "secrets/key.txt": "k\n" } });
read("read-deny", { project: "deny Read(/secrets/**)" }, "{WORK}/sub/secrets/key.txt", "allow", { files: { "sub/secrets/key.txt": "k\n" }, note: "/path is tied to the folder of the settings file" });
read("read-deny", "deny Read(/{ROOT_POSIX}/outside/**)", "{ROOT}/outside/a.txt", "deny", { files: OUT });
read("read-deny", "deny Read(~/.ssh/**)", "{HOME}/.ssh/id_rsa", "deny", { files: OUT });
// Windows paths: a drive path in a rule works with either kind of slash, a backslash anywhere else is not a separator
read("read-deny-win", "deny Read({WORK}\\a.txt)", "{WORK}/a.txt", "deny", { platform: "win32", engine: "win32", note: "an absolute Windows path in a rule works, with backslashes or slashes" });
read("read-deny-win", "deny Read({WORK}/a.txt)", "{WORK}/a.txt", "deny", { platform: "win32", engine: "win32" });
read("read-deny-win", "deny Read(sub\\a.txt)", "{WORK}/sub/a.txt", "allow", { platform: "win32", engine: "win32", note: "a backslash in a relative rule is not a folder separator, and Claude Code does not say so" });
read("read-deny-win", "deny Read(.\\a.txt)", "{WORK}/a.txt", "allow", { platform: "win32", engine: "win32" });
read("read-deny-win", "deny Read(//{WORK}/a.txt)", "{WORK}/a.txt", "allow", { platform: "win32", engine: "win32" });
read("read-deny-win", "deny Read(A.TXT)", "{WORK}/a.txt", "deny", { platform: "win32", engine: "win32", note: "Windows file names are not case-sensitive" });
read("read-deny", "deny Read(//{ROOT_POSIX}/outside/a.txt)", "{ROOT}/outside/a.txt", "deny", { files: OUT, note: "a third slash after the // is ignored" });
read("read-deny", "deny Read(src)", "{WORK}/src/a.ts", "deny", { note: "a pattern that names a folder reaches everything inside it" });
read("read-deny", "deny Read(src/)", "{WORK}/src/a.ts", "deny");
read("read-deny", "deny Read(./*.txt)", "{WORK}/a.txt", "deny");
read("read-deny", "deny Read(./*.txt)", "{WORK}/sub/a.txt", "deny");
read("read-deny", "deny Read(a.tx?)", "{WORK}/a.txt", "deny");
read("read-deny", "deny Read(a.[t]xt)", "{WORK}/a.txt", "deny");
read("read-ask", "ask Read(./a.txt)", "{WORK}/a.txt", "ask");
read("read-ask", "ask Read(./a.txt)", "{WORK}/b.txt", "allow");
read("read-bare", "deny Read", "{WORK}/a.txt", "deny", { note: "a bare deny rule takes the tool away" });
read("read-bare", "ask Read", "{WORK}/a.txt", "ask");

for (const [rule, file, matches] of denyRows) read("path-deny", `deny Read(${rule})`, `{WORK}/${file}`, matches ? "deny" : "allow", { files: { [file]: "x" } });

// --- Edit and Write ---------------------------------------------------------------------------------------------------------
edit("edit", null, "{WORK}/a.txt", "ask", { note: "in default mode every edit asks, unless an Edit rule allows it" });
edit("edit", "allow Edit(./src/**)", "{WORK}/src/a.ts", "allow");
edit("edit", "allow Edit(./src/**)", "{WORK}/a.txt", "ask");
edit("edit", "allow Edit(src/**)", "{WORK}/src/a.ts", "allow");
edit("edit", "allow Edit(*.txt)", "{WORK}/sub/a.txt", "allow");
edit("edit", "allow Edit", "{WORK}/a.txt", "allow");
edit("edit", "deny Edit(./a.txt)", "{WORK}/a.txt", "deny");
edit("edit", ["allow Edit", "deny Edit(./a.txt)"], "{WORK}/a.txt", "deny");
edit("edit", ["allow Edit(./src/**)", "ask Edit(./src/a.ts)"], "{WORK}/src/a.ts", "ask");
edit("edit", "deny Read(./a.txt)", "{WORK}/a.txt", "deny", { note: "a Read deny rule blocks edits of the same file" });
edit("edit", "deny Edit", "{WORK}/a.txt", "deny");
edit("edit", "ask Edit", "{WORK}/a.txt", "ask");
write("write", null, "{WORK}/new.txt", "ask");
write("write", "allow Edit(./src/**)", "{WORK}/src/new.ts", "allow", { note: "Edit rules cover Write as well" });
write("write", "allow Edit(./src/**)", "{WORK}/new.txt", "ask");
write("write", "allow Write(src/**)", "{WORK}/src/new.ts", "ask", { note: "a Write(path) rule is never consulted" });
write("write", "deny Edit(./a.txt)", "{WORK}/a.txt", "deny");
write("write", "allow Write", "{WORK}/new.txt", "allow", { note: "a bare Write rule is honored" });
write("write", "deny Write", "{WORK}/new.txt", "deny");

// --- WebFetch ----------------------------------------------------------------------------------------------------------------
fetch("fetch", null, "https://pd-probe.invalid/x", "ask");
fetch("fetch", "allow WebFetch(domain:pd-probe.invalid)", "https://pd-probe.invalid/x", "allow");
fetch("fetch", "allow WebFetch(domain:pd-probe.invalid)", "https://PD-Probe.invalid/x", "allow");
fetch("fetch", "allow WebFetch(domain:pd-probe.invalid)", "https://other.invalid/x", "ask");
fetch("fetch", "allow WebFetch(domain:pd-probe.invalid)", "https://a.pd-probe.invalid/x", "ask");
fetch("fetch", "allow WebFetch(domain:*.pd-probe.invalid)", "https://a.pd-probe.invalid/x", "allow");
fetch("fetch", "allow WebFetch(domain:*.pd-probe.invalid)", "https://a.b.pd-probe.invalid/x", "allow");
fetch("fetch", "allow WebFetch(domain:*.pd-probe.invalid)", "https://pd-probe.invalid/x", "ask");
fetch("fetch", "deny WebFetch(domain:pd-probe.invalid)", "https://pd-probe.invalid/x", "deny");
fetch("fetch", ["allow WebFetch", "deny WebFetch(domain:pd-probe.invalid)"], "https://pd-probe.invalid/x", "deny");
fetch("fetch", "ask WebFetch(domain:pd-probe.invalid)", "https://pd-probe.invalid/x", "ask");
fetch("fetch", "allow WebFetch", "https://pd-probe.invalid/x", "allow");
fetch("fetch", "deny WebFetch", "https://pd-probe.invalid/x", "deny");
fetch("fetch", "allow WebFetch(example.com)", "https://pd-probe.invalid/x", "ask", { note: "a WebFetch rule without domain: is skipped" });

// --- PowerShell (the oracle runs these on Windows only) ----------------------------------------------------------------------
const GP = "allow PowerShell(Get-Process *)";
for (const [command, expect] of [
  ["Get-Process", "allow"], ["get-process -Name nosuchprocess", "allow"], ["GET-PROCESS", "allow"], ["gps nosuchprocess", "allow"], ["ps nosuchprocess", "allow"],
  ["Get-Process; Get-Process", "allow"], ["Get-Process | Select-Object -First 1", "allow"], ["Get-Process | Remove-Item", "ask"], ["Get-Service", "ask"], ["Get-ProcessX", "ask"],
]) ps("ps-allow", GP, command, expect);
const RM = ["allow PowerShell(Get-Process *)", "deny PowerShell(Remove-Item *)"];
for (const [command, expect] of [
  ["Remove-Item nosuchfile", "deny"], ["remove-item nosuchfile", "deny"], ["rm nosuchfile", "deny"], ["del nosuchfile", "deny"], ["ri nosuchfile", "deny"],
  ["Get-Process; Remove-Item nosuchfile", "deny"], ["Get-Process | Remove-Item", "deny"], ["Get-Process\nRemove-Item nosuchfile", "deny"], ["Get-Process", "allow"],
  ["(Remove-Item nosuchfile)", "deny"], ["1 | ForEach-Object { Remove-Item nosuchfile }", "deny"],
]) ps("ps-deny", RM, command, expect);
for (const [command, expect] of [
  ["Get-ChildItem", "allow"], ["ls", "allow"], ["dir", "allow"], ["Get-Content a.txt", "allow"], ["cat a.txt", "allow"], ["Write-Output hi", "allow"], ["echo hi", "allow"],
  ["Get-Location", "allow"], ["pwd", "allow"], ["Get-Date", "allow"], ["Test-Path a.txt", "allow"], ["Select-String hello a.txt", "allow"], ["Get-ChildItem | Measure-Object", "allow"],
  ["Get-ChildItem ..", "ask"], ["Get-Content ..\\x", "ask"], ["Set-Content c.txt y", "ask"], ["New-Item c.txt", "ask"], ["Remove-Item a.txt", "ask"], ["Invoke-WebRequest http://pd-probe.invalid", "ask"],
  ["mytool a", "ask"], ["$x = 1", "ask"], ["Get-Process", "ask"], ["Write-Output (mytool a)", "ask"], ["foreach ($i in 1,2) { ls }", "ask"], ["iex 'ls'", "ask"],
]) ps("ps-readonly", null, command, expect);
const MTP = "allow PowerShell(mytool *)";
for (const [command, expect] of [
  ["mytool a", "allow"], ["mytool a; mytool b", "allow"], ["mytool a | mytool b", "allow"], ["MyTool a", "allow"], ["mytool a; othertool", "ask"], ["& mytool a", "ask"],
  [".\\mytool a", "ask"], ["mytool a &", "ask"], ["mytool $x", "ask"], ["mytool $true", "ask"], ["mytool $false", "ask"], ["mytool $null", "ask"], ["mytool \"$true\"", "ask"], ["mytool '$true'", "allow"], ["mytool 'a | b'", "allow"],
]) ps("ps-wildcard", MTP, command, expect);
for (const [command, expect] of [
  ["Get-ChildItem sub\\..", "ask"], ["Get-Content sub/../a.txt", "ask"], ["Select-String foo sub\\..\\a.txt", "ask"], ["Test-Path sub/../a.txt", "ask"], ["Set-Location sub\\..", "ask"],
  ["Get-ChildItem ..\\work", "allow"], ["Get-ChildItem .\\sub", "allow"], ["Get-ChildItem .\\sub\\", "allow"], ["Write-Output sub\\..\\a", "allow"],
  ["Get-ChildItem sub//x", "ask"], ["Get-ChildItem sub\\\\x", "ask"], ["Write-Output a//b", "ask"], ["Write-Output 'a//b'", "ask"], ["Get-Date; Write-Output a//b", "ask"],
  ["Get-ChildItem sub//", "allow"], ["Write-Output \"a // b\"", "allow"], ["Write-Output http://x", "allow"],
]) ps("ps-paths", null, command, expect, { note: "a .. after a directory name in a file cmdlet's path, and a // or \\\\ anywhere in the command, are asked about" });
for (const [rules, command, expect] of [
  ["allow PowerShell(Get-Content *)", "Get-Content sub\\..\\a.txt", "ask"], ["allow PowerShell(Get-ChildItem *)", "Get-ChildItem sub//x", "ask"], ["allow PowerShell(mytool *)", "mytool a//b", "ask"],
  ["allow PowerShell(mytool *)", "mytool sub\\..\\x", "allow"], ["allow PowerShell(mytool *)", "mytool sub/../x", "allow"], ["allow PowerShell(Write-Output *)", "Write-Output a//b", "ask"],
  ["allow PowerShell(Get-Process *)", "Get-Process sub\\..\\x", "allow"],
]) ps("ps-paths-rule", rules, command, expect);
read("read-paths", null, "{WORK}/sub/../a.txt", "allow", { note: "the Read tool normalizes the path" });
read("read-paths", null, "{WORK}//a.txt", "allow");
ps("ps-deny", ["allow PowerShell(mytool *)", "deny PowerShell(mytool danger *)"], "mytool danger x", "deny");
ps("ps-deny", "deny PowerShell(mytool *)", "& mytool a", "deny");
ps("ps-precedence", { user: "deny PowerShell(mytool *)", project: "allow PowerShell(mytool *)" }, "mytool a", "deny");
ps("ps-precedence", { project: "ask PowerShell(mytool *)", local: "allow PowerShell(mytool *)" }, "mytool a", "ask");
ps("ps-bare", "deny PowerShell", "Get-Date", "deny");
ps("ps-bare", "ask PowerShell", "Get-Date", "ask");
