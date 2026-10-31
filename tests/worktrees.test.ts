import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(repoRoot, "scripts", "worktrees.ts");
const scratchRoots: string[] = [];

type Result = { status: number; stdout: string; stderr: string };

function runCli(args: string[], cwd: string, env: Record<string, string> = {}): Result {
  const childEnv: Record<string, string> = { ...(process.env as Record<string, string>) };
  // Windows environment names are case-insensitive; remove inherited aliases
  // before setting the explicit fake npm CLI (or testing its absence).
  for (const key of Object.keys(childEnv)) {
    if (key.toLowerCase() === "npm_execpath") delete childEnv[key];
  }
  Object.assign(childEnv, env);
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, env: childEnv, encoding: "utf8", windowsHide: true });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function git(args: string[], cwd: string): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

function makeRepo(initialBranch = "main"): { tmp: string; primary: string; root: string } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chaospilot-wt-"));
  scratchRoots.push(tmp);
  const primary = path.join(tmp, "primary repo"); // spaces in paths, deliberately
  fs.mkdirSync(primary, { recursive: true });
  git(["init", "-b", initialBranch], primary);
  git(["config", "user.email", "fixture@example.invalid"], primary);
  git(["config", "user.name", "Fixture"], primary);
  git(["config", "commit.gpgsign", "false"], primary);
  fs.writeFileSync(path.join(primary, "file.txt"), "base\n");
  fs.writeFileSync(path.join(primary, ".gitignore"), "node_modules/\ndist/\ncoverage/\n*.log\n.env\nruns/\n.llm-output/\nscratch*\n");
  git(["add", "."], primary);
  git(["commit", "-m", "base"], primary);
  return { tmp, primary, root: path.join(tmp, "primary repo-worktrees") };
}

