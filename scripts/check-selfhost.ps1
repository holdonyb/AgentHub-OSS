param(
    [Parameter(Mandatory = $true)]
    [string]$BaseUrl,
    [switch]$ExpectPublicRelay,
    [switch]$ExpectWorkerBundles,
    [switch]$Json,
    [switch]$Insecure
)

$ErrorActionPreference = "Stop"

if ($Insecure) {
    [System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }
}

function Write-CheckLog {
    param([string]$Message)
    Write-Host "[agenthub-check] $Message"
}

function Join-AgentHubUrl {
    param(
        [string]$Base,
        [string]$Path
    )

    return $Base.TrimEnd("/") + $Path
}

function Invoke-Status {
    param(
        [string]$Method,
        [string]$Path,
        [string]$Body = ""
    )

    $uri = Join-AgentHubUrl -Base $BaseUrl -Path $Path
    $request = [System.Net.HttpWebRequest]::Create($uri)
    $request.Method = $Method
    $request.Timeout = 20000
    $request.AllowAutoRedirect = $false
    if ($Body) {
        $payload = [System.Text.Encoding]::UTF8.GetBytes($Body)
        $request.ContentType = "application/json"
        $request.ContentLength = $payload.Length
        $stream = $request.GetRequestStream()
        try {
            $stream.Write($payload, 0, $payload.Length)
        }
        finally {
            $stream.Dispose()
        }
    }

    try {
        $response = $request.GetResponse()
        try {
            return [int]$response.StatusCode
        }
        finally {
            $response.Dispose()
        }
    }
    catch [System.Net.WebException] {
        if ($_.Exception.Response) {
            $response = $_.Exception.Response
            try {
                return [int]$response.StatusCode
            }
            finally {
                $response.Dispose()
            }
        }
        throw
    }
}

function Assert-Status {
    param(
        [string]$Method,
        [string]$Path,
        [int[]]$Expected,
        [string]$Body = ""
    )

    $actual = Invoke-Status -Method $Method -Path $Path -Body $Body
    if ($Expected -notcontains $actual) {
        throw "$Method $Path expected [$($Expected -join ',')] got $actual"
    }
    Write-CheckLog "$Method $Path -> $actual"
    [PSCustomObject]@{
        method = $Method
        path = $Path
        status = $actual
    }
}

$checks = @()
$checks += Assert-Status -Method GET -Path "/healthz" -Expected @(200)
$checks += Assert-Status -Method GET -Path "/" -Expected @(200)
$checks += Assert-Status -Method POST -Path "/api/internal/jobs/claim" -Expected @(401, 403) -Body '{"worker_id":"smoke-worker"}'

if ($ExpectPublicRelay) {
    $checks += Assert-Status -Method POST -Path "/api/worker/enroll" -Expected @(403) -Body '{"enrollment_token":"invalid","worker_id":"smoke-worker","machine_name":"smoke-worker","os":"linux","connection_mode":"public_relay","transport_state":"polling","reachable_backends":[],"workspace_roots":["/tmp"],"capabilities":{}}'
}

if ($ExpectWorkerBundles) {
    $checks += Assert-Status -Method GET -Path "/downloads/workers/worker-bundles-manifest.json" -Expected @(200)
    $checks += Assert-Status -Method GET -Path "/downloads/workers/agenthub-worker-windows.zip" -Expected @(200)
    $checks += Assert-Status -Method GET -Path "/downloads/workers/agenthub-worker-linux.tar.gz" -Expected @(200)
    $checks += Assert-Status -Method GET -Path "/downloads/workers/agenthub-worker-macos.tar.gz" -Expected @(200)
}

Write-CheckLog "self-host smoke checks passed"

if ($Json) {
    [PSCustomObject]@{
        status = "ok"
        base_url = $BaseUrl
        checks = $checks
    } | ConvertTo-Json -Depth 4 -Compress
}
