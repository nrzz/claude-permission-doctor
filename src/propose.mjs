// From a command to the prefix rule that would approve it: the program, and the subcommand for the
// programs that have one (git commit, npm test, docker compose up). Used by `why` to name the one rule
// that stops a prompt and by `suggest` to group the commands that ran without a rule.

import { wrapperLength } from "./wrappers.mjs";

// Wrappers an allow rule does not look through, so a rule for what they run has to start with them.
const OPAQUE_WRAPPERS = new Set(["sudo", "doas", "env", "exec", "setsid", "ionice", "watch", "flock", "strace"]);

// Programs whose first plain word is a subcommand.
const SUBCOMMAND = new Set([
  "git", "npm", "yarn", "pnpm", "bun", "cargo", "go", "gh", "glab", "kubectl", "helm", "terraform", "pip", "pip3", "brew",
  "apt", "apt-get", "yum", "dnf", "systemctl", "service", "dotnet", "aws", "gcloud", "az", "heroku", "vercel", "flyctl",
  "firebase", "supabase", "prisma", "rails", "bundle", "gem", "composer", "docker", "docker-compose", "podman", "make",
  "poetry", "uv", "pipenv", "conda", "rustup", "deno", "nx", "turbo", "wrangler", "netlify", "stripe", "expo", "eas",
  "mvn", "gradle", "sbt", "swift", "xcodebuild", "ng", "nest", "vue", "svelte-kit", "playwright", "cypress", "jest", "vitest",
]);
// Programs whose operation is the subcommand and one more word (gh pr view, aws s3 ls, az vm list). npm run build
// and docker compose up are special-cased below.
const DEEP = {
  gh: 1, glab: 1, aws: 1, gcloud: 1, az: 1,
};
const RUN_LIKE = new Set(["npm", "yarn", "pnpm", "bun"]); // npm run <script>

// Programs that run whatever code they are given, delete, publish or reach the network: a rule for
// the bare program approves far more than one command. Shown as a warning, never hidden.
const RISKY = {
  rm: "deletes files", rmdir: "deletes folders", dd: "writes raw devices", mkfs: "formats disks", shred: "destroys files",
  sudo: "runs anything as root", su: "runs anything as another user", doas: "runs anything as root",
  bash: "runs any script", sh: "runs any script", zsh: "runs any script", eval: "runs any code", exec: "runs any program",
  python: "runs any code", python3: "runs any code", node: "runs any code", deno: "runs any code", bun: "runs any code",
  ruby: "runs any code", perl: "runs any code", php: "runs any code", npx: "downloads and runs any package",
  pnpx: "downloads and runs any package", bunx: "downloads and runs any package", uvx: "downloads and runs any package",
  pipx: "downloads and runs any package", env: "runs any program", xargs: "runs any program",
  curl: "reaches the network", wget: "reaches the network", ssh: "runs commands on other machines", scp: "copies to other machines",
  rsync: "copies to other machines", nc: "opens network connections", ncat: "opens network connections",
  kill: "stops processes", pkill: "stops processes", killall: "stops processes",
  chmod: "changes permissions", chown: "changes owners", mv: "moves and overwrites files",
};
const RISKY_SUB = [
  [/^git push\b/, "publishes commits"], [/^git reset\b/, "can discard work"], [/^git clean\b/, "deletes untracked files"],
  [/^git checkout\b/, "can discard changes"], [/^git rebase\b/, "rewrites history"],
  [/^npm (publish|unpublish|deprecate)\b/, "publishes packages"], [/^(yarn|pnpm) publish\b/, "publishes packages"],
  [/^cargo publish\b/, "publishes crates"], [/^docker (run|exec|rm|rmi|push|system prune|volume rm)\b/, "runs or removes containers and images"],
  [/^kubectl (apply|delete|exec|edit|patch|replace|scale|rollout)\b/, "changes a cluster"], [/^terraform (apply|destroy)\b/, "changes infrastructure"],
  [/^gh (pr merge|repo delete|release create|release delete|api)\b/, "changes GitHub"], [/^brew (install|uninstall|upgrade)\b/, "installs software"],
  [/^(npm|yarn|pnpm|pip|pip3|gem|cargo|go) (install|add|get|i)\b/, "installs and runs third-party code"],
  [/^systemctl (start|stop|restart|enable|disable)\b/, "changes services"],
];

