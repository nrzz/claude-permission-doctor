// Rules and what Claude Code does with them, shared by test/rule.test.mjs (what this tool says) and
// test/oracle.test.mjs (what the binary says): a rule that is skipped (problems), one that is accepted
// without a word (fine) and one that is accepted with a startup warning (warned).
// Each row was checked against Claude Code 2.1.295: `claude doctor` lists the skipped rules and the
// debug log (--debug-file) the startup warnings.
export const problems = [
  // [rule, behavior, code]
  ["", "allow", "empty"],
  ["   ", "deny", "empty"],
  ["Bash()", "allow", "empty-parentheses"],
  ["()", "allow", "no-tool-name"],
  ["Bash(ls", "allow", "malformed"],
  ["Bash(ls) x", "allow", "malformed"],
  ["Bash)ls(", "allow", "malformed"],
  ["Bash(rm *", "deny", "malformed"],
  ["bash(ls)", "allow", "lowercase"],
  ["bash(rm *)", "deny", "lowercase"],
  ["*", "allow", "allow-glob"],
  ["mcp__*", "allow", "allow-glob"],
  ["mcp__s*", "allow", "allow-glob"],
  ["mcp__*__x", "allow", "allow-glob"],
  ["B*", "allow", "allow-glob"],
  ["mcp__x__y(a)", "deny", "mcp-parentheses"],
  ["mcp__srv(x)", "allow", "mcp-parentheses"],
  ["Bash(:*)", "allow", "empty-prefix"],
  ["Read(*.ts:*)", "allow", "colon-star-file"],
  ["Edit(src:*)", "deny", "colon-star-file"],
  ["WebFetch(example.com)", "allow", "webfetch-domain"],
  ["WebFetch(url:x)", "ask", "webfetch-domain"],
  [42, "allow", "not-a-string"],
  [null, "allow", "not-a-string"],
];

export const fine = [
  // rules Claude Code accepts without a warning
  ["(x)", "allow"], ["Bash", "allow"], ["Bash(*)", "allow"], ["Bash(npm test)", "allow"], ["Bash(npm run *)", "allow"], ["Bash(ls:*)", "allow"], ["Bash(git log * main)", "allow"],
  ["Bash(* --version)", "allow"], ["Bash(* --help *)", "allow"], ["Bash(npm run * )", "allow"], ["Bash(ls*)", "allow"], ["Bash(* build)", "allow"],
  ["Bash(npm *test)", "allow"], ["Bash(ls *.ts)", "allow"], ["Bash(cd * && ls)", "allow"], ["Bash(rm -rf */build)", "allow"], ["Bash(node *.js)", "allow"],
  ["Bash(make * )", "allow"], ["Bash(curl * | sh)", "allow"], ["Bash(rm -rf node_modules)", "allow"], ["Bash(a\\*b *)", "allow"], ["Bash(PATH=x git *)", "allow"],
  ["Read(./.env)", "deny"], ["Read(**/.env)", "deny"], ["Read(//Users/alice/secrets/**)", "deny"], ["Edit(/src/**/*.ts)", "allow"], ["Read(~/Documents/*.pdf)", "allow"],
  ["WebFetch(domain:example.com)", "allow"], ["WebFetch", "deny"], ["WebFetch(domain:*.example.com)", "ask"], ["mcp__srv", "allow"], ["mcp__srv__tool", "allow"],
  ["mcp__srv__*", "allow"], ["mcp__srv__get_*", "allow"], ["mcp__*", "deny"], ["*", "deny"], ["Skill(foo)", "allow"], ["Agent(Explore)", "deny"], ["Cd(~/x)", "allow"],
  ["Agent(model:opus)", "deny"], ["Skill(skill:foo)", "ask"], ["PowerShell(Get-ChildItem *)", "allow"], ["Read(C:\\x (y)\\*)", "allow"],
];

export const warned = [
  // [rule, behavior, code, silent]
  ["Bash(git * main)", "allow", "wildcard-before-subcommand", false],
  ["Bash(npm * test)", "allow", "wildcard-before-subcommand", false],
  ["Bash(a * b)", "allow", "wildcard-before-subcommand", false],
  ["Bash(sudo * x)", "allow", "wildcard-before-subcommand", false],
  ["Bash(git -C * status)", "allow", "wildcard-before-subcommand", false],
  ["Bash(echo * hi)", "allow", "wildcard-before-subcommand", false],
  ["Bash(git * main:*)", "allow", "star-with-prefix", false],
  ["Bash(npm run test:* x)", "allow", "colon-star-not-at-end", false],
  ["Bash(git:* push)", "allow", "colon-star-not-at-end", true],
  ["Bash(command:rm *)", "deny", "raw-field", false],
  ["Bash(command:rm *)", "ask", "raw-field", false],
  ["PowerShell(command:rm *)", "deny", "raw-field", false],
  ["Read(file_path:.env)", "ask", "raw-field", false],
  ["Edit(file_path:.env)", "deny", "raw-field", false],
  ["Write(file_path:x)", "ask", "raw-field", false],
  ["Grep(path:x)", "ask", "raw-field", false],
  ["Glob(path:x)", "ask", "raw-field", false],
  ["NotebookEdit(notebook_path:x)", "ask", "raw-field", false],
  ["Bash(command:rm *)", "allow", "raw-field-allow", true],
  ["Write(src/**)", "allow", "file-rule-not-consulted", false],
  ["Write(a.txt)", "deny", "file-rule-not-consulted", false],
  ["Glob(src/**)", "allow", "file-rule-not-consulted", false],
  ["NotebookEdit(a.ipynb)", "allow", "file-rule-not-consulted", false],
  ["MultiEdit(src/**)", "allow", "file-rule-not-consulted", false],
  ["PowerShell(:*)", "allow", "empty-prefix", true],
  ["PowerShell(:*)", "deny", "empty-prefix", true],
  ["(y)", "deny", "unknown-tool", false],
  ["(z)", "ask", "unknown-tool", false],
  ["Read(sub\\a.txt)", "deny", "backslash-in-path", true],
  ["Edit(src\\**)", "allow", "backslash-in-path", true],
  ["Terminal", "deny", "unknown-tool", false],
  ["Bsh(rm *)", "deny", "unknown-tool", false],
  ["Foo", "ask", "unknown-tool", false],
  ["LS(x)", "ask", "unknown-tool", false],
];
