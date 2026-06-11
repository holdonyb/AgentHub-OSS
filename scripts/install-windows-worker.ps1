param(
    [Parameter(Mandatory = $true)]
    [string]$ApiUrl,
    [Parameter(Mandatory = $true)]
    [string]$EnrollmentToken,
    [string]$WorkerId = $env:COMPUTERNAME,
    [ValidateSet("private", "public_relay")]
    [string]$ConnectionMode = "private",
    [string]$RepoRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$InstallRoot = "",
    [string[]]$WorkspaceRoot = @("C:/Work"),
    [string[]]$SessionRoot = @(),
    [int]$MaxConcurrentJobs = 2,
    [int]$JobPollSeconds = 5,
    [int]$HeartbeatSeconds = 30,
    [string]$WorkerBundleUrl = "",
    [string]$WorkerManifestUrl = "",
    [switch]$StartAtBoot,
    [switch]$StartAtLogOn,
    [switch]$DisableAutoUpdate,
    [switch]$SkipBootstrap
)

$ErrorActionPreference = "Stop"

function Convert-ToEnvValue {
    param([string[]]$Values)

    $filtered = @($Values | Where-Object { $_ -and $_.Trim() } | ForEach-Object { $_.Trim() })
    return ($filtered -join ';')
}

function Quote-PowerShellLiteral {
    param([string]$Value)

    return "'" + $Value.Replace("'", "''") + "'"
}

function Write-WorkerEnvFile {
    param(
        [string]$Path,
        [hashtable]$Values
    )

    $lines = foreach ($key in ($Values.Keys | Sort-Object)) {
        $value = [string]$Values[$key]
        '$env:{0}={1}' -f $key, (Quote-PowerShellLiteral -Value $value)
    }
    $content = ($lines -join [Environment]::NewLine) + [Environment]::NewLine
    Set-Content -LiteralPath $Path -Value $content -Encoding UTF8
}

function SecureString-ToPlainText {
    param([Security.SecureString]$SecureString)

    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureString)
    try {
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    }
    finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
}

function Resolve-PythonBootstrap {
    $py = Get-Command py -ErrorAction SilentlyContinue
    if ($py) {
        return @($py.Source, "-3")
    }
    $python = Get-Command python -ErrorAction SilentlyContinue
    if ($python) {
        return @($python.Source)
    }
    $uv = Get-Command uv -ErrorAction SilentlyContinue
    if ($uv) {
        return @($uv.Source, "python")
    }
    throw "Python 3 launcher not found on PATH"
}

function Copy-BundleRelativePath {
    param(
        [string]$SourceRoot,
        [string]$TargetRoot,
        [string]$RelativePath
    )

    $sourcePath = Join-Path $SourceRoot $RelativePath
    if (!(Test-Path -LiteralPath $sourcePath)) {
        throw "Missing required bundle path: $sourcePath"
    }

    $targetPath = Join-Path $TargetRoot $RelativePath
    $targetParent = Split-Path -Parent $targetPath
    if ($targetParent) {
        New-Item -ItemType Directory -Force -Path $targetParent | Out-Null
    }

    if (Test-Path -LiteralPath $sourcePath -PathType Container) {
        New-Item -ItemType Directory -Force -Path $targetPath | Out-Null
        Get-ChildItem -LiteralPath $sourcePath -Force | Copy-Item -Destination $targetPath -Recurse -Force
        return
    }

    Copy-Item -LiteralPath $sourcePath -Destination $targetPath -Force
}

$resolvedSourceRoot = (Resolve-Path -LiteralPath $RepoRoot).Path
$targetRoot = $InstallRoot.Trim()
if (!$targetRoot) {
    $targetRoot = $resolvedSourceRoot
}
New-Item -ItemType Directory -Force -Path $targetRoot | Out-Null
$resolvedRepoRoot = (Resolve-Path -LiteralPath $targetRoot).Path

$bundlePaths = @(
    "packages\protocol\agenthub_protocol",
    "workers\local-windows\agenthub_windows_worker",
    "workers\shared\agenthub_worker",
    "workers\requirements.txt",
    "scripts\install-windows-worker.ps1",
    "scripts\windows-worker-loop.ps1",
    "scripts\update-windows-worker.ps1",
    "scripts\worker_self_update.py"
)

if ($resolvedSourceRoot.ToLowerInvariant() -ne $resolvedRepoRoot.ToLowerInvariant()) {
    foreach ($relativePath in $bundlePaths) {
        Copy-BundleRelativePath -SourceRoot $resolvedSourceRoot -TargetRoot $resolvedRepoRoot -RelativePath $relativePath
    }
}

