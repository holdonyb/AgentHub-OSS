param(
    [string]$HostName = "60.205.57.216",
    [string]$User = "root",
    [string]$KeyPath = "$env:USERPROFILE/.ssh/openai_bj2.pem",
    [string]$Port = "22",
    [string]$Interface = ""
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$scriptPath = Join-Path $repoRoot "scripts/install-vm-traffic-monitor.sh"

if (!(Test-Path -LiteralPath $scriptPath)) {
    throw "Missing install script: $scriptPath"
}

if (!(Test-Path -LiteralPath $KeyPath)) {
    throw "Missing SSH key: $KeyPath"
}

$remotePath = "/tmp/agenthub-install-vm-traffic-monitor.sh"
scp -i $KeyPath -P $Port $scriptPath "$User@$HostName`:$remotePath"
if ($LASTEXITCODE -ne 0) {
    throw "scp failed with exit code $LASTEXITCODE"
}

$remoteCommand = if ($Interface) { "bash $remotePath '$Interface'" } else { "bash $remotePath" }
ssh -i $KeyPath -p $Port "$User@$HostName" $remoteCommand
if ($LASTEXITCODE -ne 0) {
    throw "ssh failed with exit code $LASTEXITCODE"
}