const isOption = (w) => w.startsWith("-");
const looksLikeFile = (w) => /[\\/]/.test(w) || /\.[A-Za-z0-9]{1,5}$/.test(w);

/**
 * The words that name an operation, from a command's words (wrappers and assignments already off).
 * Returns { key, rule, risk } or null when the command is not one to propose a rule for (inline code,
 * a pipeline fragment ...). `key` is what `suggest` groups by; `rule` is the content of the rule.
 */
export function operation(words) {
  if (!words.length) return null;
  const program = words[0];
  // an assignment in front: an allow rule has to spell it out, as in Bash(FOO=1 make *)
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(program)) {
    let n = 0;
    while (n < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[n])) n++;
    const inner = operation(words.slice(n));
    return inner ? { ...inner, key: `${words.slice(0, n).join(" ")} ${inner.key}`, rule: `${words.slice(0, n).join(" ")} ${inner.key}` } : null;
  }
  // a wrapper that allow rules do not look through (sudo, env ...): the rule has to name it too
  const base0 = program.replace(/^.*[\\/]/, "");
  if (OPAQUE_WRAPPERS.has(base0)) {
    const n = wrapperLength(words, 0, { deep: true });
    const inner = n > 0 ? operation(words.slice(n)) : null;
    if (inner) {
      const key = `${words.slice(0, n).join(" ")} ${inner.key}`;
      return { ...inner, key, rule: key, risk: inner.risk || (base0 === "sudo" || base0 === "doas" ? RISKY[base0] : null) };
    }
  }
  if (program.includes("=") && !program.startsWith("-")) return null;
  const rest = words.slice(1);
  const base = program.replace(/^.*[\\/]/, "").replace(/\.(exe|cmd|bat)$/i, "");
  let key = program;
  if (SUBCOMMAND.has(base)) {
    // skip options that come before the subcommand only when they take no value
    let i = 0;
    while (i < rest.length && isOption(rest[i])) i++;
    const sub = rest[i];
    if (sub !== undefined && !isOption(sub) && !looksLikeFile(sub) && /^[a-z][a-z0-9:_-]*$/i.test(sub)) {
      const picked = i === 0 ? [program, sub] : [program, ...rest.slice(0, i + 1)];
      let extra = DEEP[base] || 0;
      if (RUN_LIKE.has(base) && (sub === "run" || sub === "exec")) extra = 1;
      if (base === "docker" && sub === "compose") extra = 1;
      for (let k = 1; k <= extra; k++) {
        const w = rest[i + k];
        if (w !== undefined && !isOption(w) && !looksLikeFile(w) && /^[A-Za-z0-9:_-]+$/.test(w)) picked.push(w);
        else break;
      }
      key = picked.join(" ");
    }
  } else if (RISKY[base] && rest[0] !== undefined && !isOption(rest[0]) && looksLikeFile(rest[0]) && ["python", "python3", "node", "deno", "bun", "ruby", "perl", "php", "bash", "sh", "zsh"].includes(base)) {
    key = `${program} ${rest[0]}`; // a script: group by the script, not by the interpreter
  }
  const flat = key;
  let risk = RISKY[base] || null;
  for (const [re, why] of RISKY_SUB) if (re.test(flat)) risk = why;
  return { key, rule: key, risk, program: base };
}

/** Is this an inline-code form (python -c, node -e, bash -c) that no prefix rule should be proposed for? */
export function inlineCode(words) {
  const baseOf = (list) => (list[0] || "").replace(/^.*[\\/]/, "").replace(/\.(exe|cmd|bat)$/i, "");
  let list = words;
  while (list.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(list[0])) list = list.slice(1);
  if (OPAQUE_WRAPPERS.has(baseOf(list))) {
    const n = wrapperLength(list, 0, { deep: true });
    if (n > 0 && n < list.length) return inlineCode(list.slice(n));
  }
  const base = baseOf(list);
  const flag = list[1];
  if (["python", "python3", "ruby", "perl", "php"].includes(base) && (flag === "-c" || flag === "-e" || flag === "-r")) return true;
  if (["node", "deno", "bun"].includes(base) && (flag === "-e" || flag === "--eval" || flag === "-p" || flag === "--print")) return true;
  if (["bash", "sh", "zsh", "dash"].includes(base) && (flag === "-c" || flag === "-lc" || flag === "-ic")) return true;
  return false;
}

/** "Bash(git commit *)" for the key "git commit". */
export function ruleFor(tool, key) {
  return `${tool}(${key} *)`;
}