$runtimeRoot = Join-Path $resolvedRepoRoot ".runtime"
$venvRoot = Join-Path $resolvedRepoRoot ".venv"
$pythonPath = Join-Path $resolvedRepoRoot ".venv\Scripts\python.exe"
$workerPath = Join-Path $resolvedRepoRoot "workers\local-windows\agenthub_windows_worker\main.py"
$loopPath = Join-Path $resolvedRepoRoot "scripts\windows-worker-loop.ps1"
$updaterPath = Join-Path $resolvedRepoRoot "scripts\update-windows-worker.ps1"
$envPath = Join-Path $runtimeRoot "windows-worker.env.ps1"
$safeWorkerId = ($WorkerId -replace '[\\/]', '_')
$tokenPath = Join-Path $runtimeRoot "$safeWorkerId.worker-token"
$taskName = "AgentHub Windows Worker ($WorkerId)"
$requirementsPath = Join-Path $resolvedRepoRoot "workers\requirements.txt"

if (!(Test-Path -LiteralPath $requirementsPath)) {
    throw "Missing worker requirements file: $requirementsPath"
}

if (!(Test-Path -LiteralPath $pythonPath)) {
    $bootstrap = Resolve-PythonBootstrap
    $bootstrapExe = $bootstrap[0]
    $bootstrapArgs = @()
    if ($bootstrap.Length -gt 1) {
        $bootstrapArgs = $bootstrap[1..($bootstrap.Length - 1)]
    }
    & $bootstrapExe @bootstrapArgs -m venv $venvRoot
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to create virtual environment under $venvRoot"
    }
}

& $pythonPath -m pip install -r $requirementsPath
if ($LASTEXITCODE -ne 0) {
    throw "Failed to install worker dependencies from $requirementsPath"
}

foreach ($requiredPath in @($pythonPath, $workerPath, $loopPath, $updaterPath)) {
    if (!(Test-Path -LiteralPath $requiredPath)) {
        throw "Missing required file: $requiredPath"
    }
}

New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null

$envValues = @{
    AGENTHUB_API_URL                  = $ApiUrl.Trim()
    AGENTHUB_CONNECTION_MODE          = $ConnectionMode
    AGENTHUB_ENROLLMENT_TOKEN         = $EnrollmentToken.Trim()
    AGENTHUB_SESSION_ROOTS            = Convert-ToEnvValue -Values $SessionRoot
    AGENTHUB_WORKER_AUTO_UPDATE       = if ($DisableAutoUpdate) { "false" } else { "true" }
    AGENTHUB_WORKER_BUNDLE_URL        = $WorkerBundleUrl.Trim()
    AGENTHUB_WORKER_HEARTBEAT_SECONDS = [string]$HeartbeatSeconds
    AGENTHUB_WORKER_ID                = $WorkerId.Trim()
    AGENTHUB_WORKER_JOB_POLL_SECONDS  = [string]$JobPollSeconds
    AGENTHUB_WORKER_MAX_CONCURRENT_JOBS = [string]$MaxConcurrentJobs
    AGENTHUB_WORKER_MANIFEST_URL      = $WorkerManifestUrl.Trim()
    AGENTHUB_WORKER_TOKEN_PATH        = $tokenPath
    AGENTHUB_WORKSPACE_ROOTS          = Convert-ToEnvValue -Values $WorkspaceRoot
}

Write-WorkerEnvFile -Path $envPath -Values $envValues

. $envPath

if (!$SkipBootstrap) {
    Push-Location $resolvedRepoRoot
    try {
        & $pythonPath $workerPath --once
        if ($LASTEXITCODE -ne 0) {
            throw "Bootstrap run failed with exit code $LASTEXITCODE"
        }
    }
    finally {
        Pop-Location
    }
}

$useStartupTrigger = $true
if ($StartAtLogOn) {
    $useStartupTrigger = $false
} elseif ($StartAtBoot) {
    $useStartupTrigger = $true
}

$actionArgument = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}"' -f $loopPath
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $actionArgument
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Days 30) `
    -MultipleInstances IgnoreNew
$primaryTrigger = if ($useStartupTrigger) { New-ScheduledTaskTrigger -AtStartup } else { New-ScheduledTaskTrigger -AtLogOn }
$watchdogTrigger = New-ScheduledTaskTrigger -Once `
    -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes 1) `
    -RepetitionDuration (New-TimeSpan -Days 3650)
$triggers = @($primaryTrigger, $watchdogTrigger)
$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

if ($useStartupTrigger) {
    $credential = Get-Credential -UserName $currentUser -Message "AgentHub worker startup requires saved credentials for this Windows account"
    $password = SecureString-ToPlainText -SecureString $credential.Password
    try {
        Register-ScheduledTask `
            -TaskName $taskName `
            -Action $action `
            -Trigger $triggers `
            -Settings $settings `
            -User $credential.UserName `
            -Password $password `
            -RunLevel Highest `
            -Force | Out-Null
    }
    finally {
        if ($password) {
            $password = $null
        }
    }
} else {
    $principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Highest
    Register-ScheduledTask `
        -TaskName $taskName `
        -Action $action `
        -Trigger $triggers `
        -Settings $settings `
        -Principal $principal `
        -Force | Out-Null
}

Write-Host ('Worker env written to {0}' -f $envPath)
Write-Host ('Scheduled task registered: {0}' -f $taskName)
Write-Host ('Installed worker root: {0}' -f $resolvedRepoRoot)
Write-Host ('Token cache path: {0}' -f $tokenPath)
