param([string]$Email = 'paul@sunnyland.com.au')
$ErrorActionPreference = 'Stop'
$nodeBinary = 'C:\Program Files\WindowsApps\OpenAI.CodexPrimaryRuntime.v26-1116-1220-0_26.1116.1220.0_x64__3k8sg7r9htsxt\dependencies\node\bin\node.exe'
if (-not (Test-Path -LiteralPath $nodeBinary)) { $nodeBinary = (Get-Command node -ErrorAction Stop).Source }
$ready = $false
try { $health = Invoke-RestMethod -Uri 'http://127.0.0.1:5180/health' -TimeoutSec 2; $ready = $health.ok -eq $true -and $health.version -eq '0.1.0' } catch { }
if (-not $ready) {
    $process = Start-Process -FilePath $nodeBinary -ArgumentList ('"' + (Join-Path $PSScriptRoot 'server.mjs') + '"') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $PSScriptRoot 'data\server.stdout.log') -RedirectStandardError (Join-Path $PSScriptRoot 'data\server.stderr.log') -PassThru
    @{serverPid=$process.Id;startedAt=(Get-Date).ToString('o');mode='loopback-pilot'} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'data\pilot-processes.json')
    for ($attempt=0; $attempt -lt 10; $attempt++) {
        try { $health = Invoke-RestMethod -Uri 'http://127.0.0.1:5180/health' -TimeoutSec 1; if ($health.ok) { $ready=$true;break } } catch { }
        Start-Sleep -Milliseconds 300
    }
}
if (-not $ready) {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show('The local service did not start. Return to ChatGPT to check the server log.','Sunnyland setup') | Out-Null
    exit 1
}
& (Join-Path $PSScriptRoot 'Set-Manager-Password.ps1') -Email $Email -NodeBinary $nodeBinary
