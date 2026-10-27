# Worktree scripts

Small helpers around ordinary [Git worktrees](https://git-scm.com/docs/git-worktree)
for parallel local checkouts of this repository. They are development tooling
only; the application build and runtime do not use them.

The repository's [AGENTS.md](../AGENTS.md) makes task-owned worktrees the default
for implementation. `CLAUDE.md` and `GEMINI.md` import that shared policy. Reuse
an existing task worktree; these instructions do not require a new one for each
prompt. Keep the parent chat/session in the main checkout and use the worktree
as an explicit execution directory for task commands. The files must be present
in the checkout where a future session starts.

```sh
npm run worktree:setup -- <name> [--base <local-ref>] [--no-install]
npm run worktree:list
npm run worktree:teardown -- <name>
```

Run them through the npm aliases. Setup uses `process.execPath` plus the
validated `npm_execpath` provided by npm (never a shell command); invoking the
TypeScript file directly therefore asks you to use the alias or `--no-install`.

## Keep the chat rooted outside temporary worktrees

The main Git checkout, the parent chat's working folder and a command's working
directory are separate concepts. Use the stable main checkout (for example
`C:/dev/ChaosPilot`), or an existing higher-level workspace, as the parent chat's
home. Create temporary task worktrees with these helpers instead of app actions
that move the chat into a worktree, unless the user explicitly requests that.

Run setup, listing and teardown from the main checkout. For implementation,
target files in the selected worktree and set each command's `workdir`/`cwd` to
that worktree; use `git -C <worktree>` for Git commands as appropriate. Bounded
workers also use the worktree as their execution workspace. Do not change the
parent chat's working folder or leave its persistent terminal inside the worktree.
This keeps implementation isolated while allowing cleanup from outside it.

For example, with a main checkout at `C:/dev/ChaosPilot`:

| Action | Execution directory |
| --- | --- |
| Keep the parent chat open; run `npm run worktree:setup -- ui-fix` | `C:/dev/ChaosPilot` |
| Edit task files; run builds, tests and task Git commands | `C:/dev/ChaosPilot-worktrees/ui-fix` |
| Stop task processes, preserve local data, then run `npm run worktree:teardown -- ui-fix` when finished | `C:/dev/ChaosPilot` |

A chat already attached to a Codex-managed worktree is an existing-work exception:
preserve and reuse it, then use the app's supported handoff/archive lifecycle.
The app may refuse to archive the chat's current checkout even though Git lists
it as a linked worktree. That does not make it the repository's main checkout.
Check the destination for other tasks' changes before any handoff. If the app
refuses cleanup, report the blocker; do not bypass it with a script or deletion.

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
the worktree first and run teardown from the main checkout, with no terminal
left inside the target. Keeping the parent chat in the main checkout avoids
making a temporary worktree its protected working folder. This is a checked
CLI, not containment against arbitrary simultaneous writers.

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
