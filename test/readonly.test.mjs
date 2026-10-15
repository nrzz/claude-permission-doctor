import { tmp } from "./helpers.mjs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileArguments, readOnly, READS_FILES, WRITES_FILES } from "../src/readonly.mjs";

const work = tmp("pd-ro-");
const other = tmp("pd-ro-other-");
const home = tmp("pd-ro-home-");
const ctx = { cwd: work, home, dirs: [work] };
const ro = (line, c = ctx) => readOnly(line.split(" "), c);

// Every row is a command that ran without a prompt (or prompted) in Claude Code 2.1.295; the same
// rows are repeated against the binary in test/oracle.test.mjs.
const rows = [
  ["echo hi", true], ["printf %s x", true], ["true", true], ["pwd", true], ["whoami", true], ["hostname", true], ["uname -a", true],
  ["which node", true], ["id", true], ["sleep 0", true], ["seq 3", true], ["basename a/b", true], ["dirname a/b", true],
  ["ls", true], ["ls -la", true], ["ls sub", true], ["ls ./sub/x", true],
  ["cat a.txt", true], ["head -5 a.txt", true], ["tail -n 3 a.txt", true], ["wc -l a.txt", true], ["stat a.txt", true], ["file a.txt", true],
  ["du -sh .", true], ["diff a b", true], ["cut -d, -f1 a.csv", true], ["jq .a a.json", true],
  ["grep foo a.txt", true], ["grep -rn foo .", true], ["grep -i -e foo a.txt", true], ["egrep foo a.txt", true], ["grep --count foo a.txt", true],
  ["grep --no-such-flag foo a.txt", false], ["grep -Y foo a.txt", false],
  ["find .", true], ["find . -name x", true], ["find . -type f -name x", true],
  ["find . -exec rm {} ;", false], ["find . -delete", false], ["find . -fprint out.txt", false], ["find . -execdir ls ;", false], ["find . -ok ls ;", false],
  ["sort a.txt", true], ["sort -r a.txt", true], ["sort -o out.txt a.txt", false], ["sort --output=out.txt a.txt", false],
  ["tree", true], ["tree -o out.txt", false],
  ["sed -n 1,5p a.txt", true], ["sed -n 3p a.txt", true], ["sed -n 1p;3p a.txt", true], ["sed -i s/a/b/ a.txt", false], ["sed s/a/b/ a.txt", false], ["sed -n s/a/b/p a.txt", false],
  ["ps aux", true], ["ps -ef", true], ["ps", true], ["ps -p 1", true], ["ps -o pid", false],
  ["date", true], ["date -u", true], ["date +%Y", true], ["date -s 2020-01-01", false],
  ["uniq", true], ["uniq -c", true], ["uniq a.txt out.txt", false],
  ["node --version", true], ["node -v", true], ["node x.js", false], ["python --version", true], ["python3 --version", true], ["python x.py", false],
  ["docker ps", true], ["docker images", true], ["docker logs web", true], ["docker inspect web", true], ["docker run x", false], ["docker -H tcp://x ps", false],
  ["git status", true], ["git status -s", true], ["git status -sb", true], ["git log", true], ["git log --oneline -5", true], ["git log -3", true],
  ["git diff", true], ["git diff --stat", true], ["git diff --cached", true], ["git show HEAD", true], ["git branch", true], ["git branch -a", true], ["git branch -r", true],
  ["git tag", true], ["git tag -l", true], ["git remote -v", true], ["git remote", true], ["git stash list", true], ["git config --get user.name", true],
  ["git rev-parse HEAD", true], ["git rev-parse --show-toplevel", true], ["git ls-files", true], ["git blame a.txt", true], ["git describe --tags", true],
  ["git commit -m x", false], ["git push", false], ["git pull", false], ["git add .", false], ["git checkout main", false], ["git fetch", false],
  ["git branch newbranch", false], ["git tag v1", false], ["git stash", false], ["git stash pop", false], ["git config user.name x", false],
  ["git remote add o x", false], ["git log --output=x", false], ["git diff --output=x", false], ["git -c core.pager=x log", false], ["git -C other log", false],
  ["git frobnicate", false], ["git", false],
  ["rm a.txt", false], ["touch a", false], ["mkdir d", false], ["cp a b", false], ["mv a b", false], ["tee a", false], ["curl x", false], ["npm test", false], ["mytool", false],
  ["cd", false], ["cd a b", false],
];
for (const [line, expected] of rows) {
  test(`readOnly: ${line} ${expected ? "only reads" : "is not known to be read-only"}`, () => {
    const r = ro(line);
    assert.equal(r.ok, expected, r.why);
    assert.ok(typeof r.why === "string" && r.why.length > 3);
  });
}

