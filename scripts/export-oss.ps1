param(
    [string]$SourceRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
    [string]$TargetRoot = "E:\Work\AgentHub-OSS",
    [switch]$SkipAudit
)

$ErrorActionPreference = "Stop"

function Remove-ExportedContent {
    param([string]$Path)

    Get-ChildItem -LiteralPath $Path -Force | Where-Object { $_.Name -ne ".git" } | ForEach-Object {
        Remove-Item -LiteralPath $_.FullName -Recurse -Force
    }
}

function Copy-Tree {
    param(
        [string]$From,
        [string]$To
    )

    $null = New-Item -ItemType Directory -Path $To -Force
    $robocopyArgs = @(
        $From,
        $To,
        "/E",
        "/NFL",
        "/NDL",
        "/NJH",
        "/NJS",
        "/NP",
        "/XD", ".git", ".venv", ".runtime", "__pycache__", "node_modules", ".pytest_cache", "dist", "build", "artifacts", "output",
        "/XF", "deploy-vm.ps1", ("publish" + "-apk.ps1")
    )
    & robocopy @robocopyArgs | Out-Null
    $exitCode = $LASTEXITCODE
    if ($exitCode -gt 7) {
        throw "robocopy failed with exit code $exitCode"
    }
}

$source = (Resolve-Path $SourceRoot).Path
$target = (Resolve-Path $TargetRoot).Path

if (-not (Test-Path (Join-Path $target ".git"))) {
    throw "TargetRoot must point to an existing git repo, for example AgentHub-OSS"
}

$keepFiles = @(
    "README.md",
    "CONTRIBUTING.md",
    "PROVENANCE.md",
    "SECURITY.md",
    "docs\OSS_RELEASE.md",
    ".github\workflows\ci.yml",
    ".github\workflows\release.yml",
    ".github\workflows\secret-scan.yml"
)

$removeAfterCopy = @(
    ".github\workflows\deploy.yml"
)

$tempKeep = Join-Path $env:TEMP ("agenthub-oss-keep-" + [guid]::NewGuid().ToString("N"))
$null = New-Item -ItemType Directory -Path $tempKeep -Force
foreach ($relativePath in $keepFiles) {
    $sourcePath = Join-Path $target $relativePath
    if (-not (Test-Path $sourcePath)) {
        continue
    }
    $destinationPath = Join-Path $tempKeep $relativePath
    $destinationDir = Split-Path -Parent $destinationPath
    if ($destinationDir) {
        $null = New-Item -ItemType Directory -Path $destinationDir -Force
    }
    Copy-Item -LiteralPath $sourcePath -Destination $destinationPath -Force
}

try {
    Remove-ExportedContent -Path $target
    Copy-Tree -From $source -To $target

    foreach ($relativePath in $keepFiles) {
        $savedPath = Join-Path $tempKeep $relativePath
        if (-not (Test-Path $savedPath)) {
            continue
        }
        $destinationPath = Join-Path $target $relativePath
        $destinationDir = Split-Path -Parent $destinationPath
        if ($destinationDir) {
            $null = New-Item -ItemType Directory -Path $destinationDir -Force
        }
        Copy-Item -LiteralPath $savedPath -Destination $destinationPath -Force
    }

    foreach ($relativePath in $removeAfterCopy) {
        $targetPath = Join-Path $target $relativePath
        if (Test-Path $targetPath) {
            Remove-Item -LiteralPath $targetPath -Force
        }
    }

    if (-not $SkipAudit) {
        & python (Join-Path $source "scripts\audit-public-export.py") --root $target
        if ($LASTEXITCODE -ne 0) {
            throw "Public export audit failed"
        }
    }

    Write-Host "Exported OSS snapshot to $target"
} finally {
    if (Test-Path $tempKeep) {
        Remove-Item -LiteralPath $tempKeep -Recurse -Force
    }
}
