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

describe("worktrees CLI", () => {
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

  it("refuses ignored secrets/evidence/logs but allows generated-only roots", () => {
    const { primary, root } = makeRepo();
    const target = path.join(root, "ign");
    expect(runCli(["setup", "ign", "--no-install"], primary).status).toBe(0);

    const cases: Array<[string, string]> = [
      [".env", "SECRET=1\n"],
      [path.join("runs", "evidence.txt"), "evidence\n"],
      ["app.log", "log line\n"],
      ["scratch-private.txt", "private\n"],
      [path.join(".llm-output", "note.txt"), "note\n"],
    ];
    for (const [rel, content] of cases) {
      const p = path.join(target, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content);
      const r = runCli(["teardown", "ign"], primary);
      expect(r.status, rel).not.toBe(0);
      expect(r.stderr).toContain("ignored");
      expect(fs.readFileSync(p, "utf8")).toBe(content);
      fs.rmSync(path.join(target, rel.split(path.sep)[0] as string), { recursive: true, force: true });
    }

    for (const dir of ["node_modules", "dist", "coverage"]) {
      fs.mkdirSync(path.join(target, dir), { recursive: true });
      fs.writeFileSync(path.join(target, dir, "out.bin"), "generated\n");
    }
    const ok = runCli(["teardown", "ign"], primary);
    expect(ok.status, ok.stderr).toBe(0);
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