test("readOnly: cd inside the working folders is fine and reports where it goes", () => {
  const r = ro("cd sub");
  assert.equal(r.ok, true);
  assert.equal(r.cd, path.join(work, "sub"));
  assert.equal(ro("cd .").cd, work);
  assert.equal(ro("cd ./a/b").cd, path.join(work, "a", "b"));
});

test("readOnly: cd outside the working folders is not allowed, and says where", () => {
  const r = ro("cd ../elsewhere");
  assert.equal(r.ok, false);
  assert.equal(r.outside, "../elsewhere");
  assert.equal(readOnly(["cd", other], ctx).ok, false);
  assert.equal(readOnly(["cd", other], { ...ctx, dirs: [work, other] }).ok, true, "an extra directory counts as inside");
});

test("readOnly: a cd whose folder is only known at run time is unknown", () => {
  assert.equal(readOnly(["cd", "$X"], ctx).ok, false);
  assert.equal(readOnly(["cd", "~nobody/x"], ctx).ok, false);
});

test("readOnly: a file argument outside the working folders makes a reading command prompt, and names the argument", () => {
  for (const argv of [["cat", "../x"], ["ls", ".."], ["head", other], ["diff", "a", "../b"], ["wc", "-l", "../x"], ["ls", "/"], ["ls", "~"]]) {
    const r = readOnly(argv, ctx);
    assert.equal(r.ok, false, argv.join(" "));
    assert.ok(r.outside, `outside is named for ${argv.join(" ")}`);
  }
  assert.equal(readOnly(["cat", other + "/x"], { ...ctx, dirs: [work, other] }).ok, true);
});

test("readOnly: a .. after a directory name, or a // inside a path, is asked about whatever the rules say", () => {
  for (const line of ["ls sub/..", "ls ./sub/..", "cat sub/../a", "cd sub/..", "head -1 a//b", "grep x sub/../a", "find sub/.. -name x", "find . -path */../*", "sed -n 1p sub/../a", "rm sub/../x", "cp a sub//b", "ls ./sub/./..", "ls ../work/../work", "cat .//a", "ls ..///work"]) {
    const r = ro(line, { ...ctx, platform: "win32" });
    assert.equal(r.ok, false, line);
    assert.notEqual(r.unsafe, undefined, line);
    assert.match(r.why, /whatever the rules say/, line);
  }
  for (const line of ["ls ../work", "ls ./../work", "ls sub/", "ls sub//", "ls ./sub/", "cat ./a", "echo sub/../x", "git log -- sub/../a", "grep sub/../x a.txt", "cd sub//", "ls foo..bar", "ls ..a", "ls ...", "echo http://x", "ls sub/./x"]) {
    assert.equal(ro(line, { ...ctx, platform: "win32" }).unsafe, undefined, line);
  }
});

test("readOnly: the // check is for Windows; the .. check is for every system", () => {
  const linux = { ...ctx, platform: "linux" };
  assert.equal(ro("cat sub//a", linux).unsafe, undefined);
  assert.equal(ro("cat sub//a", linux).ok, true);
  assert.notEqual(ro("cat sub/../a", linux).unsafe, undefined);
  assert.notEqual(ro("cat sub//a", { ...ctx, platform: "win32" }).unsafe, undefined);
});

test("readOnly: a path that a Read allow rule covers counts as inside", () => {
  const allowed = { ...ctx, allowed: (a) => a === "/some/outside/file" };
  assert.equal(readOnly(["cat", "/some/outside/file"], allowed).ok, true);
  assert.equal(readOnly(["cat", "/some/other/file"], allowed).ok, false);
  assert.equal(readOnly(["cd", "/some/outside/file"], allowed).ok, false, "cd needs a working folder, a Read rule does not make it one");
});

