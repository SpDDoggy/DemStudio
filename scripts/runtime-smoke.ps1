param(
    [string]$Executable = (Join-Path $PSScriptRoot "..\src-tauri\target\debug\dem-studio.exe"),
    [string]$Screenshot = (Join-Path $PSScriptRoot "..\runtime-smoke.png"),
    [string]$Fixture = (Join-Path $PSScriptRoot "..\tests\fixtures\smoke-terrain.asc"),
    [int]$DebugPort = 9333
)

$ErrorActionPreference = "Stop"

function Invoke-Cdp {
    param(
        [System.Net.WebSockets.ClientWebSocket]$Socket,
        [int]$Id,
        [string]$Method,
        [hashtable]$Params = @{}
    )

    $payload = @{
        id = $Id
        method = $Method
        params = $Params
    } | ConvertTo-Json -Depth 20 -Compress

    $bytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
    $segment = [System.ArraySegment[byte]]::new($bytes)
    $Socket.SendAsync(
        $segment,
        [System.Net.WebSockets.WebSocketMessageType]::Text,
        $true,
        [System.Threading.CancellationToken]::None
    ).GetAwaiter().GetResult()

    while ($Socket.State -eq [System.Net.WebSockets.WebSocketState]::Open) {
        $stream = [System.IO.MemoryStream]::new()
        try {
            do {
                $buffer = [byte[]]::new(65536)
                $receiveSegment = [System.ArraySegment[byte]]::new($buffer)
                $result = $Socket.ReceiveAsync(
                    $receiveSegment,
                    [System.Threading.CancellationToken]::None
                ).GetAwaiter().GetResult()
                $stream.Write($buffer, 0, $result.Count)
            } while (-not $result.EndOfMessage)

            $message = [System.Text.Encoding]::UTF8.GetString($stream.ToArray()) | ConvertFrom-Json
            if ($message.id -eq $Id) {
                return $message
            }
        }
        finally {
            $stream.Dispose()
        }
    }

    throw "CDP connection closed before response $Id."
}

$resolvedExecutable = [System.IO.Path]::GetFullPath($Executable)
if (-not (Test-Path -LiteralPath $resolvedExecutable)) {
    throw "Executable not found: $resolvedExecutable"
}

$process = $null
$socket = $null

try {
    $process = Start-Process -FilePath $resolvedExecutable -PassThru
    $target = $null

    for ($attempt = 0; $attempt -lt 24; $attempt += 1) {
        Start-Sleep -Milliseconds 250
        try {
            $targets = Invoke-RestMethod -Uri "http://127.0.0.1:$DebugPort/json" -TimeoutSec 1
            $target = $targets | Where-Object { $_.type -eq "page" -and $_.title -eq "DEM Studio" } | Select-Object -First 1
            if ($target) {
                break
            }
        }
        catch {
        }
    }

    if (-not $target) {
        throw "DEM Studio WebView did not expose a debug target."
    }

    $socket = [System.Net.WebSockets.ClientWebSocket]::new()
    $socket.ConnectAsync(
        [Uri]$target.webSocketDebuggerUrl,
        [System.Threading.CancellationToken]::None
    ).GetAwaiter().GetResult()

    $expression = @'
JSON.stringify({
  title: document.title,
  hostRuntime: window.demStudioHost?.runtime ?? null,
  lensDbLoad: typeof window.lens?.db?.load,
  lensFsWriteBlob: typeof window.lens?.fs?.writeBlob,
  canvasCount: document.querySelectorAll("canvas").length,
  status: document.getElementById("importStatus")?.textContent ?? null,
  bootError: document.getElementById("importStatus")?.classList.contains("err") ?? false
})
'@

    $runtime = Invoke-Cdp -Socket $socket -Id 1 -Method "Runtime.evaluate" -Params @{
        expression = $expression
        returnByValue = $true
    }

    if ($runtime.result.exceptionDetails) {
        throw ($runtime.result.exceptionDetails.text)
    }

    $state = $runtime.result.result.value | ConvertFrom-Json
    $state | ConvertTo-Json -Compress

    if ($state.title -ne "DEM Studio" -or
        $state.hostRuntime -ne "tauri" -or
        $state.lensDbLoad -ne "function" -or
        $state.lensFsWriteBlob -ne "function" -or
        $state.canvasCount -lt 1 -or
        $state.bootError) {
        throw "Runtime smoke assertions failed."
    }

    $document = Invoke-Cdp -Socket $socket -Id 2 -Method "DOM.getDocument"
    $fileInput = Invoke-Cdp -Socket $socket -Id 3 -Method "DOM.querySelector" -Params @{
        nodeId = $document.result.root.nodeId
        selector = "#fileInput"
    }
    Invoke-Cdp -Socket $socket -Id 4 -Method "DOM.setFileInputFiles" -Params @{
        nodeId = $fileInput.result.nodeId
        files = @([System.IO.Path]::GetFullPath($Fixture))
    } | Out-Null

    $importState = $null
    for ($attempt = 0; $attempt -lt 40; $attempt += 1) {
        Start-Sleep -Milliseconds 250
        $importResult = Invoke-Cdp -Socket $socket -Id (10 + $attempt) -Method "Runtime.evaluate" -Params @{
            expression = @'
JSON.stringify({
  status: document.getElementById("importStatus")?.textContent ?? null,
  name: document.getElementById("mName")?.textContent ?? null,
  type: document.getElementById("mType")?.textContent ?? null,
  size: document.getElementById("mSize")?.textContent ?? null
})
'@
            returnByValue = $true
        }
        $importState = $importResult.result.result.value | ConvertFrom-Json
        if ($importState.status -match "smoke-terrain\.asc") {
            break
        }
    }

    $importState | ConvertTo-Json -Compress
    if ($importState.status -notmatch "smoke-terrain\.asc" -or
        $importState.name -ne "smoke-terrain.asc" -or
        $importState.type -ne "ASCII Grid" -or
        $importState.size -notmatch "^4\s+\D\s+4$") {
        throw "ASC import smoke assertions failed."
    }

    $capture = Invoke-Cdp -Socket $socket -Id 60 -Method "Page.captureScreenshot" -Params @{
        format = "png"
        captureBeyondViewport = $false
    }
    [System.IO.File]::WriteAllBytes(
        [System.IO.Path]::GetFullPath($Screenshot),
        [Convert]::FromBase64String($capture.result.data)
    )

    Write-Output "PASS runtime smoke"
    Write-Output "SCREENSHOT=$([System.IO.Path]::GetFullPath($Screenshot))"
}
finally {
    if ($socket) {
        $socket.Dispose()
    }
    if ($process -and -not $process.HasExited) {
        $process.CloseMainWindow() | Out-Null
        if (-not $process.WaitForExit(10000)) {
            Stop-Process -Id $process.Id -Force
        }
    }
    $smokeStore = Join-Path $env:APPDATA "studio.dem.desktop.smoke\dem-studio.json"
    if (Test-Path -LiteralPath $smokeStore) {
        Remove-Item -LiteralPath $smokeStore -Force
    }
}
