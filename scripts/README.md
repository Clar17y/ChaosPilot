# Worktree scripts

Small helpers around ordinary [Git worktrees](https://git-scm.com/docs/git-worktree)
for parallel local checkouts of this repository. They are development tooling
only; the application build and runtime do not use them.

The repository's [AGENTS.md](../AGENTS.md) makes task-owned worktrees the default
for implementation. `CLAUDE.md` and `GEMINI.md` import that shared policy. Reuse
an existing task worktree; these instructions do not require a new one for each
prompt. The files must be present in the checkout where a future session starts.

```sh
npm run worktree:setup -- <name> [--base <local-ref>] [--no-install]
npm run worktree:list
npm run worktree:teardown -- <name>
```

Run them through the npm aliases. Setup uses `process.execPath` plus the
validated `npm_execpath` provided by npm (never a shell command); invoking the
TypeScript file directly therefore asks you to use the alias or `--no-install`.

## Where worktrees go

The primary (first, non-bare) checkout is resolved from
`git worktree list --porcelain -z`, never from the script or caller location, so
every linked checkout agrees on the same root. Managed worktrees are direct
children of the sibling directory `<primary>-worktrees/` — for a primary at
`C:/dev/ChaosPilot` that is `C:/dev/ChaosPilot-worktrees/<name>`. There is no
`--path` override. Names are slugs: 1–64 lowercase ASCII letters, digits and
single hyphens; traversal, separators, option-like names and Windows reserved
device names are rejected.

`worktree:list` labels each registered checkout `main`, `managed` or
`external`. External checkouts (for example Codex-managed worktrees) are shown
for visibility but this tooling never removes them. These ordinary Git
worktrees are distinct from Codex-managed worktrees; use the application's
archive/restore flow for those.

## Setup semantics

- Creates branch `codex/<name>` from local `main` by default, or from
  `--base <local-ref>`. No fetch or pull is ever done.
- If `codex/<name>` already exists and is not checked out elsewhere, it is
  reused **without reset**, and the output says so. Passing `--base` with an
  existing branch is an error rather than silently ignored. Local commits on
  the branch are therefore kept across setup/teardown cycles. Reuse needs no
  base ref, so it also works when the repository has no local `main` branch.
- Fails if the target already exists (including a dangling link) or is
  registered, the branch is checked out elsewhere, a new branch's base does
  not resolve locally, or the managed root is unsafe (for example a symlink).
- Never copies or overwrites uncommitted files, `.env`, `runs/`, ledgers or
  logs from the current checkout. A fresh worktree starts from committed
  content only.
- By default it runs `npm ci --no-audit --no-fund` in the new checkout.
  `--no-install` skips that for offline or code-only work. If installation
  fails, the worktree and branch are preserved and the error prints recovery
  instructions; nothing is cleaned up automatically.

## Teardown safety

Teardown is deliberately conservative. Stop any agents or dev servers using
the worktree first — this is a checked CLI, not containment against arbitrary
simultaneous writers.

It refuses unless the target is a registered, non-primary, attached-branch
checkout at exactly the computed managed child path. It also refuses when:

- your current directory is inside the target, including via a symlink/junction;
- the target is missing, stale/unregistered, locked, detached or bare;
- the managed root or target is a symlink/junction, or resolves outside the
  intended sibling root;
- there are tracked, staged or untracked changes;
- there is ignored content other than root `node_modules/`, `dist/` or
  `coverage/`, which must be real directories rather than links or regular files.
  Ignored entries are inspected with
  [`git ls-files`](https://git-scm.com/docs/git-ls-files) because
  `git worktree remove` would otherwise delete them silently. In particular
  `.env`, `runs/`, `.llm-output/`, logs and unknown ignored scratch refuse
  teardown and are left byte-identical.

Removal uses `git worktree remove` without `--force`. There is no manual
recursive deletion, `reset`/`clean`/`prune`, and no branch deletion: the branch
and any local (even unpushed) commits are retained and can be reused by a
later `worktree:setup`.

## Working in parallel checkouts

Each checkout has separate dependencies, configuration and `runs/`. Give
parallel dev servers distinct ports, for example `CHAOSPILOT_PORT=4311`.
Application live-budget ledgers are separate per checkout: use the mock
provider unless live credentials and budget are explicitly coordinated between
the people/processes sharing the account. Do not copy `.env` or investigation
evidence between checkouts automatically; move anything deliberately, by hand.