test("readOnly: the pattern of grep is not a path, the file after it is", () => {
  assert.equal(ro("grep ../x a.txt").ok, true, "the first plain argument is the pattern");
  assert.equal(ro("grep foo ../a.txt").ok, false);
  assert.equal(ro("grep -e ../x a.txt").ok, false, "with -e every plain argument is a file");
  assert.equal(ro("jq .. a.json").ok, true);
  assert.equal(ro("rg foo ../a").ok, false);
});

test("readOnly: find checks its starting points, not the tests after them", () => {
  assert.equal(ro("find . -name ../x").ok, true);
  assert.equal(ro("find .. -name x").ok, false);
  assert.equal(ro("find ../a ./b").outside, "../a");
});

test("readOnly: sed -n is read-only only with a line-range print script", () => {
  assert.equal(ro("sed -n 2,4p ../a.txt").ok, false);
  assert.equal(ro("sed -n 2,4p ../a.txt").outside, "../a.txt");
  assert.equal(ro("sed -En 1p a.txt").ok, false, "combined flags are not on the list");
  assert.equal(ro("sed -E -n 1p a.txt").ok, true);
});

test("readOnly: git needs a subcommand first, and a flag only in the forms seen to run", () => {
  assert.equal(ro("git --no-pager log").ok, false);
  assert.match(ro("git -C x log").why, /before the subcommand/);
  assert.match(ro("git frobnicate").why, /not on the list/);
  assert.match(ro("git log --output=x").why, /not on the list of flags/);
  assert.equal(ro("git log --format=%h").ok, true);
  assert.equal(ro("git log --format %h").ok, true);
  assert.equal(ro("git log -n 3").ok, true);
  assert.equal(ro("git log --author bob").ok, true);
  assert.equal(ro("git log --graph --oneline --decorate --all").ok, true);
  assert.equal(ro("git show --stat HEAD").ok, true);
});

test("readOnly: an unknown command is never called a prompt, only 'not known'", () => {
  const r = ro("mytool a");
  assert.equal(r.ok, false);
  assert.match(r.why, /not a command this tool knows/);
});

test("fileArguments: which words are files that are read and which are written", () => {
  assert.deepEqual(fileArguments(["cat", "a", "b"]), { reads: ["a", "b"], writes: [] });
  assert.deepEqual(fileArguments(["cp", "a", "b"]), { reads: ["a"], writes: ["b"] });
  assert.deepEqual(fileArguments(["mv", "-f", "a", "b", "c"]), { reads: ["a", "b"], writes: ["c"] });
  assert.deepEqual(fileArguments(["rm", "-rf", "a"]), { reads: [], writes: ["a"] });
  assert.deepEqual(fileArguments(["tee", "-a", "out"]), { reads: [], writes: ["out"] });
  assert.deepEqual(fileArguments(["touch", "a", "b"]), { reads: [], writes: ["a", "b"] });
  assert.deepEqual(fileArguments(["grep", "-n", "pat", "a", "b"]), { reads: ["a", "b"], writes: [] });
  assert.deepEqual(fileArguments(["grep", "-e", "pat", "a"]), { reads: ["pat", "a"], writes: [] }, "with -e the pattern is a flag value and every plain word counts");
  assert.deepEqual(fileArguments(["jq", ".a", "x.json"]), { reads: ["x.json"], writes: [] });
  assert.deepEqual(fileArguments(["sed", "-n", "1p", "a"]), { reads: ["a"], writes: [] });
  assert.deepEqual(fileArguments(["sed", "-i", "s/a/b/", "a"]), { reads: [], writes: ["a"] });
  assert.deepEqual(fileArguments(["sed", "--in-place=.bak", "s/a/b/", "a"]), { reads: [], writes: ["a"] });
  assert.deepEqual(fileArguments(["npm", "test"]), { reads: [], writes: [] });
  assert.deepEqual(fileArguments(["cat", "--", "-x"]), { reads: ["-x"], writes: [] }, "after -- a leading dash is part of the name");
});

test("READS_FILES and WRITES_FILES name the programs whose file arguments get Read and Edit checks", () => {
  for (const n of ["cat", "head", "grep", "sed", "cp", "mv", "sort", "ls"]) assert.ok(READS_FILES.has(n), n);
  for (const n of ["tee", "cp", "mv", "touch", "mkdir", "rm", "rmdir", "sed"]) assert.ok(WRITES_FILES.has(n), n);
  assert.ok(!READS_FILES.has("rm") && !WRITES_FILES.has("cat"));
});
