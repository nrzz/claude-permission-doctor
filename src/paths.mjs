// Paths in commands: where does an argument point, and is it inside the folders Claude may work in?
// Claude Code's working directories are the folder it starts in plus the folders listed in
// permissions.additionalDirectories (and --add-dir, which no file records).
import path from "node:path";

const IS_WIN = process.platform === "win32";

/** True for text that names a place outside the current folder: /abs, ~, C:\abs or a ".." segment. */
export function leavesFolder(arg) {
  if (!arg) return false;
  if (arg.startsWith("/") || arg.startsWith("~") || arg.startsWith("\\")) return true;
  if (/^[A-Za-z]:[\\/]/.test(arg)) return true;
  return arg.split(/[\\/]/).includes("..");
}

/** Turn an argument into an absolute path; null when it cannot be known (a glob or a variable). */
export function resolveArg(arg, cwd, home) {
  if (arg === undefined || arg === "") return null;
  if (/[$`*?[]/.test(arg)) return null;
  let a = arg;
  if (a === "~" || a.startsWith("~/") || a.startsWith("~\\")) a = path.join(home || "", a.slice(1));
  else if (a.startsWith("~")) return null; // ~user
  // Git Bash writes C:\Users as /c/Users
  const posixDrive = /^\/([A-Za-z])(\/|$)/.exec(a);
  if (IS_WIN && posixDrive) a = `${posixDrive[1].toUpperCase()}:${a.slice(2) || "\\"}`;
  return path.resolve(cwd, a);
}

const fold = (p) => (IS_WIN ? p.toLowerCase() : p);

/** Is `p` one of `dirs` or somewhere below one of them? */
export function insideAny(p, dirs) {
  const target = fold(path.resolve(p));
  return dirs.some((d) => {
    const base = fold(path.resolve(d));
    const rel = path.relative(base, target);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  });
}

/** Display form: forward slashes, so output is the same on every system. */
export const toPosix = (p) => String(p).replace(/\\/g, "/");

/**
 * A ".." that comes after a directory name, as in sub/../x. Claude Code asks about such a path whatever
 * the rules say, because it may follow a symlink out of the working folder. A ".." at the start
 * (../work) is judged by where it lands instead.
 */
export function hasTraversal(arg) {
  let afterDir = false;
  for (const seg of String(arg).split(/[\\/]+/)) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (afterDir) return true;
      continue;
    }
    afterDir = true;
  }
  return false;
}

/**
 * A doubled slash with more text after it (a//b, .//x, //server/share): Windows reads it as a network
 * path. A trailing one (sub//) and the // of a URL (https://x) are fine.
 */
export const hasDoubleSlash = (text) => /(?<!:)\/\/(?=\S)/.test(String(text));

/** Why Claude Code asks about this path argument whatever the rules say, or null. */
export function unsafePath(arg) {
  if (hasTraversal(arg)) return "has a .. after a directory name, and Claude Code asks about that whatever the rules say, because it may follow a symlink out of the working folder";
  if (hasDoubleSlash(arg)) return "has a // inside the path, which could be a network share, and Claude Code asks about that whatever the rules say";
  return null;
}