function cleanupScratch(): void {
  for (const tmp of scratchRoots.splice(0)) {
    const realTmp = fs.realpathSync(os.tmpdir());
    const real = fs.realpathSync(tmp);
    const inside = real.toLowerCase().startsWith(realTmp.toLowerCase() + path.sep) && real.includes("chaospilot-wt-");
    if (!inside) throw new Error(`Refusing to delete unexpected scratch path: ${real}`);
    fs.rmSync(real, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
afterEach(cleanupScratch);

function writeFakeNpm(tmp: string): string {
  const fake = path.join(tmp, "fake-npm.mjs");
  fs.writeFileSync(fake, `import * as fs from "node:fs"; import * as path from "node:path";
if (process.env.WT_FAKE_NPM_FAIL) { console.error("fake npm failure"); process.exit(3); }
fs.mkdirSync(path.join(process.cwd(), "node_modules"), { recursive: true });
fs.writeFileSync(path.join(process.cwd(), "node_modules", ".installed"), "yes\\n");
`);
  return fake;
}

describe("worktrees CLI", { timeout: 30000 }, () => {
  it("creates, lists and removes a managed worktree; branch is retained", () => {
    const { primary, root } = makeRepo();
    const target = path.join(root, "alpha");
    const setup = runCli(["setup", "alpha", "--no-install"], primary);
    expect(setup.status, setup.stderr).toBe(0);
    expect(setup.stdout).toContain("Created worktree");
    expect(fs.readFileSync(path.join(target, "file.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("base\n");

    const listed = runCli(["list"], primary);
    expect(listed.status, listed.stderr).toBe(0);
    expect(listed.stdout).toMatch(/main\t/);
    expect(listed.stdout).toContain("managed\tcodex/alpha");
    expect(listed.stdout).toContain(target);

    const teardown = runCli(["teardown", "alpha"], primary);
    expect(teardown.status, teardown.stderr).toBe(0);
    expect(fs.existsSync(target)).toBe(false);
    expect(git(["show-ref", "--verify", "refs/heads/codex/alpha"], primary)).toContain("codex/alpha");
  });

  it("retains local commits and reuses the branch without reset; --base with existing branch fails", () => {
    const { primary, root } = makeRepo();
    const target = path.join(root, "beta");
    expect(runCli(["setup", "beta", "--no-install"], primary).status).toBe(0);
    fs.writeFileSync(path.join(target, "local.txt"), "local work\n");
    git(["add", "local.txt"], target);
    git(["commit", "-m", "local"], target);
    expect(runCli(["teardown", "beta"], primary).status).toBe(0);

    const withBase = runCli(["setup", "beta", "--base", "main", "--no-install"], primary);
    expect(withBase.status).not.toBe(0);
    expect(withBase.stderr).toContain("--base");
    expect(fs.existsSync(target)).toBe(false);

    const reused = runCli(["setup", "beta", "--no-install"], primary);
    expect(reused.status, reused.stderr).toBe(0);
    expect(reused.stdout).toContain("Reused existing branch codex/beta");
    expect(fs.readFileSync(path.join(target, "local.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("local work\n");
  });

  it("supports a custom base and rejects an invalid base before mutation", () => {
    const { primary, root } = makeRepo();
    git(["checkout", "-b", "release"], primary);
    fs.writeFileSync(path.join(primary, "rel.txt"), "release\n");
    git(["add", "rel.txt"], primary);
    git(["commit", "-m", "release"], primary);
    git(["checkout", "main"], primary);

    const ok = runCli(["setup", "gamma", "--base", "release", "--no-install"], primary);
    expect(ok.status, ok.stderr).toBe(0);
    expect(fs.existsSync(path.join(root, "gamma", "rel.txt"))).toBe(true);

    const bad = runCli(["setup", "delta", "--base", "does-not-exist", "--no-install"], primary);
    expect(bad.status).not.toBe(0);
    expect(fs.existsSync(path.join(root, "delta"))).toBe(false);
    expect(spawnSync("git", ["show-ref", "--verify", "refs/heads/codex/delta"], { cwd: primary }).status).not.toBe(0);
  });

  it("reuses a retained branch without a local main and validates bases only for new branches", () => {
    const { primary, root } = makeRepo("release");
    const target = path.join(root, "custom");
    const created = runCli(["setup", "custom", "--base", "release", "--no-install"], primary);
    expect(created.status, created.stderr).toBe(0);
    fs.writeFileSync(path.join(target, "local.txt"), "retained work\n");
    git(["add", "local.txt"], target);
    git(["commit", "-m", "local work"], target);
    const retainedCommit = git(["rev-parse", "HEAD"], target).trim();
    expect(runCli(["teardown", "custom"], primary).status).toBe(0);

    const explicitBase = runCli(["setup", "custom", "--base", "release", "--no-install"], primary);
    expect(explicitBase.status).not.toBe(0);
    expect(explicitBase.stderr).toContain("--base would be ignored");
    expect(fs.existsSync(target)).toBe(false);

    const missingDefault = runCli(["setup", "fresh", "--no-install"], primary);
    expect(missingDefault.status).not.toBe(0);
    expect(missingDefault.stderr).toContain('Base ref "main"');
    expect(fs.existsSync(path.join(root, "fresh"))).toBe(false);
    expect(git(["for-each-ref", "--format=%(refname)", "refs/heads/codex/fresh"], primary)).toBe("");

    const reused = runCli(["setup", "custom", "--no-install"], primary);
    expect(reused.status, reused.stderr).toBe(0);
    expect(reused.stdout).toContain("Reused existing branch codex/custom");
    expect(git(["rev-parse", "HEAD"], target).trim()).toBe(retainedCommit);
    expect(fs.readFileSync(path.join(target, "local.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("retained work\n");
    expect(git(["for-each-ref", "--format=%(refname)", "refs/heads/main"], primary)).toBe("");
  });

  it("resolves the same managed root when invoked from a linked checkout", () => {
    const { primary, root } = makeRepo();
    expect(runCli(["setup", "one", "--no-install"], primary).status).toBe(0);
    const fromLinked = runCli(["setup", "two", "--no-install"], path.join(root, "one"));
    expect(fromLinked.status, fromLinked.stderr).toBe(0);
    expect(fs.existsSync(path.join(root, "two", "file.txt"))).toBe(true);
    const listed = runCli(["list"], path.join(root, "one"));
    expect(listed.stdout).toContain(`Primary: ${primary}`);
    expect(listed.stdout).toContain("managed\tcodex/two");
  });

  it("rejects invalid names and options without creating anything", () => {
    const { primary, root } = makeRepo();
    for (const bad of ["../escape", "Bad", "-flag", "con", "a--b", "a/b", "a\\b", "a..b", "com1", ""]) {
      const r = runCli(["setup", bad, "--no-install"], primary);
      expect(r.status, `name ${JSON.stringify(bad)}`).not.toBe(0);
    }
    expect(runCli(["setup", "x", "--path", "/tmp/x"], primary).status).not.toBe(0);
    expect(runCli(["setup", "x", "--base"], primary).status).not.toBe(0);
    expect(runCli(["setup", "x", "extra", "--no-install"], primary).status).not.toBe(0);
    expect(runCli(["teardown", "x", "--force"], primary).status).not.toBe(0);
    expect(runCli(["list", "extra"], primary).status).not.toBe(0);
    expect(runCli(["bogus"], primary).status).toBe(2);
    expect(fs.existsSync(root)).toBe(false);
  });

  it("refuses teardown with tracked, staged or untracked changes and preserves bytes", () => {
    const { primary, root } = makeRepo();
    const target = path.join(root, "dirty");
    expect(runCli(["setup", "dirty", "--no-install"], primary).status).toBe(0);

    fs.writeFileSync(path.join(target, "file.txt"), "changed\n");
    let r = runCli(["teardown", "dirty"], primary);
    expect(r.status).not.toBe(0);
    expect(fs.readFileSync(path.join(target, "file.txt"), "utf8")).toBe("changed\n");
    git(["checkout", "--", "file.txt"], target);

    fs.writeFileSync(path.join(target, "staged.txt"), "staged\n");
    git(["add", "staged.txt"], target);
    r = runCli(["teardown", "dirty"], primary);
    expect(r.status).not.toBe(0);
    expect(fs.readFileSync(path.join(target, "staged.txt"), "utf8")).toBe("staged\n");
    git(["reset", "--hard", "HEAD"], target);

    fs.writeFileSync(path.join(target, "untracked.txt"), "keep me\n");
    r = runCli(["teardown", "dirty"], primary);
    expect(r.status).not.toBe(0);
    expect(fs.readFileSync(path.join(target, "untracked.txt"), "utf8")).toBe("keep me\n");
  });

  it("backs up ignored secrets/evidence/logs byte-for-byte, then removes; generated-only roots stay disposable", () => {
    const { tmp, primary, root } = makeRepo();
    const target = path.join(root, "ign");
    expect(runCli(["setup", "ign", "--no-install"], primary).status).toBe(0);

    const cases: Array<[string, string]> = [
      [".env", "SECRET=fixture-only\n"],
      [path.join("runs", "evidence.txt"), "evidence\n"],
      [path.join("runs", "deep dir", "unicodé log.txt"), "unicode content é\n"],
      ["app.log", "log line\n"],
      ["scratch-private.txt", "private\n"],
      [path.join(".llm-output", "note.txt"), "note\n"],
    ];
    for (const [rel, content] of cases) {
      const p = path.join(target, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content);
    }
    for (const dir of ["node_modules", "dist", "coverage"]) {
      fs.mkdirSync(path.join(target, dir), { recursive: true });
      fs.writeFileSync(path.join(target, dir, "out.bin"), "generated\n");
    }
    const ok = runCli(["teardown", "ign"], primary);
    expect(ok.status, ok.stderr).toBe(0);
    expect(fs.existsSync(target)).toBe(false);
    expect(git(["show-ref", "--verify", "refs/heads/codex/ign"], primary)).toContain("codex/ign");
    const m = ok.stdout.match(/Backed up \d+ ignored file\(s\) from .* to (.+?) \(verified byte-for-byte\)/);
    expect(m, ok.stdout).not.toBeNull();
    const backup = (m as RegExpMatchArray)[1] as string;
    expect(backup.startsWith(path.join(tmp, "primary repo-worktree-backups"))).toBe(true);
    for (const [rel, content] of cases) {
      expect(fs.readFileSync(path.join(backup, rel), "utf8"), rel).toBe(content);
    }
    expect(fs.existsSync(path.join(backup, "node_modules"))).toBe(false);
    expect(ok.stdout).not.toContain("SECRET=fixture-only");
    expect(ok.stderr).not.toContain("SECRET=fixture-only");
  });

  it("allows generated-only teardown without a backup", () => {
    const { tmp, primary, root } = makeRepo();
    const target = path.join(root, "genonly");
    expect(runCli(["setup", "genonly", "--no-install"], primary).status).toBe(0);
    for (const dir of ["node_modules", "dist", "coverage"]) {
      fs.mkdirSync(path.join(target, dir), { recursive: true });
      fs.writeFileSync(path.join(target, dir, "out.bin"), "generated\n");
    }
    const ok = runCli(["teardown", "genonly"], primary);
    expect(ok.status, ok.stderr).toBe(0);
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.existsSync(path.join(tmp, "primary repo-worktree-backups"))).toBe(false);
  });

  it("preserves an empty ignored directory in the backup", () => {
    const { primary, root } = makeRepo();
    const target = path.join(root, "emptydir");
    expect(runCli(["setup", "emptydir", "--no-install"], primary).status).toBe(0);
    fs.mkdirSync(path.join(target, "runs", "empty", "nested"), { recursive: true });
    fs.mkdirSync(path.join(target, "runs", "empty", "sibling leaf"), { recursive: true });
    fs.writeFileSync(path.join(target, "runs", "evidence.txt"), "evidence alongside empty dirs\n");
    const ok = runCli(["teardown", "emptydir"], primary);
    expect(ok.status, ok.stderr).toBe(0);
    expect(fs.existsSync(target)).toBe(false);
    const m = ok.stdout.match(/to (.+?) \(verified byte-for-byte\)/);
    const backup = (m as RegExpMatchArray)[1] as string;
    expect(fs.existsSync(path.join(backup, "runs", "empty", "nested"))).toBe(true);
    expect(fs.existsSync(path.join(backup, "runs", "empty", "sibling leaf"))).toBe(true);
    expect(fs.readFileSync(path.join(backup, "runs", "evidence.txt"), "utf8")).toBe("evidence alongside empty dirs\n");
  });

  it("fails teardown closed on a link inside an ignored directory tree, preserving source", () => {
    const { tmp, primary, root } = makeRepo();
    const target = path.join(root, "nestedlink");
    expect(runCli(["setup", "nestedlink", "--no-install"], primary).status).toBe(0);
    fs.mkdirSync(path.join(target, "runs", "empty", "nested"), { recursive: true });
    fs.writeFileSync(path.join(target, "runs", "evidence.txt"), "keep me\n");
    const external = path.join(tmp, "outside-tree");
    fs.mkdirSync(external);
    fs.writeFileSync(path.join(external, "sentinel.txt"), "outside\n");
    let linkMade = true;
    try { fs.symlinkSync(external, path.join(target, "runs", "empty", "linkdir"), process.platform === "win32" ? "junction" : "dir"); } catch { linkMade = false; }
    if (linkMade) {
      const r = runCli(["teardown", "nestedlink"], primary);
      expect(r.status, r.stdout + r.stderr).not.toBe(0);
      expect(fs.existsSync(target)).toBe(true);
      expect(fs.readFileSync(path.join(target, "runs", "evidence.txt"), "utf8")).toBe("keep me\n");
      expect(fs.existsSync(path.join(target, "runs", "empty", "nested"))).toBe(true);
      expect(fs.readFileSync(path.join(external, "sentinel.txt"), "utf8")).toBe("outside\n");
      expect(git(["worktree", "list", "--porcelain"], primary)).toContain("branch refs/heads/codex/nestedlink\n");
    }
  });

  it("backs up POSIX filenames containing literal backslashes distinctly from nested paths", () => {
    // Genuine fixture only on POSIX: Windows forbids `\` in a filename
    // component (it is the separator there), so this is unproved on Windows.
    if (process.platform === "win32") return;
    const { primary, root } = makeRepo();
    const target = path.join(root, "backslash");
    expect(runCli(["setup", "backslash", "--no-install"], primary).status).toBe(0);
    fs.mkdirSync(path.join(target, "runs", "a"), { recursive: true });
    fs.writeFileSync(path.join(target, "runs", "a\\b.log"), "literal backslash\n");
    fs.writeFileSync(path.join(target, "runs", "a", "b.log"), "nested path\n");
    fs.mkdirSync(path.join(target, "runs", "d\\e"), { recursive: true });
    const ok = runCli(["teardown", "backslash"], primary);
    expect(ok.status, ok.stderr).toBe(0);
    expect(fs.existsSync(target)).toBe(false);
    const m = ok.stdout.match(/to (.+?) \(verified byte-for-byte\)/);
    const backup = (m as RegExpMatchArray)[1] as string;
    expect(fs.readFileSync(path.join(backup, "runs", "a\\b.log"), "utf8")).toBe("literal backslash\n");
    expect(fs.readFileSync(path.join(backup, "runs", "a", "b.log"), "utf8")).toBe("nested path\n");
    expect(fs.existsSync(path.join(backup, "runs", "d\\e"))).toBe(true);
  });

  it("copies primary .env byte-for-byte on setup (also --no-install and reused branch); absent .env continues; codex/ prefix accepted", () => {
    const { primary, root } = makeRepo();
    const target = path.join(root, "envcopy");
    const secret = "FIXTURE_KEY=dummy-only-value\r\nOTHER=1\n";
    fs.writeFileSync(path.join(primary, ".env"), secret);
    const setup = runCli(["setup", "codex/envcopy", "--no-install"], primary);
    expect(setup.status, setup.stderr).toBe(0);
    expect(setup.stdout).toContain("Copied .env");
    expect(setup.stdout).not.toContain("dummy-only-value");
    expect(setup.stderr).not.toContain("dummy-only-value");
    expect(fs.readFileSync(path.join(target, ".env"), "utf8")).toBe(secret);

    // .env copied by setup is backed up by an immediate teardown.
    const td = runCli(["teardown", "codex/envcopy"], primary);
    expect(td.status, td.stderr).toBe(0);
    expect(fs.existsSync(target)).toBe(false);
    const m = td.stdout.match(/to (.+?) \(verified byte-for-byte\)/);
    expect(fs.readFileSync(path.join((m as RegExpMatchArray)[1] as string, ".env"), "utf8")).toBe(secret);

    // Reused branch also receives the .env copy.
    const reused = runCli(["setup", "envcopy", "--no-install"], primary);
    expect(reused.status, reused.stderr).toBe(0);
    expect(reused.stdout).toContain("Reused existing branch");
    expect(fs.readFileSync(path.join(target, ".env"), "utf8")).toBe(secret);
    expect(runCli(["teardown", "envcopy"], primary).status).toBe(0);

    // Absent .env: success with a clear message.
    fs.unlinkSync(path.join(primary, ".env"));
    const missing = runCli(["setup", "noenv", "--no-install"], primary);
    expect(missing.status, missing.stderr).toBe(0);
    expect(missing.stdout).toContain("No .env found in the primary checkout");
    expect(fs.existsSync(path.join(root, "noenv", ".env"))).toBe(false);
    expect(runCli(["teardown", "noenv"], primary).status).toBe(0);
  });

  it("does not overwrite an existing destination .env (tracked .env) on setup", () => {
    const { primary, root } = makeRepo();
    fs.writeFileSync(path.join(primary, ".env"), "TRACKED=committed\n");
    git(["add", "-f", ".env"], primary);
    git(["commit", "-m", "track env fixture"], primary);
    fs.writeFileSync(path.join(primary, ".env"), "SECRET=primary-local\n");
    const setup = runCli(["setup", "trackenv", "--no-install"], primary);
    expect(setup.status, setup.stderr).toBe(0);
    expect(setup.stdout).toContain("already exists");
    expect(fs.readFileSync(path.join(root, "trackenv", ".env"), "utf8").replace(/\r\n/g, "\n")).toBe("TRACKED=committed\n");
  });

  it("fails teardown closed when the backup root is a link, preserving source bytes", () => {
    const { tmp, primary, root } = makeRepo();
    const target = path.join(root, "safebackup");
    expect(runCli(["setup", "safebackup", "--no-install"], primary).status).toBe(0);
    fs.writeFileSync(path.join(target, ".env"), "SECRET=keep-me\n");
    const external = path.join(tmp, "elsewhere-backup");
    fs.mkdirSync(external);
    fs.writeFileSync(path.join(external, "sentinel.txt"), "outside\n");
    fs.symlinkSync(external, path.join(tmp, "primary repo-worktree-backups"), "junction");
    const r = runCli(["teardown", "safebackup"], primary);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("backup root");
    expect(fs.readFileSync(path.join(target, ".env"), "utf8")).toBe("SECRET=keep-me\n");
    expect(fs.readFileSync(path.join(external, "sentinel.txt"), "utf8")).toBe("outside\n");
    expect(fs.readdirSync(external)).toEqual(["sentinel.txt"]);
  });

  it("fails teardown closed on an ignored symlink after a partial copy, preserving source", () => {
    const { tmp, primary, root } = makeRepo();
    const target = path.join(root, "partial");
    expect(runCli(["setup", "partial", "--no-install"], primary).status).toBe(0);
    fs.mkdirSync(path.join(target, "runs"), { recursive: true });
    fs.writeFileSync(path.join(target, "runs", "a.txt"), "first copied\n");
    const external = path.join(tmp, "outside-secret.txt");
    fs.writeFileSync(external, "outside\n");
    let linkMade = true;
    try { fs.symlinkSync(external, path.join(target, "runs", "z-link.txt")); } catch { linkMade = false; }
    if (linkMade) {
      const r = runCli(["teardown", "partial"], primary);
      expect(r.status, r.stdout + r.stderr).not.toBe(0);
      expect(fs.readFileSync(path.join(target, "runs", "a.txt"), "utf8")).toBe("first copied\n");
      expect(fs.readFileSync(external, "utf8")).toBe("outside\n");
      expect(fs.existsSync(target)).toBe(true);
      const backupsRoot = path.join(tmp, "primary repo-worktree-backups");
      if (fs.existsSync(backupsRoot)) {
        const partials = fs.readdirSync(backupsRoot).filter((d) => d.startsWith("partial-"));
        // If a partial backup was retained, the first file is recoverable there.
        if (partials.length > 0) {
          expect(fs.readFileSync(path.join(backupsRoot, partials[0] as string, "runs", "a.txt"), "utf8")).toBe("first copied\n");
        }
      }
    }
  });

  it("PowerShell wrappers delegate setup/teardown and accept codex/ (Windows)", () => {
    if (process.platform !== "win32") return;
    const { primary, root } = makeRepo();
    const setupPs = path.join(primary, "scripts", "setup-worktree.ps1");
    const teardownPs = path.join(primary, "scripts", "teardown-worktree.ps1");
    // Install the real scripts + a minimal npm alias map into the fixture.
    fs.mkdirSync(path.join(primary, "scripts"), { recursive: true });
    for (const f of ["worktrees.ts", "setup-worktree.ps1", "teardown-worktree.ps1"]) {
      fs.copyFileSync(path.join(repoRoot, "scripts", f), path.join(primary, "scripts", f));
    }
    fs.writeFileSync(path.join(primary, "package.json"), JSON.stringify({ name: "fixture", private: true, type: "module", scripts: { "worktree:setup": "node scripts/worktrees.ts setup", "worktree:teardown": "node scripts/worktrees.ts teardown", "worktree:list": "node scripts/worktrees.ts list" } }));
    git(["add", "."], primary);
    git(["commit", "-m", "fixture scripts"], primary);
    expect(fs.existsSync(setupPs)).toBe(true);
    expect(fs.existsSync(teardownPs)).toBe(true);
    const ps = (args: string[]) => spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", ...args], { cwd: primary, encoding: "utf8", windowsHide: true });
    const s = ps(["-File", setupPs, "codex/pswrap", "-NoInstall"]);
    expect(s.status, (s.stderr ?? "") + (s.stdout ?? "")).toBe(0);
    expect(fs.existsSync(path.join(root, "pswrap", "file.txt"))).toBe(true);
    const t = ps(["-File", teardownPs, "pswrap"]);
    expect(t.status, (t.stderr ?? "") + (t.stdout ?? "")).toBe(0);
    expect(fs.existsSync(path.join(root, "pswrap"))).toBe(false);
  });

  it("PowerShell teardown wrapper refuses when the caller's cwd is the target, via the primary wrapper and a junction alias (Windows)", () => {
    if (process.platform !== "win32") return;
    const { tmp, primary, root } = makeRepo();
    fs.mkdirSync(path.join(primary, "scripts"), { recursive: true });
    for (const f of ["worktrees.ts", "setup-worktree.ps1", "teardown-worktree.ps1"]) {
      fs.copyFileSync(path.join(repoRoot, "scripts", f), path.join(primary, "scripts", f));
    }
    fs.writeFileSync(path.join(primary, "package.json"), JSON.stringify({ name: "fixture", private: true, type: "module", scripts: { "worktree:setup": "node scripts/worktrees.ts setup", "worktree:teardown": "node scripts/worktrees.ts teardown", "worktree:list": "node scripts/worktrees.ts list" } }));
    git(["add", "."], primary);
    git(["commit", "-m", "fixture scripts"], primary);
    const target = path.join(root, "psactive");
    expect(runCli(["setup", "psactive", "--no-install"], primary).status).toBe(0);
    fs.writeFileSync(path.join(target, ".env"), "SECRET=caller-cwd-fixture\n");
    const teardownPs = path.join(primary, "scripts", "teardown-worktree.ps1");
    const psFrom = (cwd: string) => spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", teardownPs, "psactive"], { cwd, encoding: "utf8", windowsHide: true });

    const backupsRoot = path.join(tmp, "primary repo-worktree-backups");
    for (const cwd of [target, path.join(target, "scripts")]) {
      const r = psFrom(cwd);
      expect(r.status, (r.stderr ?? "") + (r.stdout ?? "")).not.toBe(0);
      expect((r.stderr ?? "") + (r.stdout ?? "")).toContain("current directory");
      expect(fs.existsSync(target)).toBe(true);
      expect(fs.readFileSync(path.join(target, ".env"), "utf8")).toBe("SECRET=caller-cwd-fixture\n");
      expect(fs.readFileSync(path.join(target, "file.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("base\n");
      expect(git(["worktree", "list", "--porcelain"], primary)).toContain("branch refs/heads/codex/psactive\n");
      expect(fs.existsSync(backupsRoot)).toBe(false);
    }

    let aliasMade = true;
    const alias = path.join(tmp, "ps-cwd-alias");
    try { fs.symlinkSync(target, alias, "junction"); } catch { aliasMade = false; }
    if (aliasMade) {
      for (const cwd of [alias, path.join(alias, "scripts")]) {
        const r = psFrom(cwd);
        expect(r.status, (r.stderr ?? "") + (r.stdout ?? "")).not.toBe(0);
        expect((r.stderr ?? "") + (r.stdout ?? "")).toContain("current directory");
        expect(fs.existsSync(target)).toBe(true);
        expect(fs.readFileSync(path.join(target, ".env"), "utf8")).toBe("SECRET=caller-cwd-fixture\n");
        expect(git(["worktree", "list", "--porcelain"], primary)).toContain("branch refs/heads/codex/psactive\n");
        expect(fs.existsSync(backupsRoot)).toBe(false);
      }
    }

    // Normal invocation from the primary checkout still succeeds.
    const ok = psFrom(primary);
    expect(ok.status, (ok.stderr ?? "") + (ok.stdout ?? "")).toBe(0);
    expect(fs.existsSync(target)).toBe(false);
  });

  it("refuses a symlinked/junction ignored root and preserves its sentinel", () => {
    const { tmp, primary, root } = makeRepo();
    const target = path.join(root, "linkign");
    expect(runCli(["setup", "linkign", "--no-install"], primary).status).toBe(0);
    const external = path.join(tmp, "external-deps");
    fs.mkdirSync(external);
    fs.writeFileSync(path.join(external, "sentinel.txt"), "do not delete\n");
    fs.symlinkSync(external, path.join(target, "node_modules"), "junction");
    const r = runCli(["teardown", "linkign"], primary);
    expect(r.status).not.toBe(0);
    expect(fs.readFileSync(path.join(external, "sentinel.txt"), "utf8")).toBe("do not delete\n");
  });

  it("preserves ignored regular files named like disposable directories", () => {
    const { primary, root } = makeRepo();
    // Git excludes can match files as well as directories, including global rules.
    fs.appendFileSync(path.join(primary, ".gitignore"), "node_modules\ndist\ncoverage\n");
    git(["add", ".gitignore"], primary);
    git(["commit", "-m", "ignore generated names of any type"], primary);
    const target = path.join(root, "regular");
    expect(runCli(["setup", "regular", "--no-install"], primary).status).toBe(0);

    for (const name of ["node_modules", "dist", "coverage"]) {
      const file = path.join(target, name);
      fs.writeFileSync(file, `private ${name}\n`);
      const result = runCli(["teardown", "regular"], primary);
      expect(result.status, name).not.toBe(0);
      expect(result.stderr).toContain("not a generated directory");
      expect(fs.readFileSync(file, "utf8")).toBe(`private ${name}\n`);
      expect(fs.readFileSync(path.join(target, "file.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("base\n");
      expect(git(["worktree", "list", "--porcelain"], primary)).toContain("branch refs/heads/codex/regular\n");
      fs.unlinkSync(file);
    }
    expect(runCli(["teardown", "regular"], primary).status).toBe(0);
  });

  it("rejects a dangling setup target before creating a branch", () => {
    const { tmp, primary, root } = makeRepo();
    fs.mkdirSync(root);
    const outside = path.join(tmp, "outside");
    fs.mkdirSync(outside);
    const sentinel = path.join(outside, "sentinel.txt");
    fs.writeFileSync(sentinel, "keep outside\n");
    const missing = path.join(outside, "missing");
    const target = path.join(root, "dangling");
    fs.symlinkSync(missing, target, process.platform === "win32" ? "junction" : "dir");

    const result = runCli(["setup", "dangling", "--no-install"], primary);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Target already exists");
    expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(missing)).toBe(false);
    expect(fs.readFileSync(sentinel, "utf8")).toBe("keep outside\n");
    expect(spawnSync("git", ["show-ref", "--verify", "refs/heads/codex/dangling"], { cwd: primary }).status).not.toBe(0);
  });

  it("refuses teardown from a cwd junction alias before deleting tracked files", () => {
    const { tmp, primary, root } = makeRepo();
    const target = path.join(root, "active");
    expect(runCli(["setup", "active", "--no-install"], primary).status).toBe(0);
    const nested = path.join(target, "nested");
    fs.mkdirSync(nested);
    fs.writeFileSync(path.join(nested, "evidence.txt"), "nested evidence\n");
    git(["add", "nested"], target);
    git(["commit", "-m", "nested fixture"], target);
    const alias = path.join(tmp, "cwd-alias");
    fs.symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir");

    for (const cwd of [alias, path.join(alias, "nested")]) {
      const result = runCli(["teardown", "active"], cwd);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("current directory");
      expect(fs.readFileSync(path.join(target, "file.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("base\n");
      expect(fs.readFileSync(path.join(nested, "evidence.txt"), "utf8")).toBe("nested evidence\n");
      expect(git(["worktree", "list", "--porcelain"], primary)).toContain("branch refs/heads/codex/active\n");
    }
    expect(runCli(["teardown", "active"], primary).status).toBe(0);
  });

  it("refuses link managed root (setup) and link target (teardown), preserving sentinels", () => {
    const a = makeRepo();
    const extA = path.join(a.tmp, "elsewhere");
    fs.mkdirSync(extA);
    fs.writeFileSync(path.join(extA, "sentinel.txt"), "root sentinel\n");
    fs.symlinkSync(extA, a.root, "junction");
    const setup = runCli(["setup", "nope", "--no-install"], a.primary);
    expect(setup.status).not.toBe(0);
    expect(setup.stderr).toContain("link");
    expect(fs.readFileSync(path.join(extA, "sentinel.txt"), "utf8")).toBe("root sentinel\n");
    expect(spawnSync("git", ["show-ref", "--verify", "refs/heads/codex/nope"], { cwd: a.primary }).status).not.toBe(0);

    const b = makeRepo();
    fs.mkdirSync(b.root, { recursive: true });
    const extB = path.join(b.tmp, "elsewhere");
    fs.mkdirSync(extB);
    fs.writeFileSync(path.join(extB, "sentinel.txt"), "target sentinel\n");
    fs.symlinkSync(extB, path.join(b.root, "victim"), "junction");
    const teardown = runCli(["teardown", "victim"], b.primary);
    expect(teardown.status).not.toBe(0);
    expect(teardown.stderr).toContain("link");
    expect(fs.readFileSync(path.join(extB, "sentinel.txt"), "utf8")).toBe("target sentinel\n");
  });

  it("refuses locked, detached, current-directory, external and missing targets", () => {
    const { tmp, primary, root } = makeRepo();
    expect(runCli(["setup", "lockme", "--no-install"], primary).status).toBe(0);
    const lockTarget = path.join(root, "lockme");
    git(["worktree", "lock", lockTarget], primary);
    expect(runCli(["teardown", "lockme"], primary).status).not.toBe(0);
    expect(fs.existsSync(lockTarget)).toBe(true);
    git(["worktree", "unlock", lockTarget], primary);

    const inside = runCli(["teardown", "lockme"], lockTarget);
    expect(inside.status).not.toBe(0);
    expect(inside.stderr).toContain("current directory");
    expect(runCli(["teardown", "lockme"], primary).status).toBe(0);

    // Detached worktree at a managed path.
    fs.mkdirSync(root, { recursive: true });
    const det = path.join(root, "det");
    git(["worktree", "add", "--detach", det, "HEAD"], primary);
    const detResult = runCli(["teardown", "det"], primary);
    expect(detResult.status).not.toBe(0);
    expect(detResult.stderr).toContain("detached");
    git(["worktree", "remove", det], primary);

    // External checkout is listed but teardown by name cannot reach it.
    const external = path.join(tmp, "external-checkout");
    git(["worktree", "add", external, "-b", "external-branch"], primary);
    const listed = runCli(["list"], primary);
    expect(listed.stdout).toContain("external\texternal-branch");
    const extTeardown = runCli(["teardown", "external-checkout"], primary);
    expect(extTeardown.status).not.toBe(0);
    expect(fs.existsSync(path.join(external, "file.txt"))).toBe(true);

    expect(runCli(["teardown", "missing"], primary).status).not.toBe(0);
    expect(fs.existsSync(primary)).toBe(true);
  });

  it("handles the npm boundary: direct invocation, fake npm success and failure", () => {
    const { tmp, primary, root } = makeRepo();
    const fake = writeFakeNpm(tmp);

    const direct = runCli(["setup", "direct"], primary);
    expect(direct.status).not.toBe(0);
    expect(direct.stderr).toContain("npm_execpath");
    expect(fs.existsSync(path.join(root, "direct", "file.txt"))).toBe(true);
    expect(runCli(["teardown", "direct"], primary).status).toBe(0);

    const ok = runCli(["setup", "fakeok"], primary, { npm_execpath: fake });
    expect(ok.status, ok.stderr + ok.stdout).toBe(0);
    expect(fs.readFileSync(path.join(root, "fakeok", "node_modules", ".installed"), "utf8")).toBe("yes\n");
    expect(runCli(["teardown", "fakeok"], primary).status).toBe(0);

    const bad = runCli(["setup", "fakebad"], primary, { npm_execpath: fake, WT_FAKE_NPM_FAIL: "1" });
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toContain("preserved");
    expect(fs.existsSync(path.join(root, "fakebad", "file.txt"))).toBe(true);
    expect(git(["show-ref", "--verify", "refs/heads/codex/fakebad"], primary)).toContain("codex/fakebad");
    expect(runCli(["teardown", "fakebad"], primary).status).toBe(0);
  });

  it("backs up nested .git contents under an ignored tree byte-for-byte (mixed and ignored-only)", () => {
    const { primary, root } = makeRepo();
    const target = path.join(root, "igngit");
    expect(runCli(["setup", "igngit", "--no-install"], primary).status).toBe(0);
    const cases: Array<[string, string]> = [
      [path.join("runs", ".git", "secret"), "runs-git-secret\n"],
      [path.join("runs", ".git", "hooks", "hook.txt"), "hook\n"],
      [path.join("runs", "project", ".git", "config"), "[core]\n\tdeep = true\n"],
      [path.join("runs", "sub", ".git"), "gitdir: ../elsewhere\n"],
      [path.join("runs", "ordinary.txt"), "ordinary ignored\n"],
    ];
    for (const [rel, content] of cases) {
      const p = path.join(target, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content);
    }
    fs.mkdirSync(path.join(target, "runs", ".git", "empty", "nested"), { recursive: true });
    const ok = runCli(["teardown", "igngit"], primary);
    expect(ok.status, ok.stderr).toBe(0);
    expect(fs.existsSync(target)).toBe(false);
    expect(ok.stdout + ok.stderr).not.toContain("runs-git-secret");
    expect(git(["show-ref", "--verify", "refs/heads/codex/igngit"], primary)).toContain("codex/igngit");
    const m = ok.stdout.match(/to (.+?) \(verified byte-for-byte\)/);
    expect(m, ok.stdout).not.toBeNull();
    const backup = (m as RegExpMatchArray)[1] as string;
    for (const [rel, content] of cases) expect(fs.readFileSync(path.join(backup, rel), "utf8"), rel).toBe(content);
    expect(fs.existsSync(path.join(backup, "runs", ".git", "empty", "nested"))).toBe(true);

    // Ignored tree containing only nested .git data (invisible to git ls-files).
    const solo = path.join(root, "igngitonly");
    expect(runCli(["setup", "igngitonly", "--no-install"], primary).status).toBe(0);
    fs.mkdirSync(path.join(solo, "runs", ".git"), { recursive: true });
    fs.writeFileSync(path.join(solo, "runs", ".git", "secret"), "only-secret\n");
    const ok2 = runCli(["teardown", "igngitonly"], primary);
    expect(ok2.status, ok2.stderr).toBe(0);
    expect(fs.existsSync(solo)).toBe(false);
    const m2 = ok2.stdout.match(/to (.+?) \(verified byte-for-byte\)/);
    expect(m2, ok2.stdout).not.toBeNull();
    expect(fs.readFileSync(path.join((m2 as RegExpMatchArray)[1] as string, "runs", ".git", "secret"), "utf8")).toBe("only-secret\n");
  });

  it("backs up nested .git under an ignored directory nested inside a tracked parent", () => {
    const { primary, root } = makeRepo();
    const target = path.join(root, "trackedign");
    expect(runCli(["setup", "trackedign", "--no-install"], primary).status).toBe(0);
    fs.mkdirSync(path.join(target, "tracked"), { recursive: true });
    fs.writeFileSync(path.join(target, "tracked", "keep.txt"), "keep\n");
    git(["add", "tracked"], target);
    git(["commit", "-m", "tracked parent"], target);
    // `scratch*` is ignored at any depth in the fixture .gitignore.
    fs.mkdirSync(path.join(target, "tracked", "scratch-data", ".git"), { recursive: true });
    fs.writeFileSync(path.join(target, "tracked", "scratch-data", ".git", "secret"), "nested-ignored-secret\n");
    fs.writeFileSync(path.join(target, "tracked", "scratch-data", "data.txt"), "nested ignored data\n");
    const ok = runCli(["teardown", "trackedign"], primary);
    expect(ok.status, ok.stderr).toBe(0);
    expect(fs.existsSync(target)).toBe(false);
    const m = ok.stdout.match(/to (.+?) \(verified byte-for-byte\)/);
    expect(m, ok.stdout).not.toBeNull();
    const backup = (m as RegExpMatchArray)[1] as string;
    expect(fs.readFileSync(path.join(backup, "tracked", "scratch-data", ".git", "secret"), "utf8")).toBe("nested-ignored-secret\n");
    expect(fs.readFileSync(path.join(backup, "tracked", "scratch-data", "data.txt"), "utf8")).toBe("nested ignored data\n");
  });

  it("refuses teardown on nested .git under unignored/tracked parents, preserving source and registration", () => {
    const { tmp, primary, root } = makeRepo();
    const target = path.join(root, "nestedgit");
    expect(runCli(["setup", "nestedgit", "--no-install"], primary).status).toBe(0);
    // Tracked parent directory.
    fs.mkdirSync(path.join(target, "tracked"), { recursive: true });
    fs.writeFileSync(path.join(target, "tracked", "keep.txt"), "keep\n");
    git(["add", "tracked"], target);
    git(["commit", "-m", "tracked parent"], target);
    const backupsRoot = path.join(tmp, "primary repo-worktree-backups");
    const expectRefusal = (relGit: string, secretRel: string, secret: string) => {
      const r = runCli(["teardown", "nestedgit"], primary);
      expect(r.status, r.stdout + r.stderr).not.toBe(0);
      expect(r.stderr).toContain("nested .git");
      expect(r.stderr).toContain(relGit);
      expect(r.stdout + r.stderr).not.toContain(secret.trim());
      expect(fs.readFileSync(path.join(target, secretRel), "utf8")).toBe(secret);
      expect(fs.existsSync(target)).toBe(true);
      expect(git(["worktree", "list", "--porcelain"], primary)).toContain("branch refs/heads/codex/nestedgit");
      expect(fs.existsSync(backupsRoot)).toBe(false);
    };

    fs.mkdirSync(path.join(target, "tracked", ".git"), { recursive: true });
    fs.writeFileSync(path.join(target, "tracked", ".git", "secret"), "tracked-secret\n");
    expectRefusal("tracked/.git", path.join("tracked", ".git", "secret"), "tracked-secret\n");
    fs.rmSync(path.join(target, "tracked", ".git"), { recursive: true, force: true });

    // Unignored parent, .git directory.
    fs.mkdirSync(path.join(target, "ordinary", ".git"), { recursive: true });
    fs.writeFileSync(path.join(target, "ordinary", ".git", "secret"), "ordinary-secret\n");
    expectRefusal("ordinary/.git", path.join("ordinary", ".git", "secret"), "ordinary-secret\n");
    fs.rmSync(path.join(target, "ordinary"), { recursive: true, force: true });

    // Deeper unignored parent, .git file.
    fs.mkdirSync(path.join(target, "a", "b"), { recursive: true });
    fs.writeFileSync(path.join(target, "a", "b", "keep.txt"), "deep keep\n");
    git(["add", "a"], target);
    git(["commit", "-m", "deep parent"], target);
    fs.writeFileSync(path.join(target, "a", "b", ".git"), "gitdir: ../elsewhere\n");
    expectRefusal("a/b/.git", path.join("a", "b", ".git"), "gitdir: ../elsewhere\n");
    fs.unlinkSync(path.join(target, "a", "b", ".git"));

    // A clean teardown still succeeds afterwards (root .git marker is not nested).
    const ok = runCli(["teardown", "nestedgit"], primary);
    expect(ok.status, ok.stderr).toBe(0);
    expect(fs.existsSync(target)).toBe(false);
    expect(git(["show-ref", "--verify", "refs/heads/codex/nestedgit"], primary)).toContain("codex/nestedgit");
  });

  it("refuses Windows .git aliases before deleting or unregistering the worktree", () => {
    if (process.platform !== "win32") return;
    for (const [name, gitName, atRoot] of [
      ["uppergit", ".GIT", false],
      ["mixedgit", ".Git", false],
      ["dotgit", ".git.", false],
      ["spacegit", ".git ", false],
      ["rootdotgit", ".git.", true],
    ] as const) {
      const { primary, root } = makeRepo();
      const target = path.join(root, name);
      expect(runCli(["setup", name, "--no-install"], primary).status).toBe(0);
      const parent = atRoot ? target : path.join(target, "ordinary");
      const metadata = path.join(parent, gitName);
      fs.mkdirSync(metadata, { recursive: true });
      fs.writeFileSync(path.join(metadata, "secret"), "fixture metadata\n");

      const result = runCli(["teardown", name], primary);
      expect(result.status, result.stdout + result.stderr).not.toBe(0);
      expect(result.stderr).toContain("nested .git");
      expect(fs.readFileSync(path.join(metadata, "secret"), "utf8")).toBe("fixture metadata\n");
      expect(fs.existsSync(path.join(target, "file.txt"))).toBe(true);
      expect(git(["worktree", "list", "--porcelain"], primary)).toContain(`branch refs/heads/codex/${name}`);
    }
  }, 20000);

  it("refuses or safely preserves a real nested Git repository and never traverses a link in an ignored .git tree", () => {
    const { tmp, primary, root } = makeRepo();
    const target = path.join(root, "realnested");
    expect(runCli(["setup", "realnested", "--no-install"], primary).status).toBe(0);
    fs.mkdirSync(path.join(target, "tracked"), { recursive: true });
    fs.writeFileSync(path.join(target, "tracked", "keep.txt"), "keep\n");
    git(["add", "tracked"], target);
    git(["commit", "-m", "tracked parent"], target);
    const inner = path.join(target, "tracked", "inner");
    git(["init", "-b", "main", inner], target);
    git(["config", "user.email", "fixture@example.invalid"], inner);
    git(["config", "user.name", "Fixture"], inner);
    git(["config", "commit.gpgsign", "false"], inner);
    fs.writeFileSync(path.join(inner, "inner.txt"), "inner work\n");
    git(["add", "."], inner);
    git(["commit", "-m", "inner"], inner);
    const head = git(["rev-parse", "HEAD"], inner).trim();
    const r = runCli(["teardown", "realnested"], primary);
    expect(r.status, r.stdout + r.stderr).not.toBe(0);
    expect(fs.existsSync(target)).toBe(true);
    expect(git(["rev-parse", "HEAD"], inner).trim()).toBe(head);
    expect(fs.readFileSync(path.join(inner, "inner.txt"), "utf8")).toBe("inner work\n");
    expect(git(["worktree", "list", "--porcelain"], primary)).toContain("branch refs/heads/codex/realnested");

    // Link inside an ignored nested .git tree: fail closed, sentinel untouched.
    const target2 = path.join(root, "gitlink");
    expect(runCli(["setup", "gitlink", "--no-install"], primary).status).toBe(0);
    const external = path.join(tmp, "outside-git");
    fs.mkdirSync(external);
    fs.writeFileSync(path.join(external, "sentinel.txt"), "outside\n");
    fs.mkdirSync(path.join(target2, "runs", ".git"), { recursive: true });
    fs.writeFileSync(path.join(target2, "runs", ".git", "secret"), "keep me\n");
    let linkMade = true;
    try { fs.symlinkSync(external, path.join(target2, "runs", ".git", "linkdir"), process.platform === "win32" ? "junction" : "dir"); } catch { linkMade = false; }
    if (linkMade) {
      const r2 = runCli(["teardown", "gitlink"], primary);
      expect(r2.status, r2.stdout + r2.stderr).not.toBe(0);
      expect(fs.readFileSync(path.join(target2, "runs", ".git", "secret"), "utf8")).toBe("keep me\n");
      expect(fs.readFileSync(path.join(external, "sentinel.txt"), "utf8")).toBe("outside\n");
      expect(fs.existsSync(target2)).toBe(true);
    }
  });

  it.each(["main", "release"])("refuses to reuse a branch checked out in an external worktree (%s primary)", (initialBranch) => {
    const { tmp, primary, root } = makeRepo(initialBranch);
    expect(runCli(["setup", "shared", "--base", initialBranch, "--no-install"], primary).status).toBe(0);
    expect(runCli(["teardown", "shared"], primary).status).toBe(0);
    const external = path.join(tmp, "elsewhere-checkout");
    git(["worktree", "add", external, "codex/shared"], primary);
    const r = runCli(["setup", "shared", "--no-install"], primary);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("already checked out");
    expect(fs.existsSync(path.join(root, "shared"))).toBe(false);
  });
});
