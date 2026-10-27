import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

// Portable Git-worktree helper. Git is the registry; no state is stored here.
// Run through the npm aliases so npm_execpath is available for `npm ci`.

const USAGE = `Usage:
  npm run worktree:setup -- <name> [--base <local-ref>] [--no-install]
  npm run worktree:list
  npm run worktree:teardown -- <name>

Names are slugs: lowercase ASCII letters, digits and single hyphens.
See scripts/README.md for the safety rules.`;

class CliError extends Error {}
class UsageError extends Error {}

type Worktree = {
  path: string;
  branch: string | null;
  bare: boolean;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
};

function key(p: string): string {
  const resolved = path.resolve(p).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isAtOrUnder(child: string, parent: string): boolean {
  const c = key(child);
  const par = key(parent);
  return c === par || c.startsWith(par + path.sep.toLowerCase());
}

type RunResult = { stdout: Buffer; stderr: Buffer; code: number };

function run(command: string, args: string[], cwd: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout: Buffer.concat(out), stderr: Buffer.concat(err), code: code ?? 1 }));
  });
}

async function git(args: string[], cwd: string): Promise<Buffer> {
  const r = await run("git", args, cwd);
  if (r.code !== 0) {
    throw new CliError(`git ${args[0] ?? ""} failed: ${r.stderr.toString("utf8").trim() || `exit ${r.code}`}`);
  }
  return r.stdout;
}

async function gitCode(args: string[], cwd: string): Promise<number> {
  const r = await run("git", args, cwd);
  return r.code;
}

// `git worktree list --porcelain -z`: NUL-terminated lines, blank line between
// entries, so paths may contain spaces and newlines.
function parseWorktrees(buf: Buffer): Worktree[] {
  const tokens = buf.toString("utf8").split("\0");
  const entries: Worktree[] = [];
  let cur: Worktree | null = null;
  for (const line of tokens) {
    if (line === "") {
      if (cur) { entries.push(cur); cur = null; }
      continue;
    }
    if (line.startsWith("worktree ")) {
      if (cur) entries.push(cur);
      cur = { path: line.slice("worktree ".length), branch: null, bare: false, detached: false, locked: false, prunable: false };
    } else if (cur && line.startsWith("branch ")) {
      cur.branch = line.slice("branch ".length);
    } else if (cur && line === "bare") cur.bare = true;
    else if (cur && line === "detached") cur.detached = true;
    else if (cur && (line === "locked" || line.startsWith("locked "))) cur.locked = true;
    else if (cur && (line === "prunable" || line.startsWith("prunable "))) cur.prunable = true;
  }
  if (cur) entries.push(cur);
  return entries;
}

async function resolveContext(): Promise<{ primary: string; root: string; entries: Worktree[] }> {
  const cwd = process.cwd();
  const probe = await run("git", ["rev-parse", "--is-inside-work-tree"], cwd);
  if (probe.code !== 0 || probe.stdout.toString("utf8").trim() !== "true") {
    const detail = probe.stderr.toString("utf8").trim();
    throw new CliError(`Run this from inside a Git checkout of this repository.${detail ? ` Git said: ${detail}` : ""}`);
  }
  const entries = parseWorktrees(await git(["worktree", "list", "--porcelain", "-z"], cwd));
  const main = entries[0];
  if (!main) throw new CliError("No Git worktrees found.");
  if (main.bare) throw new CliError("The primary worktree is bare; run this from a non-bare checkout.");
  const primary = path.resolve(main.path);
  const root = path.join(path.dirname(primary), `${path.basename(primary)}-worktrees`);
  return { primary, root, entries };
}

