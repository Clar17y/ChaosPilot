# ChaosPilot repository instructions

## Worktree workflow

- Keep the parent chat/session anchored in the stable main checkout (for example
  `C:/dev/ChaosPilot`), or its existing higher-level workspace. A task worktree
  is a temporary execution directory, not the parent chat's primary checkout.
  Do not move the parent chat into it or use app create/attach/handoff actions
  that change the chat's working folder unless the user explicitly requests it.
- Use a task-owned worktree by default for implementation. Reuse the current
  task's existing worktree when continuing work; do not create a new checkout
  for every prompt, child agent, or small follow-up. Read-only work and small
  documentation edits can stay in the current checkout. Respect explicit user
  instructions about where to work.
- Before editing, inspect `git status --short`, `git branch --show-current`
  and `npm run worktree:list`. Preserve existing changes and identify which
  checkout and files this task owns. Never reset another task's work.
- For new task worktrees, use the repository helper from the main checkout,
  keeping the parent chat there. Read [scripts/README.md](scripts/README.md)
  before setup or teardown:

  ```sh
  npm run worktree:setup -- <name> [--base <local-ref>] [--no-install]
  npm run worktree:list
  npm run worktree:teardown -- <name>
  ```

  ```powershell
  .\scripts\setup-worktree.ps1 <name> [-Base <local-ref>] [-NoInstall]
  .\scripts\teardown-worktree.ps1 <name>
  ```

  A leading `codex/` prefix on `<name>` is accepted. There is no prompt or
  `--force` teardown option.

- Setup uses `codex/<name>` and the sibling `<primary>-worktrees/<name>` path.
  Select the base appropriate to the task; the default is local `main`, with
  no fetch or pull. Uncommitted changes are not copied. Do not silently start
  from another revision when continuing work that exists only in a checkout.
- Run task edits, Git operations, builds and tests against the worktree using
  explicit file paths and per-command `workdir`/`cwd` (or `git -C`). Give bounded
  workers that worktree as their execution workspace. This does not mean moving
  the parent chat or changing its persistent terminal directory. Keep main's
  branch and files untouched by implementation work. Assign non-overlapping
  file ownership to concurrent writers; a worktree alone does not prevent
  agents in that checkout overwriting edits.
- If continuing a chat already attached to a Codex-managed worktree, reuse it
  and preserve its work; do not create a replacement merely to follow the new
  default. Keep its lifecycle in the app's worktree/archive tools. The repository
  helper refuses external app-managed worktrees. If the app protects the chat's
  current checkout, use a supported handoff to a safe stable checkout before
  cleanup; never force removal. Check for other tasks' changes before handoff.
- Only tear down a worktree when it is no longer needed. Stop its agents and
  dev servers first, ensure no terminal is inside it, and run teardown from the
  main checkout using the matching helper or app lifecycle tool. The CLI is not
  containment against concurrent writers.
  Clean script-managed teardown first copies ignored local data (`.env`,
  `runs/`, `.llm-output/`, logs) byte-for-byte to a unique retained backup under
  the sibling `<primary>-worktree-backups/` and reports its location; only root
  `node_modules/`, `dist/` and `coverage/` are disposable. If backup or removal
  refuses, preserve the checkout and report why; do not bypass it with forced
  removal, recursive deletion, reset, clean or prune. The ordinary helper
  retains branches and commits.

## Local configuration and evidence

- Setup automatically copies the primary checkout's `.env` byte-for-byte when
  present (never printed, never overwriting an existing destination `.env`);
  if absent it continues with a clear message. Worktrees otherwise have
  separate dependencies, `runs/` and live-budget ledgers: setup does not copy
  ledgers, logs or investigation evidence, and each worktree's live-model budget
  ledger remains separate by default. Give parallel dev servers distinct
  `CHAOSPILOT_PORT` values.
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
