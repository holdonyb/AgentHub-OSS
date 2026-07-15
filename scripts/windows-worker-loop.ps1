param(
    [switch]$Once,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$runtimeRoot = Join-Path $repoRoot ".runtime"
$envPath = Join-Path $runtimeRoot "windows-worker.env.ps1"
$pythonPath = Join-Path $repoRoot ".venv/Scripts/python.exe"
$workerPath = Join-Path $repoRoot "workers/local-windows/agenthub_windows_worker/main.py"
$updaterPath = Join-Path $repoRoot "scripts/update-windows-worker.ps1"
$logPath = Join-Path $runtimeRoot "agenthub-windows-worker.log"
$stdoutPath = Join-Path $runtimeRoot "agenthub-windows-worker.stdout.log"
$stderrPath = Join-Path $runtimeRoot "agenthub-windows-worker.stderr.log"
$pidPath = Join-Path $runtimeRoot "agenthub-windows-worker.pid"
$lockPath = Join-Path $runtimeRoot "agenthub-windows-worker.lock"
$lockStream = $null

New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null

function Write-WorkerLog {
    param([string]$Message)

    $stamp = Get-Date -Format o
    $line = "$stamp $Message"
    $fallbackPath = Join-Path $runtimeRoot "agenthub-windows-worker.$PID.log"
    for ($attempt = 0; $attempt -lt 5; $attempt++) {
        try {
            $stream = [System.IO.FileStream]::new(
                $logPath,
                [System.IO.FileMode]::Append,
                [System.IO.FileAccess]::Write,
                [System.IO.FileShare]::ReadWrite
            )
            try {
                $writer = [System.IO.StreamWriter]::new($stream, [System.Text.Encoding]::Unicode)
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
            return
        }
        catch [System.IO.IOException] {
            Start-Sleep -Milliseconds (120 * ($attempt + 1))
        }
    }

    try {
        [System.IO.File]::AppendAllText($fallbackPath, "$line`r`n", [System.Text.Encoding]::Unicode)
    }
    catch {
        Write-Warning $line
    }
}

if (!(Test-Path $envPath)) {
    throw "Missing worker environment file: $envPath"
}

. $envPath

function Merge-WorkerPath {
    $pathEntries = @(
        @($env:Path -split ';')
        @([Environment]::GetEnvironmentVariable('Path', 'User') -split ';')
        @([Environment]::GetEnvironmentVariable('Path', 'Machine') -split ';')
    )
    $seen = @{}
    $merged = foreach ($entry in $pathEntries) {
        $trimmed = [Environment]::ExpandEnvironmentVariables(([string]$entry).Trim()).TrimEnd('\')
        if (!$trimmed) {
            continue
        }
        $key = $trimmed.ToLowerInvariant()
        if (!$seen.ContainsKey($key)) {
            $seen[$key] = $true
            $trimmed
        }
    }
    $env:Path = $merged -join ';'
}

Merge-WorkerPath

$env:PYTHONPATH = @(
    (Join-Path $repoRoot "workers/shared"),
    (Join-Path $repoRoot "workers/local-windows"),
    (Join-Path $repoRoot "packages/protocol")
) -join ";"

function Test-WorkerLoopProcess {
    param([int]$ProcessId)

    $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    return $null -ne $process
}

function Test-PidOwnership {
    if (!(Test-Path $pidPath)) {
        return $false
    }
    $currentPidText = (Get-Content -Path $pidPath -Raw -ErrorAction SilentlyContinue).Trim()
    return $currentPidText -eq [string]$PID
}

try {
    $lockStream = [System.IO.FileStream]::new(
        $lockPath,
        [System.IO.FileMode]::OpenOrCreate,
        [System.IO.FileAccess]::ReadWrite,
        [System.IO.FileShare]::None
    )
}
catch [System.IO.IOException] {
    Write-WorkerLog "another worker loop holds lock; exiting"
    exit 0
}

if (Test-Path $pidPath) {
    $existingPidText = (Get-Content -Path $pidPath -Raw -ErrorAction SilentlyContinue).Trim()
    $existingPid = 0
    if ([int]::TryParse($existingPidText, [ref]$existingPid) -and (Test-WorkerLoopProcess -ProcessId $existingPid)) {
        Write-WorkerLog "another worker loop is already running pid=$existingPid; exiting"
        exit 0
    }

    Write-WorkerLog "removing stale worker pid file: $existingPidText"
}

if (!$Once -and !$DryRun -and (Test-Path -LiteralPath $updaterPath)) {
    try {
        $updateArguments = @(
            "-NoProfile",
            "-WindowStyle",
            "Hidden",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            "`"$updaterPath`"",
            "-RepoRoot",
            "`"$repoRoot`""
        )
        $updateProcess = Start-Process `
            -FilePath "powershell.exe" `
            -ArgumentList $updateArguments `
            -WorkingDirectory $repoRoot `
            -WindowStyle Hidden `
            -Wait `
            -PassThru

        if ($updateProcess.ExitCode -ne 0) {
            Write-WorkerLog "worker auto-update exited code=$($updateProcess.ExitCode)"
        }
    }
    catch {
        Write-WorkerLog "worker auto-update failed: $($_.Exception.Message)"
    }
}

try {
    Set-Content -Path $pidPath -Value $PID -Encoding ascii
    do {
        if (!(Test-PidOwnership)) {
            Write-WorkerLog "worker pid ownership lost; exiting"
            break
        }
        $arguments = @($workerPath)
        if ($Once) {
            $arguments += "--once"
        }
        if ($DryRun) {
            Write-Output "$pythonPath $($arguments -join ' ')"
            break
        }

        $process = Start-Process `
            -FilePath $pythonPath `
            -ArgumentList $arguments `
            -WorkingDirectory $repoRoot `
            -NoNewWindow `
            -Wait `
            -PassThru `
            -RedirectStandardOutput $stdoutPath `
            -RedirectStandardError $stderrPath

        if ($process.ExitCode -ne 0) {
            Write-WorkerLog "worker exited code=$($process.ExitCode); stderr=$stderrPath"
        }

        if (!$Once) {
            Start-Sleep -Seconds 20
        }
    } while (!$Once)
}
catch {
    Write-WorkerLog "worker exception: $($_.Exception.Message)"
    throw
}
finally {
    $currentPidText = (Get-Content -Path $pidPath -Raw -ErrorAction SilentlyContinue).Trim()
    if ($currentPidText -eq [string]$PID) {
        Remove-Item -Path $pidPath -Force -ErrorAction SilentlyContinue
    }
    if ($null -ne $lockStream) {
        $lockStream.Dispose()
    }
}
