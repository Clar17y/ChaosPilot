<#
.SYNOPSIS
Remove a clean ChaosPilot script-managed worktree (familiar entry point).

.DESCRIPTION
Thin wrapper around the cross-platform CLI (`npm run worktree:teardown`).
There is no prompt and no -Force option: the CLI refuses dirty, locked,
detached, external, primary or caller-inside targets. Ignored local data
(.env, runs/, .llm-output/, logs, other ignored files) is first copied to a
unique verified backup under <primary>-worktree-backups/ and the backup
location is printed; only root node_modules/, dist/ and coverage/ are
disposable. The branch and its commits are always retained. Stop all agents
and dev servers using the worktree first.

.PARAMETER Name
Worktree slug. A leading codex/ prefix is accepted and stripped.

.EXAMPLE
.\scripts\teardown-worktree.ps1 my-task
.EXAMPLE
.\scripts\teardown-worktree.ps1 codex/my-task
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$Name
)

$ErrorActionPreference = 'Stop'

if ($Name -like 'codex/*') { $Name = $Name.Substring(6) }
elseif ($Name -like 'codex\*') { $Name = $Name.Substring(6) }

$repoRoot = Split-Path -Parent $PSScriptRoot

# Capture the actual caller's directory before relocating to this wrapper's
# checkout. The CLI checks it (including its physical/junction-resolved form)
# against the target and refuses before any backup or removal, even when this
# wrapper lives in the primary or another linked checkout.
$callerCwd = (Get-Location).ProviderPath
if (-not $callerCwd) { $callerCwd = (Get-Location).Path }

Push-Location $repoRoot
try {
  # Teardown never installs, so call the CLI directly and avoid npm.
  & node (Join-Path $PSScriptRoot 'worktrees.ts') teardown $Name --caller-cwd $callerCwd
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
  Pop-Location
}
