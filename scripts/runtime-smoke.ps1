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

    for ($attempt = 0; $attempt -lt 80; $attempt += 1) {
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
  hostCore: window.demStudioHost?.core ?? null,
  lensDbLoad: typeof window.lens?.db?.load,
  lensFsWriteBlob: typeof window.lens?.fs?.writeBlob,
  coreOpenPath: typeof window.lens?.core?.openDemPath,
  coreOpenTexture: typeof window.lens?.core?.openTexture,
  coreSample: typeof window.lens?.core?.sampleDem,
  coreExport: typeof window.lens?.core?.encodeGeoTiff,
  windowMinimize: typeof window.lens?.window?.minimize,
  titlebarHeight: Math.round(document.getElementById("titlebar")?.getBoundingClientRect().height ?? 0),
  canvasCount: document.querySelectorAll("canvas").length,
  browserFileInputs: document.querySelectorAll('input[type="file"]').length,
  appDialog: Boolean(document.getElementById("appDialogLayer")),
  panelCapsules: document.querySelectorAll(".panel-capsule").length,
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
        $state.hostCore -ne "rust-dem-core" -or
        $state.lensDbLoad -ne "function" -or
        $state.lensFsWriteBlob -ne "function" -or
        $state.coreOpenPath -ne "function" -or
        $state.coreOpenTexture -ne "function" -or
        $state.coreSample -ne "function" -or
        $state.coreExport -ne "function" -or
        $state.windowMinimize -ne "function" -or
        $state.titlebarHeight -ne 52 -or
        $state.canvasCount -lt 1 -or
        $state.browserFileInputs -ne 0 -or
        -not $state.appDialog -or
        $state.panelCapsules -ne 2 -or
        $state.bootError) {
        throw "Runtime smoke assertions failed."
    }

    $fixtureJson = [System.IO.Path]::GetFullPath($Fixture) | ConvertTo-Json -Compress
    $openResult = Invoke-Cdp -Socket $socket -Id 4 -Method "Runtime.evaluate" -Params @{
        expression = "(async () => { await window.__demStudioOpenPath($fixtureJson); return true; })()"
        awaitPromise = $true
        returnByValue = $true
    }
    if ($openResult.result.exceptionDetails) {
        throw ($openResult.result.exceptionDetails.text)
    }

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

    $projectionResult = Invoke-Cdp -Socket $socket -Id 54 -Method "Runtime.evaluate" -Params @{
        expression = @'
(() => {
  window.__demStudioHarness.setCameraMode("orthographic");
  const orthographicState = window.__demStudioHarness.getState();
  const orthographic = {
    actual: orthographicState.cameraMode === "orthographic",
    setting: orthographicState.settingMode,
    pressed: orthographicState.activeCameraPressed
  };
  window.__demStudioHarness.setCameraMode("perspective");
  const perspectiveState = window.__demStudioHarness.getState();
  const perspective = {
    actual: perspectiveState.cameraMode === "perspective",
    setting: perspectiveState.settingMode,
    pressed: perspectiveState.activeCameraPressed
  };
  const infiniteGrid = perspectiveState.infiniteGrid;
  window.__demStudioHarness.setPanelsVisible(false, false);
  const collapsedState = window.__demStudioHarness.getState();
  const collapsed = {
    resource: collapsedState.resourceCollapsed,
    settings: collapsedState.settingsCollapsed
  };
  window.__demStudioHarness.setPanelsVisible(true, true);
  return JSON.stringify({ orthographic, perspective, infiniteGrid, collapsed });
})()
'@
        returnByValue = $true
    }
    if ($projectionResult.result.exceptionDetails) {
        $projectionResult.result.exceptionDetails | ConvertTo-Json -Depth 10
        throw "Projection runtime evaluation failed."
    }
    $projectionState = $projectionResult.result.result.value | ConvertFrom-Json
    $projectionState | ConvertTo-Json -Compress
    if (-not $projectionState.orthographic.actual -or
        $projectionState.orthographic.setting -ne "orthographic" -or
        $projectionState.orthographic.pressed -ne "true" -or
        -not $projectionState.perspective.actual -or
        $projectionState.perspective.setting -ne "perspective" -or
        $projectionState.perspective.pressed -ne "true" -or
        -not $projectionState.infiniteGrid -or
        -not $projectionState.collapsed.resource -or
        -not $projectionState.collapsed.settings) {
        throw "Projection, infinite grid, or panel capsule assertions failed."
    }

    $exportResult = Invoke-Cdp -Socket $socket -Id 55 -Method "Runtime.evaluate" -Params @{
        expression = @'
(async () => {
  const bytes = await window.lens.core.encodeGeoTiff(
    2,
    2,
    new Uint8Array([
      10, 20, 30, 255, 40, 50, 60, 255,
      70, 80, 90, 255, 100, 110, 120, 0
    ]),
    {
      geoTransform: [100, 5, 0, 200, 0, -5],
      sourceGeoTiffTags: {
        geoKeyDirectory: [1, 1, 0, 2, 1024, 0, 1, 2, 1025, 0, 1, 1]
      }
    },
    true
  );
  return JSON.stringify({
    byteLength: bytes.length,
    littleEndian: bytes[0] === 0x49 && bytes[1] === 0x49,
    tiffMagic: bytes[2] === 42 && bytes[3] === 0
  });
})()
'@
        awaitPromise = $true
        returnByValue = $true
    }
    if ($exportResult.result.exceptionDetails) {
        throw ($exportResult.result.exceptionDetails.text)
    }
    $exportState = $exportResult.result.result.value | ConvertFrom-Json
    $exportState | ConvertTo-Json -Compress
    if ($exportState.byteLength -lt 100 -or
        -not $exportState.littleEndian -or
        -not $exportState.tiffMagic) {
        throw "Rust GeoTIFF export smoke assertions failed."
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
