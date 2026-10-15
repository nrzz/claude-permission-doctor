// [rule, file under the working folder, does a deny rule Read(rule) reach it]. Used by test/pathrules.test.mjs
// and, as Read calls under a deny rule, by test/oracle-table.mjs: Claude Code 2.1.295 gave the same answers.
export const denyRows = [
  // [rule, file under the working folder, matches]
  [".env", ".env", true], [".env", "sub/.env", true], [".env", "env", false], [".env", ".envx", false],
  ["*.env", "a.env", true], ["*.env", "sub/a.env", true], ["*.env", "a.envx", false],
  ["./.env", ".env", true], ["./.env", "sub/.env", true], // with the ./ off it is a bare name
  ["./sub/a.txt", "sub/a.txt", true], ["./sub/a.txt", "x/sub/a.txt", false],
  ["./*.txt", "a.txt", true], ["./*.txt", "sub/a.txt", true],
  ["sub/a.txt", "sub/a.txt", true], ["sub/a.txt", "x/sub/a.txt", false],
  ["src/**", "src/a.ts", true], ["src/**", "src/x/y/a.ts", true], ["src/**", "x/src/a.ts", true], ["src/**", "other/a.ts", false],
  ["src", "src/a.ts", true], ["src", "x/src/a.ts", true], ["src/", "src/a.ts", true], ["src/", "x/src/a.ts", true],
  ["**/.env", ".env", true], ["**/.env", "a/b/.env", true], ["**/.env", "a/b/env", false],
  ["a/**/b.txt", "a/b.txt", true], ["a/**/b.txt", "a/x/y/b.txt", true], ["a/**/b.txt", "x/a/b.txt", false],
  ["sub/*.txt", "sub/a.txt", true], ["sub/*.txt", "sub/x/a.txt", false],
  ["a.tx?", "a.txt", true], ["a.tx?", "a.tx", false], ["a.[t]xt", "a.txt", true],
  // there is no negated class: ! and ^ are just two more members of it
  ["a.[!t]xt", "a.txt", true], ["a.[!t]xt", "a.cxt", false], ["a.[^t]xt", "a.txt", true], ["a.[^t]xt", "a.cxt", false], ["a.[^t]xt", "a.^xt", true],
  ["a.[a-c]xt", "a.cxt", true], ["a.[a-c]xt", "a.txt", false], ["a.[tc]xt", "a.cxt", true], ["a.[]xt", "a.txt", false], ["a.[t", "a.txt", false],
  ["*.txt", "sub/a.txt", true], ["*", "sub/a.txt", true], ["**", "sub/a.txt", true],
  ["a.txt ", "a.txt", true], // the rule is trimmed
  ["!x", "x", false],
];
