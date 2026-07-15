param(
    [string]$RepoRoot = (Split-Path -Parent $PSScriptRoot),
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$resolvedRepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path
$runtimeRoot = Join-Path $resolvedRepoRoot ".runtime"
$envPath = Join-Path $runtimeRoot "windows-worker.env.ps1"
$pythonPath = Join-Path $resolvedRepoRoot ".venv\Scripts\python.exe"
$updaterPath = Join-Path $resolvedRepoRoot "scripts\worker_self_update.py"
$logPath = Join-Path $runtimeRoot "agenthub-windows-worker-update.log"

New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null

function Write-UpdateLog {
    param([string]$Message)

    $stamp = Get-Date -Format o
    $line = "$stamp $Message"
    try {
        $stream = [System.IO.FileStream]::new(
            $logPath,
            [System.IO.FileMode]::Append,
            [System.IO.FileAccess]::Write,
            [System.IO.FileShare]::ReadWrite
        )
        try {
            $writer = [System.IO.StreamWriter]::new($stream, [System.Text.Encoding]::UTF8)
            try {
                $writer.WriteLine($line)
            }
            finally {
                $writer.Dispose()
            }
        }
        finally {
            $stream.Dispose()
        }
    }
    catch {
        Write-Warning $line
    }
}

try {
    if (Test-Path -LiteralPath $envPath) {
        . $envPath
    }

    $autoUpdate = $env:AGENTHUB_WORKER_AUTO_UPDATE
    if ($autoUpdate -and $autoUpdate.Trim().ToLowerInvariant() -in @("0", "false", "no", "off", "disabled")) {
        Write-UpdateLog "worker auto-update disabled"
        exit 0
    }

    if (!(Test-Path -LiteralPath $pythonPath)) {
        Write-UpdateLog "worker auto-update skipped; missing python: $pythonPath"
        exit 0
    }
    if (!(Test-Path -LiteralPath $updaterPath)) {
        Write-UpdateLog "worker auto-update skipped; missing updater: $updaterPath"
        exit 0
    }

    $arguments = @($updaterPath, "--platform", "windows", "--repo-root", $resolvedRepoRoot)
    if ($DryRun) {
        $arguments += "--dry-run"
    }

    # Windows PowerShell surfaces native stderr as ErrorRecord objects. Keep them
    # in the update log without letting ErrorActionPreference=Stop abort the pipe.
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        & $pythonPath @arguments 2>&1 | ForEach-Object { Write-UpdateLog ([string]$_) }
        $updateExitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }

    if ($updateExitCode -ne 0) {
        Write-UpdateLog "worker auto-update exited code=$updateExitCode"
    }
}
catch {
    Write-UpdateLog "worker auto-update exception: $($_.Exception.Message)"
}

exit 0
