param(
    [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
)

$ErrorActionPreference = "Stop"

$repo = (Resolve-Path $RepoRoot).Path
$gitDir = git -C $repo rev-parse --git-dir
if (-not $gitDir) {
    throw "Not a git repository: $repo"
}

$hooksDir = Join-Path $repo $gitDir
$hooksDir = Join-Path $hooksDir "hooks"
New-Item -ItemType Directory -Force -Path $hooksDir | Out-Null

$hookPath = Join-Path $hooksDir "pre-commit"
$hook = @"
#!/usr/bin/env bash
set -euo pipefail
python scripts/audit-public-export.py --root .
"@

[System.IO.File]::WriteAllText($hookPath, $hook.Replace("`r`n","`n"), [System.Text.UTF8Encoding]::new($false))

try {
    & git -C $repo update-index --chmod=+x ".git/hooks/pre-commit" 2>$null | Out-Null
} catch {
}

Write-Host "Installed pre-commit hook at $hookPath"

