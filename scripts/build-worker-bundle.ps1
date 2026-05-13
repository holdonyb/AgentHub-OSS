param(
    [string]$OutputRoot = "",
    [string]$Version = ""
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path -LiteralPath (Split-Path -Parent $PSScriptRoot)).Path
$scriptPath = Join-Path $repoRoot "scripts\build-worker-bundle.py"

if (!(Test-Path -LiteralPath $scriptPath)) {
    throw "Missing bundle builder: $scriptPath"
}

$python = Get-Command py -ErrorAction SilentlyContinue
if ($python) {
    $command = @($python.Source, "-3", $scriptPath)
} else {
    $command = @("python", $scriptPath)
}

if ($OutputRoot.Trim()) {
    $command += @("--output-root", $OutputRoot.Trim())
}
if ($Version.Trim()) {
    $command += @("--version", $Version.Trim())
}

& $command[0] $command[1..($command.Length - 1)]
if ($LASTEXITCODE -ne 0) {
    throw "Worker bundle build failed with exit code $LASTEXITCODE"
}
