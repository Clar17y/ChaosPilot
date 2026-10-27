# ChaosPilot repository instructions

## Worktree workflow

- Use a task-owned worktree by default for implementation. Reuse the current
  task's existing worktree when continuing work; do not create a new checkout
  for every prompt, child agent, or small follow-up. Read-only work and small
  documentation edits can stay in the current checkout. Respect explicit user
  instructions about where to work.
- Before editing, inspect `git status --short`, `git branch --show-current`
  and `npm run worktree:list`. Preserve existing changes and identify which
  checkout and files this task owns. Never reset another task's work.
- If this task already has a suitable Codex-managed worktree attached, use it.
  Keep its lifecycle in the app's worktree/archive tools. The scripts below
  manage ordinary Git worktrees and refuse to remove external app-managed ones.
- Otherwise, create an ordinary worktree using the repository helper. Read
  [scripts/README.md](scripts/README.md) before setup or teardown:

  ```sh
  npm run worktree:setup -- <name> [--base <local-ref>] [--no-install]
  npm run worktree:list
  npm run worktree:teardown -- <name>
  ```

- Setup uses `codex/<name>` and the sibling `<primary>-worktrees/<name>` path.
  Select the base appropriate to the task; the default is local `main`, with
  no fetch or pull. Uncommitted changes are not copied. Do not silently start
  from another revision when continuing work that exists only in a checkout.
- Use the chosen worktree as the explicit working directory for commands and
  delegated tasks. Assign non-overlapping file ownership to concurrent writers;
  a worktree alone does not prevent agents in that checkout overwriting edits.
- Only tear down a worktree when it is no longer needed. Stop its agents and
  dev servers first, change to another checkout, and use the matching helper or
  app lifecycle tool. If removal refuses, preserve the checkout and report why;
  do not bypass it with forced removal, recursive deletion, reset, clean or prune.
  The ordinary helper retains branches and commits.

## Local configuration and evidence

- Worktrees have separate dependencies, `.env`, `runs/` and live-budget ledgers.
  Do not automatically copy credentials, ledgers, logs or investigation evidence.
  Give parallel dev servers distinct `CHAOSPILOT_PORT` values.
- Use the mock provider for development unless live execution and its budget are
  explicitly authorized and coordinated across checkouts. Never expose keys or
  switch to paid billing as a fallback. Mock results are not AI discovery evidence.

## Validation and handoff

- For code changes, run the relevant focused checks and required repository
  checks: `npm run typecheck`, `npm test` (which builds first), and any applicable
  end-to-end checks. Reuse matching evidence when code and inputs are unchanged;
  documentation-only edits do not need an application test rerun.
- Preserve inherited provider-routing and review requirements. Include this file
  in delegated task instructions and use that task's worktree as its workspace.
- Report the branch/worktree, changed scope, checks, remaining limitations and
  commit/push/PR state. Local files only become available in other checkouts or
  future clones after they are committed and integrated there.