const RESERVED = new Set(["con", "prn", "aux", "nul",
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`)]);

function validateName(raw: string | undefined): string {
  if (raw === undefined) throw new UsageError("Missing <name>.\n" + USAGE);
  if (raw.startsWith("-")) throw new UsageError(`Invalid worktree name "${raw}": names may not look like options.`);
  if (raw.length < 1 || raw.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(raw)) {
    throw new UsageError(`Invalid worktree name "${raw}": use 1-64 lowercase ASCII letters, digits and single hyphens (no leading/trailing hyphen).`);
  }
  if (RESERVED.has(raw)) throw new UsageError(`Invalid worktree name "${raw}": Windows reserved device name.`);
  return raw;
}

function findEntry(entries: Worktree[], target: string): Worktree | undefined {
  return entries.find((e) => key(e.path) === key(target));
}

function lstatIfExists(p: string): fs.Stats | undefined {
  try { return fs.lstatSync(p); } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return undefined;
    throw err;
  }
}

function assertRootSafeForCreate(root: string): void {
  const st = lstatIfExists(root);
  if (!st) return; // will be created
  if (st.isSymbolicLink()) throw new CliError(`Managed worktree root is a link and will not be used: ${root}`);
  if (!st.isDirectory()) throw new CliError(`Managed worktree root is not a directory: ${root}`);
}

function parseSetupArgs(args: string[]): { name: string; base: string | undefined; noInstall: boolean } {
  if (args.includes("--help") || args.includes("-h")) { console.log(USAGE); process.exit(0); }
  let name: string | undefined;
  let base: string | undefined;
  let noInstall = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "--no-install") {
      if (noInstall) throw new UsageError("Duplicate --no-install.\n" + USAGE);
      noInstall = true;
    } else if (a === "--base") {
      if (base !== undefined) throw new UsageError("Duplicate --base.\n" + USAGE);
      const v = args[i + 1];
      if (v === undefined) throw new UsageError("--base needs a value.\n" + USAGE);
      base = v; i++;
    } else if (a.startsWith("-")) {
      throw new UsageError(`Unknown option "${a}".\n` + USAGE);
    } else if (name === undefined) name = a;
    else throw new UsageError(`Unexpected argument "${a}".\n` + USAGE);
  }
  return { name: validateName(name), base, noInstall };
}

function parseNameOnly(args: string[], command: string): string {
  if (args.includes("--help") || args.includes("-h")) { console.log(USAGE); process.exit(0); }
  let name: string | undefined;
  for (const a of args) {
    if (a.startsWith("-")) throw new UsageError(`Unknown option "${a}" for ${command}.\n` + USAGE);
    if (name !== undefined) throw new UsageError(`Unexpected argument "${a}".\n` + USAGE);
    name = a;
  }
  return validateName(name);
}

function validateBase(base: string): void {
  if (base === "" || base.startsWith("-") || /\s/.test(base) || base.includes("..") || /[~^:?*[\\]/.test(base)) {
    throw new UsageError(`Invalid --base "${base}": give an existing local ref, for example main.`);
  }
}

async function setup(args: string[]): Promise<void> {
  const { name, base, noInstall } = parseSetupArgs(args);
  const effectiveBase = base ?? "main";
  validateBase(effectiveBase);
  const { primary, root, entries } = await resolveContext();
  const branch = `codex/${name}`;
  const target = path.join(root, name);

  assertRootSafeForCreate(root);
  // Bad input must fail before any mutation.
  const baseCheck = await gitCode(["rev-parse", "--verify", "--quiet", `${effectiveBase}^{commit}`], primary);
  if (baseCheck !== 0) throw new CliError(`Base ref "${effectiveBase}" does not resolve to a local commit. No fetch was attempted.`);
  const branchExists = (await gitCode(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], primary)) === 0;
  if (branchExists && base !== undefined) {
    throw new CliError(`Branch ${branch} already exists, so --base would be ignored. Omit --base to reuse it.`);
  }
  if (lstatIfExists(target) || findEntry(entries, target)) {
    throw new CliError(`Target already exists or is registered: ${target}`);
  }
  const inUse = entries.find((e) => e.branch === `refs/heads/${branch}`);
  if (inUse) throw new CliError(`Branch ${branch} is already checked out at ${inUse.path}; it cannot be reused here.`);

  fs.mkdirSync(root, { recursive: true });
  assertRootSafeForCreate(root);
  const addArgs = branchExists
    ? ["worktree", "add", target, branch]
    : ["worktree", "add", "-b", branch, target, effectiveBase];
  await git(addArgs, primary);
  console.log(branchExists
    ? `Reused existing branch ${branch} (no reset) in new worktree ${target}`
    : `Created worktree ${target} on new branch ${branch} from ${effectiveBase}`);

  if (noInstall) { console.log("Skipped install (--no-install). Run `npm ci` there when dependencies are needed."); return; }
  await install(target, name, branch);
}

async function install(target: string, name: string, branch: string): Promise<void> {
  const recovery = `The worktree and branch were preserved: ${target} (${branch}). ` +
    `Recover with: cd "${target}" then run npm ci, or remove it with: npm run worktree:teardown -- ${name}`;
  const npmExec = process.env.npm_execpath;
  if (!npmExec) {
    throw new CliError(`Cannot run npm ci: npm_execpath is not set, so this was not started through npm. Use: npm run worktree:setup -- ${name} --no-install, or run npm ci inside the new worktree. ${recovery}`);
  }
  const resolved = path.resolve(npmExec);
  const ext = path.extname(resolved).toLowerCase();
  let ok = [".js", ".cjs", ".mjs"].includes(ext) && path.basename(resolved).toLowerCase().includes("npm");
  try { ok = ok && fs.statSync(resolved).isFile(); } catch { ok = false; }
  if (!ok) throw new CliError(`Cannot run npm ci: npm_execpath is not a validated npm CLI script: ${npmExec}. ${recovery}`);
  const r = await run(process.execPath, [resolved, "ci", "--no-audit", "--no-fund"], target);
  process.stdout.write(r.stdout);
  process.stderr.write(r.stderr);
  if (r.code !== 0) throw new CliError(`npm ci failed (exit ${r.code}). ${recovery}`);
  console.log("Installed dependencies with npm ci.");
}

async function list(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) { console.log(USAGE); return; }
  if (args.length > 0) throw new UsageError(`worktree:list takes no arguments.\n` + USAGE);
  const { primary, root, entries } = await resolveContext();
  console.log(`Primary: ${primary}`);
  console.log(`Managed root: ${root}`);
  for (const e of entries) {
    const kind = key(e.path) === key(primary) ? "main" : key(path.dirname(path.resolve(e.path))) === key(root) ? "managed" : "external";
    const branch = e.bare ? "(bare)" : e.detached || !e.branch ? "(detached)" : e.branch.replace(/^refs\/heads\//, "");
    const flags = [e.locked ? "locked" : "", e.prunable ? "prunable" : ""].filter(Boolean).join(", ");
    console.log(`${kind}\t${branch}\t${path.resolve(e.path)}${flags ? `\t${flags}` : ""}`);
  }
}

const ALLOWED_IGNORED_ROOTS = new Set(["node_modules", "dist", "coverage"]);

async function teardown(args: string[]): Promise<void> {
  const name = parseNameOnly(args, "worktree:teardown");
  const { primary, root, entries } = await resolveContext();
  const target = path.join(root, name);

  if (isAtOrUnder(process.cwd(), target)) {
    throw new CliError("Refusing: your current directory is inside the target worktree. Run teardown from another checkout.");
  }
  // Managed root must be a real directory, not a link/junction.
  let rootStat: fs.Stats;
  try { rootStat = fs.lstatSync(root); } catch { throw new CliError(`Managed worktree root does not exist: ${root}`); }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new CliError(`Refusing: managed root is a link or not a directory: ${root}`);
  if (key(fs.realpathSync(root)) !== key(root)) throw new CliError(`Refusing: managed root resolves outside its intended path: ${root}`);

  let targetStat: fs.Stats;
  try { targetStat = fs.lstatSync(target); } catch { throw new CliError(`Refusing: target is missing or unregistered: ${target}`); }
  if (targetStat.isSymbolicLink() || !targetStat.isDirectory()) throw new CliError(`Refusing: target is a link/junction or not a worktree directory: ${target}`);
  const realTarget = fs.realpathSync(target);
  if (key(realTarget) !== key(target) || key(path.dirname(realTarget)) !== key(fs.realpathSync(root))) {
    throw new CliError(`Refusing: target does not resolve to a direct child of the managed root: ${target}`);
  }
  if (isAtOrUnder(fs.realpathSync(process.cwd()), realTarget)) {
    throw new CliError("Refusing: your current directory is inside the target worktree. Run teardown from another checkout.");
  }

  const entry = findEntry(entries, target);
  if (!entry) throw new CliError(`Refusing: target is not a registered Git worktree: ${target}`);
  if (key(entry.path) === key(primary)) throw new CliError("Refusing: the primary worktree is never removed.");
  if (entry.bare) throw new CliError("Refusing: target is bare.");
  if (entry.locked) throw new CliError(`Refusing: worktree is locked: ${target}`);
  if (entry.prunable) throw new CliError(`Refusing: worktree registration is stale/prunable: ${target}`);
  if (entry.detached || !entry.branch) throw new CliError(`Refusing: worktree has no attached branch (detached HEAD): ${target}`);

  const status = await git(["-C", target, "status", "--porcelain=v1", "-z", "--untracked-files=all"], primary);
  if (status.toString("utf8").split("\0").filter(Boolean).length > 0) {
    throw new CliError(`Refusing: worktree has tracked, staged or untracked changes: ${target}. Commit, stash or remove them yourself first.`);
  }
  // Git removal would also delete ignored files, so inspect them explicitly.
  const ignored = (await git(["-C", target, "ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"], primary))
    .toString("utf8").split("\0").filter(Boolean)
    .map((s) => s.replace(/\\/g, "/").replace(/\/$/, ""));
  for (const item of ignored) {
    const rootComponent = item.split("/")[0] as string;
    if (item !== rootComponent || !ALLOWED_IGNORED_ROOTS.has(rootComponent)) {
      throw new CliError(`Refusing: ignored content would be deleted: ${item} in ${target}. Only root node_modules/, dist/ and coverage/ are disposable. Move or delete it yourself first.`);
    }
    const ignoredStat = fs.lstatSync(path.join(target, rootComponent));
    if (ignoredStat.isSymbolicLink() || !ignoredStat.isDirectory()) {
      throw new CliError(`Refusing: ignored ${rootComponent} is a link or not a generated directory: ${target}`);
    }
  }

  await git(["worktree", "remove", target], primary);
  console.log(`Removed worktree ${target}. Branch ${entry.branch.replace(/^refs\/heads\//, "")} and its commits were retained.`);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (command === undefined || command === "--help" || command === "-h" || command === "help") { console.log(USAGE); return; }
  if (command === "setup") await setup(rest);
  else if (command === "list") await list(rest);
  else if (command === "teardown") await teardown(rest);
  else throw new UsageError(`Unknown command "${command}".\n` + USAGE);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(msg);
  process.exitCode = err instanceof UsageError ? 2 : 1;
});
