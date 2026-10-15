// What this tool knows about PowerShell rules, all of it checked against Claude Code 2.1.295
// (test/oracle.test.mjs): which aliases Claude Code resolves to the cmdlet before it matches a
// rule, and which cmdlets it runs without a prompt.
import { insideAny, leavesFolder, resolveArg, unsafePath } from "./paths.mjs";
import { readOnly } from "./readonly.mjs";

// alias -> cmdlet. The docs say "common aliases are canonicalized"; this is the list that was
// confirmed. Notably absent, because Claude Code does not resolve them: sort, sc, set, diff,
// compare, group, gm, gal, gu, gmo, gdr, rv (several are also programs on Windows).
const ALIASES = {
  ls: "Get-ChildItem", dir: "Get-ChildItem", gci: "Get-ChildItem",
  cat: "Get-Content", gc: "Get-Content", type: "Get-Content",
  cd: "Set-Location", sl: "Set-Location", chdir: "Set-Location",
  pwd: "Get-Location", gl: "Get-Location",
  echo: "Write-Output", write: "Write-Output",
  rm: "Remove-Item", del: "Remove-Item", erase: "Remove-Item", ri: "Remove-Item", rd: "Remove-Item", rmdir: "Remove-Item",
  cp: "Copy-Item", copy: "Copy-Item", cpi: "Copy-Item",
  mv: "Move-Item", move: "Move-Item", mi: "Move-Item",
  ren: "Rename-Item", rni: "Rename-Item",
  ni: "New-Item", ac: "Add-Content", clc: "Clear-Content", sleep: "Start-Sleep",
  select: "Select-Object", where: "Where-Object", foreach: "ForEach-Object", measure: "Measure-Object", sls: "Select-String",
  gi: "Get-Item", gp: "Get-ItemProperty", sp: "Set-ItemProperty", gcm: "Get-Command", gv: "Get-Variable", sv: "Set-Variable",
  fl: "Format-List", ft: "Format-Table", fw: "Format-Wide", oh: "Out-Host",
  h: "Get-History", history: "Get-History", clear: "Clear-Host", cls: "Clear-Host", man: "Get-Help", help: "Get-Help",
  tee: "Tee-Object", gsv: "Get-Service", pushd: "Push-Location", popd: "Pop-Location", ps: "Get-Process", gps: "Get-Process",
};

/** The cmdlet name an alias stands for, in the case Claude Code compares it in (everything is lowercased there). */
export function canonicalName(word) {
  const lower = word.toLowerCase();
  return (ALIASES[lower] || word).toLowerCase();
}

/** Replace the first word of a command text by its canonical name (lowercase), leaving the rest. */
export function canonicalText(text) {
  const m = /^(\S+)([\s\S]*)$/.exec(text.trimStart());
  if (!m) return text;
  if (m[1].includes("*")) return text.toLowerCase();
  return `${canonicalName(m[1])}${m[2].toLowerCase()}`;
}

// Cmdlets and programs that ran without a prompt (the file arguments of the first group must be
// inside the working folders).
const FILE_CMDLETS = new Set([
  "get-content", "get-item", "get-itemproperty", "get-childitem", "get-filehash", "get-acl", "select-string", "test-path",
  "resolve-path", "split-path", "set-location", "push-location",
]);
const PLAIN_CMDLETS = new Set([
  "get-member", "get-alias", "get-host", "get-culture", "get-location", "get-date", "get-random", "get-unique", "get-psdrive",
  "get-history", "compare-object", "format-list", "format-table", "format-wide", "out-string", "out-null", "out-host",
  "where-object", "sort-object", "group-object", "select-object", "measure-object", "convertto-json", "convertfrom-json",
  "convertto-csv", "join-path", "write-output", "write-host", "start-sleep", "get-module", "get-netipaddress", "pop-location",
  "hostname", "whoami", "ipconfig", "tasklist", "systeminfo", "where.exe",
]);

/**
 * Does Claude Code run this PowerShell command without asking? `words` are its argument values.
 * Returns { ok, why, cd } like readOnly().
 */
// PowerShell takes either kind of slash in a path; resolve them the same way on every system
const slashes = (a) => a.split(String.fromCharCode(92)).join("/");

export function readOnlyPs(words, { cwd, home, dirs, platform }) {
  const name = canonicalName(words[0] || "");
  const args = words.slice(1);
  if (name === "git") return readOnly(words, { cwd, home, dirs, platform });
  if (PLAIN_CMDLETS.has(name)) return { ok: true, why: `${words[0]} only reads` };
  if (FILE_CMDLETS.has(name)) {
    const bad = args.find((a) => !a.startsWith("-") && unsafePath(a, platform));
    if (bad !== undefined) return { ok: false, why: `${words[0]} ${bad}: the path ${unsafePath(bad, platform)}`, unsafe: bad };
    for (const a of args) {
      if (a.startsWith("-") || !leavesFolder(a)) continue;
      const abs = resolveArg(slashes(a), cwd, home);
      if (abs !== null && !insideAny(abs, dirs)) return { ok: false, why: `${words[0]} targets ${a}, outside the folders Claude may work in`, outside: a };
    }
    const target = args.find((a) => !a.startsWith("-"));
    const cd = (name === "set-location" || name === "push-location") && target ? resolveArg(slashes(target), cwd, home) : null;
    return { ok: true, why: `${words[0]} only reads`, cd: cd || undefined };
  }
  return { ok: false, why: `${words[0] || "this command"} is not a cmdlet this tool knows Claude Code treats as read-only` };
}
