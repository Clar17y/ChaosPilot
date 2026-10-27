<#
.SYNOPSIS
Create a ChaosPilot script-managed worktree (familiar entry point).

.DESCRIPTION
Thin wrapper around the cross-platform CLI (`npm run worktree:setup`).
Creates a worktree under <primary>-worktrees/<name> on branch codex/<name>,
copies the primary checkout's .env byte-for-byte when present (never printed,
never overwriting an existing destination .env), and runs `npm ci` unless
-NoInstall is given. Branches and commits are always retained by teardown.

.PARAMETER Name
Worktree slug (1-64 lowercase letters, digits, single hyphens).
A leading codex/ prefix is accepted and stripped.

.PARAMETER Base
Local base ref for a new branch (default: main). No fetch or pull is done.

.PARAMETER NoInstall
Skip `npm ci` in the new worktree.

.EXAMPLE
.\scripts\setup-worktree.ps1 my-task
.EXAMPLE
.\scripts\setup-worktree.ps1 codex/my-task -NoInstall
.EXAMPLE
.\scripts\setup-worktree.ps1 my-task -Base release
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$Name,

  [string]$Base,

  [switch]$NoInstall
)

$ErrorActionPreference = 'Stop'

if ($Name -like 'codex/*') { $Name = $Name.Substring(6) }
elseif ($Name -like 'codex\*') { $Name = $Name.Substring(6) }

$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repoRoot
try {
  if ($NoInstall) {
    # No install step is needed, so call the CLI directly and avoid npm.
    $nodeArgs = @((Join-Path $PSScriptRoot 'worktrees.ts'), 'setup', $Name, '--no-install')
    if ($PSBoundParameters.ContainsKey('Base')) { $nodeArgs += @('--base', $Base) }
    & node @nodeArgs
  } else {
    # Go through npm so npm_execpath is available for `npm ci`.
    $cliArgs = @('run', 'worktree:setup', '--', $Name)
    if ($PSBoundParameters.ContainsKey('Base')) { $cliArgs += @('--base', $Base) }
    & npm @cliArgs
  }
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
  Pop-Location
}
