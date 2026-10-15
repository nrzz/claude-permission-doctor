// Read(...) and Edit(...) rules: which files does a path pattern reach?
//
// The docs: patterns use gitignore syntax and four anchors. `//path` is absolute, `~/path` starts at
// the home folder, `/path` starts at the folder of the settings file (the project for project and
// local settings, the config folder for user settings), and `path` or `./path` is relative to the
// working folder. A bare name (".env", "*.env") matches at any depth. A pattern with a slash in it is
// tied to its anchor, except that a deny or ask rule of the form "dir/**" matches such a directory at
// any depth (an allow rule does not). A pattern that names a folder reaches everything inside it.
// All of that was checked against Claude Code 2.1.295 with about seventy rule and file pairs.
import path from "node:path";

const IS_WIN = process.platform === "win32";

/** Absolute path -> the POSIX form Claude Code matches on (C:\Users\a -> /c/Users/a on Windows). */
export function posixForm(abs) {
  let p = path.resolve(abs);
  if (IS_WIN) {
    const m = /^([A-Za-z]):[\\/]?(.*)$/.exec(p);
    if (m) p = `/${m[1].toLowerCase()}/${m[2]}`;
  }
  return p.split(path.sep).join("/").replace(/\/+$/, "") || "/";
}

function escapeRegex(c) {
  return c.replace(/[.+*?^${}()|[\]\\]/g, "\\$&");
}

/** gitignore glob -> regex source (no anchors). */
function globSource(pat) {
  let re = "";
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i];
    if (c === "*") {
      if (pat[i + 1] === "*") {
        const startOk = i === 0 || pat[i - 1] === "/";
        const j = i + 2;
        const endOk = j === pat.length || pat[j] === "/";
        if (startOk && endOk) {
          if (pat[j] === "/") { re += "(?:.*/)?"; i = j; } else { re += ".*"; i = j - 1; }
          continue;
        }
        re += "[^/]*";
        i++;
        continue;
      }
      re += "[^/]*";
      continue;
    }
    if (c === "?") { re += "[^/]"; continue; }
    if (c === "[") {
      const end = pat.indexOf("]", i + 2);
      if (end !== -1) {
        // Claude Code 2.1.295 has no negated class: [!t] and [^t] match "!" or "^" and "t"
        const cls = pat.slice(i + 1, end).replace(/[\\[^]/g, "\\$&");
        let valid = true;
        try { new RegExp(`[${cls}]`); } catch { valid = false; } // a range such as [}-)] is out of order: the [ is then an ordinary character
        if (valid) {
          re += `[${cls}]`;
          i = end;
          continue;
        }
      }
    }
    if (c === "\\" && i + 1 < pat.length) { re += escapeRegex(pat[i + 1]); i++; continue; }
    re += escapeRegex(c);
  }
  return re;
}

/**
 * Does a path rule reach this file?
 *   content   the text inside Read(...) or Edit(...)
 *   abs       the file, absolute
 *   behavior  "allow", "ask" or "deny" (the depth of "dir/**" differs)
 *   scope     "user", "project", "local" or "managed": where "/path" starts
 *   cwd, home, configDir   the folders the anchors refer to
 */
export function pathRuleMatches(content, abs, { behavior, scope, cwd, home, configDir }) {
  let pat = content.trim();
  if (pat.startsWith("!")) return false; // a carve-out reaches no file by itself
  let anchor;
  let tied = false; // true when the pattern is tied to its anchor
  if (pat.startsWith("//")) {
    anchor = "/";
    pat = pat.slice(2).replace(/^\/+/, "");
    tied = true;
  } else if (/^[A-Za-z]:[\\/]/.test(pat)) {
    // an absolute Windows path (C:\Users\me\x or C:/Users/me/x) is read as //c/Users/me/x
    anchor = "/";
    pat = `${pat[0].toLowerCase()}/${pat.slice(3).replace(/\\/g, "/")}`;
    tied = true;
  } else if (pat.startsWith("~/")) {
    anchor = posixForm(home);
    pat = pat.slice(2);
    tied = true;
  } else if (pat.startsWith("/")) {
    anchor = posixForm(scope === "user" ? configDir : cwd);
    pat = pat.slice(1);
    tied = true;
  } else {
    anchor = posixForm(cwd);
    pat = pat.replace(/^(\.\/)+/, "");
  }
  const target = posixForm(abs);
  let rel;
  if (anchor === "/") rel = target.replace(/^\//, "");
  else if (target === anchor) rel = "";
  else if (target.startsWith(`${anchor}/`)) rel = target.slice(anchor.length + 1);
  else return false; // a rule only reaches files under its anchor
  if (rel === "") return false;

  const dirOnly = pat.endsWith("/");
  if (dirOnly) pat = pat.replace(/\/+$/, "");
  if (pat === "") return false;
  const inner = pat.includes("/");
  let anyDepth = !tied && !inner;
  if (!tied && inner && behavior !== "allow" && /^[^/*?[\\]+\/\*\*$/.test(pat)) anyDepth = true; // "dir/**" in a deny or ask rule
  const source = globSource(pat);
  let re;
  try {
    re = new RegExp(`^${anyDepth ? "(?:.*/)?" : ""}${source}$`, IS_WIN ? "i" : "");
  } catch {
    return false; // a pattern that cannot be turned into a matcher reaches nothing
  }
  const parts = rel.split("/");
  for (let k = 1; k <= parts.length; k++) {
    if (dirOnly && k === parts.length) break; // "dir/" names folders, so the file itself does not count
    const prefix = parts.slice(0, k).join("/");
    // dir/** reaches the folder itself as well as what is inside it (ls sub, with Read(./sub/**) denied, is refused)
    if (re.test(prefix) || re.test(`${prefix}/`)) return true;
  }
  return false;
}
