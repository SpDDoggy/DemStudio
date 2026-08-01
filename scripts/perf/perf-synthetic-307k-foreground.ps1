param(
    [string]$Executable = (Join-Path $PSScriptRoot "..\..\src-tauri\target\perf\release\dem-studio.exe"),
    [string]$EvidenceDirectory = (Join-Path $PSScriptRoot "..\..\artifacts\perf-evidence-synthetic-307k"),
    [ValidateRange(1000, 60000)]
    [int]$DragMilliseconds = 8000,
    [ValidateRange(500, 10000)]
    [int]$RecoveryMilliseconds = 1500,
    [ValidateRange(4, 100)]
    [int]$WheelSteps = 16,
    [ValidateRange(1, 240)]
    [double]$ActiveMaxP95FrameMilliseconds = 16.7,
    [ValidateRange(1, 240)]
    [double]$ActiveMaxP99FrameMilliseconds = 25,
    [ValidateRange(1, 240)]
    [double]$RecoveryMaxP95FrameMilliseconds = 16.7,
    [ValidateRange(1, 240)]
    [double]$RecoveryMaxP99FrameMilliseconds = 33.4,
    [ValidateRange(1, 1000)]
    [double]$MaxFrameMilliseconds = 50,
    [ValidateRange(0, 100)]
    [int]$MaxLongTasks = 0,
    [ValidateRange(1, 16384)]
    [int]$MinimumDrawingBufferWidth = 1400,
    [ValidateRange(1, 16384)]
    [int]$MinimumDrawingBufferHeight = 700,
    [switch]$AllowBackgroundAutomation,
    [int]$DebugPort = 9333
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

Add-Type @'
using System;
using System.Runtime.InteropServices;

public static class DemStudioPerfWindow {
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int command);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern void SwitchToThisWindow(IntPtr hWnd, bool altTab);

    [DllImport("user32.dll")]
    public static extern bool BringWindowToTop(IntPtr hWnd);
}
'@

$script:cdpMessageId = 100

function Invoke-Cdp {
    param(
        [System.Net.WebSockets.ClientWebSocket]$Socket,
        [string]$Method,
        [hashtable]$Params = @{}
    )

    $script:cdpMessageId += 1
    $messageId = $script:cdpMessageId
    $payload = @{
        id = $messageId
        method = $Method
        params = $Params
    } | ConvertTo-Json -Depth 30 -Compress
    $payloadBytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
    $payloadSegment = [System.ArraySegment[byte]]::new($payloadBytes)
    [void]$Socket.SendAsync(
        $payloadSegment,
        [System.Net.WebSockets.WebSocketMessageType]::Text,
        $true,
        [System.Threading.CancellationToken]::None
    ).GetAwaiter().GetResult()

    while ($Socket.State -eq [System.Net.WebSockets.WebSocketState]::Open) {
        $messageStream = [System.IO.MemoryStream]::new()
        try {
            do {
                $buffer = [byte[]]::new(65536)
                $receiveSegment = [System.ArraySegment[byte]]::new($buffer)
                $receiveResult = $Socket.ReceiveAsync(
                    $receiveSegment,
                    [System.Threading.CancellationToken]::None
                ).GetAwaiter().GetResult()
                if ($receiveResult.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Close) {
                    throw "CDP WebSocket closed while waiting for response $messageId."
                }
                $messageStream.Write($buffer, 0, $receiveResult.Count)
            } while (-not $receiveResult.EndOfMessage)

            $message = [System.Text.Encoding]::UTF8.GetString($messageStream.ToArray()) | ConvertFrom-Json
            if (($message.PSObject.Properties.Name -contains "id") -and
                $message.id -eq $messageId) {
                if ($message.PSObject.Properties.Name -contains "error") {
                    throw "CDP $Method failed: $($message.error.message)"
                }
                return $message
            }
        }
        finally {
            $messageStream.Dispose()
        }
    }

    throw "CDP connection closed before response $messageId."
}

function Invoke-JavaScript {
    param(
        [System.Net.WebSockets.ClientWebSocket]$Socket,
        [string]$Expression,
        [switch]$AwaitPromise
    )

    $response = Invoke-Cdp -Socket $Socket -Method "Runtime.evaluate" -Params @{
        expression = $Expression
        awaitPromise = [bool]$AwaitPromise
        returnByValue = $true
    }
    if ($response.result.PSObject.Properties.Name -contains "exceptionDetails") {
        $description = $response.result.exceptionDetails.exception.description
        if (-not $description) {
            $description = $response.result.exceptionDetails.text
        }
        throw "JavaScript evaluation failed: $description"
    }
    return $response.result.result.value
}

function Get-ElementCenter {
    param(
        [System.Net.WebSockets.ClientWebSocket]$Socket,
        [string]$Selector
    )

    $selectorJson = $Selector | ConvertTo-Json -Compress
    $value = Invoke-JavaScript -Socket $Socket -Expression @"
(() => {
  const element = document.querySelector($selectorJson);
  if (!element) throw new Error("Missing element: " + $selectorJson);
  const rect = element.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) throw new Error("Element is not actionable: " + $selectorJson);
  return JSON.stringify({
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height
  });
})()
"@
    return $value | ConvertFrom-Json
}

function Send-MouseEvent {
    param(
        [System.Net.WebSockets.ClientWebSocket]$Socket,
        [string]$Type,
        [double]$X,
        [double]$Y,
        [string]$Button = "none",
        [int]$Buttons = 0,
        [double]$DeltaX = 0,
        [double]$DeltaY = 0,
        [int]$ClickCount = 0
    )

    $parameters = @{
        type = $Type
        x = $X
        y = $Y
        button = $Button
        buttons = $Buttons
        clickCount = $ClickCount
        pointerType = "mouse"
    }
    if ($Type -eq "mouseWheel") {
        $parameters.deltaX = $DeltaX
        $parameters.deltaY = $DeltaY
    }
    [void](Invoke-Cdp -Socket $Socket -Method "Input.dispatchMouseEvent" -Params $parameters)
}

function Click-Element {
    param(
        [System.Net.WebSockets.ClientWebSocket]$Socket,
        [string]$Selector
    )

    $center = Get-ElementCenter -Socket $Socket -Selector $Selector
    Send-MouseEvent -Socket $Socket -Type "mouseMoved" -X $center.x -Y $center.y
    Send-MouseEvent -Socket $Socket -Type "mousePressed" -X $center.x -Y $center.y `
        -Button "left" -Buttons 1 -ClickCount 1
    Send-MouseEvent -Socket $Socket -Type "mouseReleased" -X $center.x -Y $center.y `
        -Button "left" -Buttons 0 -ClickCount 1
}

function Get-FrameStatistics {
    param([object[]]$Values)

    $sorted = @(
        $Values |
            ForEach-Object { [double]$_ } |
            Where-Object {
                -not [double]::IsNaN($_) -and
                -not [double]::IsInfinity($_) -and
                $_ -gt 0
            } |
            Sort-Object
    )
    if ($sorted.Count -lt 30) {
        throw "Frame sample is too small: $($sorted.Count)."
    }
    $percentile = {
        param([double]$Ratio)
        return [double]$sorted[[Math]::Floor(($sorted.Count - 1) * $Ratio)]
    }
    return [ordered]@{
        count = $sorted.Count
        p50Ms = & $percentile 0.50
        p95Ms = & $percentile 0.95
        p99Ms = & $percentile 0.99
        maxMs = [double]$sorted[-1]
        over25Ms = @($sorted | Where-Object { $_ -gt 25 }).Count
        over50Ms = @($sorted | Where-Object { $_ -gt 50 }).Count
    }
}

function Test-FrameGate {
    param(
        [object]$Statistics,
        [double]$MaxP95Milliseconds,
        [double]$MaxP99Milliseconds
    )
    return (
        [double]$Statistics.p95Ms -le $MaxP95Milliseconds -and
        [double]$Statistics.p99Ms -le $MaxP99Milliseconds -and
        [double]$Statistics.maxMs -le $MaxFrameMilliseconds -and
        [int]$Statistics.over50Ms -eq 0
    )
}

function Test-FullQualityRecovery {
    param([object]$RendererState)
    return (
        $RendererState -and
        -not $RendererState.interactionActive -and
        (Test-FullInteractionGeometry -RendererState $RendererState) -and
        $RendererState.postProcessing.composer -and
        $RendererState.postProcessing.gtao -and
        $RendererState.postProcessing.sharpen -and
        $RendererState.cameraMode -eq "orthographic" -and
        $RendererState.materialMode -eq "white"
    )
}

function Test-FullInteractionGeometry {
    param([object]$RendererState)
    return (
        $RendererState -and
        $RendererState.interactionGeometry -and
        $RendererState.interactionGeometry.mode -eq "full" -and
        $RendererState.interactionGeometry.fullVisible -and
        -not $RendererState.interactionGeometry.legacyProxyEnabled -and
        $RendererState.interactionGeometry.rollbackQuery -eq "legacyTerrainInteractionProxy=1" -and
        (
            -not $RendererState.interactionProxy -or
            -not $RendererState.interactionProxy.active
        )
    )
}

function Test-RenderSchedulerSnapshot {
    param(
        [object]$Scheduler,
        [switch]$RequireSettled
    )

    if (-not $Scheduler) {
        return $false
    }
    $pending = [long]$Scheduler.pending
    $scheduled = [long]$Scheduler.scheduled
    $callbacks = [long]$Scheduler.callbacks
    $backlog = [long]$Scheduler.backlog
    $conservationGate =
        $pending -ge 0 -and $pending -le 1 -and
        $backlog -ge 0 -and $backlog -le 1 -and
        $scheduled -ge 0 -and
        $callbacks -ge 0 -and
        $scheduled -ge $callbacks -and
        ($scheduled - $callbacks) -eq $backlog -and
        $pending -eq $backlog
    if (-not $conservationGate) {
        return $false
    }
    if ($RequireSettled) {
        return (
            $pending -eq 0 -and
            $backlog -eq 0 -and
            $scheduled -eq $callbacks
        )
    }
    return $true
}

$resolvedExecutable = [System.IO.Path]::GetFullPath($Executable)
if (-not [System.IO.File]::Exists($resolvedExecutable)) {
    throw "Performance executable not found: $resolvedExecutable"
}
$releaseSegment = [System.IO.Path]::DirectorySeparatorChar + "release" +
    [System.IO.Path]::DirectorySeparatorChar
if ($resolvedExecutable.IndexOf($releaseSegment, [System.StringComparison]::OrdinalIgnoreCase) -lt 0 -or
    $resolvedExecutable.IndexOf("\debug\", [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
    throw "Synthetic 307K evidence must use a release executable: $resolvedExecutable"
}
if ($DebugPort -ne 9333) {
    throw "The current smoke release is configured for remote-debugging port 9333."
}

$existingTargets = @()
try {
    $existingTargets = @(Invoke-RestMethod -Uri "http://127.0.0.1:$DebugPort/json" -TimeoutSec 1)
}
catch {
}
if ($existingTargets | Where-Object { $_.type -eq "page" }) {
    throw "Debug port $DebugPort is already serving a page target."
}

$timestamp = [DateTime]::UtcNow.ToString("yyyyMMdd-HHmmss")
$runDirectory = Join-Path ([System.IO.Path]::GetFullPath($EvidenceDirectory)) $timestamp
[System.IO.Directory]::CreateDirectory($runDirectory) | Out-Null
$evidencePath = Join-Path $runDirectory "summary.json"
$screenshotPath = Join-Path $runDirectory "viewport.png"

$studioProcess = $null
$socket = $null
try {
    $studioProcess = Start-Process -FilePath $resolvedExecutable -PassThru
    $debugTarget = $null
    for ($attempt = 0; $attempt -lt 120; $attempt += 1) {
        Start-Sleep -Milliseconds 250
        $studioProcess.Refresh()
        if ($studioProcess.HasExited) {
            throw "DEM Studio exited before exposing a debug target."
        }
        try {
            $targets = @(Invoke-RestMethod -Uri "http://127.0.0.1:$DebugPort/json" -TimeoutSec 1)
            $debugTarget = $targets |
                Where-Object { $_.type -eq "page" -and $_.title -eq "DEM Studio" } |
                Select-Object -First 1
            if ($debugTarget) {
                break
            }
        }
        catch {
        }
    }
    if (-not $debugTarget) {
        throw "DEM Studio did not expose its WebView debug target on port $DebugPort."
    }

    for ($attempt = 0; $attempt -lt 40; $attempt += 1) {
        $studioProcess.Refresh()
        if ($studioProcess.MainWindowHandle -ne [IntPtr]::Zero) {
            break
        }
        Start-Sleep -Milliseconds 100
    }
    $mainWindow = $studioProcess.MainWindowHandle
    if ($mainWindow -eq [IntPtr]::Zero -or -not [DemStudioPerfWindow]::IsWindowVisible($mainWindow)) {
        throw "DEM Studio did not expose a visible native window."
    }
    [void][DemStudioPerfWindow]::ShowWindow($mainWindow, 3)
    Start-Sleep -Milliseconds 500
    $windowActivator = New-Object -ComObject WScript.Shell
    for ($attempt = 0; $attempt -lt 20; $attempt += 1) {
        $windowActivator.SendKeys("%")
        [void]$windowActivator.AppActivate($studioProcess.Id)
        [DemStudioPerfWindow]::SwitchToThisWindow($mainWindow, $true)
        [void][DemStudioPerfWindow]::BringWindowToTop($mainWindow)
        [void][DemStudioPerfWindow]::SetForegroundWindow($mainWindow)
        Start-Sleep -Milliseconds 100
        if ([DemStudioPerfWindow]::GetForegroundWindow() -eq $mainWindow) {
            break
        }
    }
    if (
        [DemStudioPerfWindow]::GetForegroundWindow() -ne $mainWindow -and
        -not $AllowBackgroundAutomation
    ) {
        throw "DEM Studio is not the native foreground window."
    }

    $socket = [System.Net.WebSockets.ClientWebSocket]::new()
    [void]$socket.ConnectAsync(
        [Uri]$debugTarget.webSocketDebuggerUrl,
        [System.Threading.CancellationToken]::None
    ).GetAwaiter().GetResult()
    [void](Invoke-Cdp -Socket $socket -Method "Runtime.enable")
    [void](Invoke-Cdp -Socket $socket -Method "Page.enable")

    $ready = $false
    for ($attempt = 0; $attempt -lt 120; $attempt += 1) {
        $readyState = Invoke-JavaScript -Socket $socket -Expression @'
JSON.stringify({
  ready: document.readyState === "complete"
    && typeof window.__demStudioHarness?.getRendererDiagnostics === "function",
  visible: document.visibilityState,
  focused: document.hasFocus()
})
'@
        $readyDiagnostics = $readyState | ConvertFrom-Json
        if ($readyDiagnostics.ready -and
            $readyDiagnostics.visible -eq "visible" -and
            $readyDiagnostics.focused) {
            $ready = $true
            break
        }
        Start-Sleep -Milliseconds 250
    }
    if (-not $ready) {
        throw "DEM Studio did not become visible, focused, and Harness-ready."
    }

    Click-Element -Socket $socket -Selector '[data-quick-preset="white"]'
    Start-Sleep -Milliseconds 300
    Click-Element -Socket $socket -Selector '[data-camera-mode="orthographic"]'
    Start-Sleep -Milliseconds 200
    Click-Element -Socket $socket -Selector '[data-view="iso"]'

    $datasetState = $null
    $rendererState = $null
    for ($attempt = 0; $attempt -lt 160; $attempt += 1) {
        $stateJson = Invoke-JavaScript -Socket $socket -Expression @'
(async () => JSON.stringify({
  dataset: await window.__demStudioHarness.getDatasetState(),
  renderer: window.__demStudioHarness.getRendererDiagnostics(),
  displayedType: document.getElementById("mType")?.textContent?.trim() || null,
  titlebarType: document.getElementById("titlebarDocument")?.textContent?.trim() || null,
  visibilityState: document.visibilityState,
  hasFocus: document.hasFocus()
}))()
'@ -AwaitPromise
        $state = $stateJson | ConvertFrom-Json
        $datasetState = $state.dataset
        $rendererState = $state.renderer
        if ($state.displayedType -eq "Synthetic DEM" -and
            $state.titlebarType -eq "Synthetic DEM" -and
            $datasetState.width -eq 640 -and
            $datasetState.height -eq 480 -and
            $datasetState.sampledLength -eq 307200 -and
            $rendererState.materialMode -eq "white" -and
            $rendererState.resolution -eq 1024 -and
            $rendererState.cameraMode -eq "orthographic" -and
            $rendererState.sampledSize[0] -eq 640 -and
            $rendererState.sampledSize[1] -eq 480 -and
            $rendererState.terrainVertices -eq 316148 -and
            $rendererState.terrainTriangles -eq 616636 -and
            -not $rendererState.interactionActive) {
            break
        }
        Start-Sleep -Milliseconds 250
    }

    $topologyGate =
        $state.displayedType -eq "Synthetic DEM" -and
        $state.titlebarType -eq "Synthetic DEM" -and
        $datasetState.width -eq 640 -and
        $datasetState.height -eq 480 -and
        $datasetState.rawLength -eq 307200 -and
        $datasetState.sampledLength -eq 307200 -and
        -not $datasetState.coreId -and
        $datasetState.streamingLod.activeMeshCount -eq 0 -and
        $datasetState.streamingLod.desiredTileCount -eq 0 -and
        $rendererState.materialMode -eq "white" -and
        $rendererState.resolution -eq 1024 -and
        $rendererState.cameraMode -eq "orthographic" -and
        $rendererState.sampledSize[0] -eq 640 -and
        $rendererState.sampledSize[1] -eq 480 -and
        $rendererState.terrainVertices -eq 316148 -and
        $rendererState.terrainTriangles -eq 616636
    if (-not $topologyGate) {
        throw "Synthetic 307K topology/profile gate failed: $($state | ConvertTo-Json -Depth 8 -Compress)"
    }
    if ($rendererState.drawingBufferSize[0] -lt $MinimumDrawingBufferWidth -or
        $rendererState.drawingBufferSize[1] -lt $MinimumDrawingBufferHeight) {
        throw "Drawing buffer is below the configured foreground acceptance size."
    }

    $schedulerStartRenderer = $null
    for ($attempt = 0; $attempt -lt 80; $attempt += 1) {
        $schedulerStartRenderer = (
            Invoke-JavaScript -Socket $socket -Expression @'
JSON.stringify(window.__demStudioHarness.getRendererDiagnostics())
'@
        ) | ConvertFrom-Json
        if (
            -not $schedulerStartRenderer.interactionActive -and
            $schedulerStartRenderer.renderScheduler.pending -eq 0 -and
            $schedulerStartRenderer.renderScheduler.backlog -eq 0
        ) {
            break
        }
        Start-Sleep -Milliseconds 50
    }
    $schedulerStart = $schedulerStartRenderer.renderScheduler
    if (-not (Test-RenderSchedulerSnapshot -Scheduler $schedulerStart -RequireSettled)) {
        throw "Render scheduler was not settled and conserved before interaction: $($schedulerStart | ConvertTo-Json -Compress)"
    }

    $gpuJson = Invoke-JavaScript -Socket $socket -Expression @'
(() => {
  const canvas = document.querySelector("#viewport canvas") || document.querySelector("canvas");
  const gl = canvas?.getContext?.("webgl2") || canvas?.getContext?.("webgl");
  if (!gl) throw new Error("WebGL context is unavailable.");
  const extension = gl.getExtension("WEBGL_debug_renderer_info");
  return JSON.stringify({
    renderer: extension
      ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL)
      : gl.getParameter(gl.RENDERER),
    vendor: extension
      ? gl.getParameter(extension.UNMASKED_VENDOR_WEBGL)
      : gl.getParameter(gl.VENDOR)
  });
})()
'@
    $gpu = $gpuJson | ConvertFrom-Json
    if ([string]::IsNullOrWhiteSpace([string]$gpu.renderer) -or
        [string]$gpu.renderer -match "SwiftShader|llvmpipe|software") {
        throw "Hardware WebGL renderer gate failed: $($gpu.renderer)"
    }

    $probeInstall = Invoke-JavaScript -Socket $socket -Expression @'
(() => {
  if (!PerformanceObserver.supportedEntryTypes?.includes("longtask")) {
    throw new Error("Long Task PerformanceObserver is unavailable.");
  }
  const previous = window.__demStudioSynthetic307kProbe;
  previous?.stop?.();
  const state = {
    active: true,
    phase: "idle",
    lastFrameAt: 0,
    intervals: {},
    longTasks: [],
    events: {
      pointerdown: 0,
      pointermove: 0,
      pointerup: 0,
      wheel: 0,
      untrusted: 0
    },
    eventListeners: [],
    raf: 0,
    observer: null,
    setPhase(name) {
      this.phase = name;
      this.lastFrameAt = performance.now();
      this.intervals[name] = [];
      window.__demStudioHarness.resetRenderPerformanceSamples();
    },
    stop() {
      this.active = false;
      cancelAnimationFrame(this.raf);
      this.observer?.disconnect();
      for (const [target, type, listener] of this.eventListeners) {
        target.removeEventListener(type, listener, true);
      }
    }
  };
  const canvas = document.querySelector("#viewport canvas");
  if (!canvas) throw new Error("Terrain canvas is unavailable.");
  for (const type of ["pointerdown", "pointermove", "pointerup", "wheel"]) {
    const listener = event => {
      state.events[type]++;
      if (!event.isTrusted) state.events.untrusted++;
    };
    canvas.addEventListener(type, listener, true);
    state.eventListeners.push([canvas, type, listener]);
  }
  state.observer = new PerformanceObserver(list => {
    for (const entry of list.getEntries()) {
      state.longTasks.push({
        phase: state.phase,
        startTime: entry.startTime,
        duration: entry.duration
      });
    }
  });
  state.observer.observe({ type: "longtask" });
  const tick = now => {
    if (!state.active) return;
    if (state.phase !== "idle") {
      const delta = now - state.lastFrameAt;
      if (delta > 0) state.intervals[state.phase].push(delta);
      state.lastFrameAt = now;
      window.__demStudioHarness.invalidateRender(1);
    }
    state.raf = requestAnimationFrame(tick);
  };
  state.raf = requestAnimationFrame(tick);
  window.__demStudioSynthetic307kProbe = state;
  return "installed";
})()
'@
    if ($probeInstall -ne "installed") {
        throw "Synthetic 307K in-page probe installation failed."
    }

    $canvas = Get-ElementCenter -Socket $socket -Selector "#viewport canvas"
    $dragRadiusX = [Math]::Min($canvas.width * 0.22, 280)
    $dragRadiusY = [Math]::Min($canvas.height * 0.16, 160)
    $dragSteps = [Math]::Max(60, [Math]::Floor($DragMilliseconds / 16))

    [void](Invoke-JavaScript -Socket $socket -Expression @'
window.__demStudioSynthetic307kProbe.setPhase("drag"); "ok"
'@)
    Send-MouseEvent -Socket $socket -Type "mouseMoved" -X $canvas.x -Y $canvas.y
    Send-MouseEvent -Socket $socket -Type "mousePressed" -X $canvas.x -Y $canvas.y `
        -Button "left" -Buttons 1 -ClickCount 1
    Send-MouseEvent -Socket $socket -Type "mouseMoved" -X ($canvas.x + 24) -Y ($canvas.y + 12) `
        -Button "left" -Buttons 1
    $dragActiveState = (
        Invoke-JavaScript -Socket $socket -Expression @'
JSON.stringify(window.__demStudioHarness.getRendererDiagnostics())
'@
    ) | ConvertFrom-Json
    if (-not $dragActiveState.interactionActive) {
        throw "Trusted drag input did not activate OrbitControls interaction rendering."
    }
    $dragActiveGeometryGate = Test-FullInteractionGeometry -RendererState $dragActiveState
    if (-not $dragActiveGeometryGate) {
        throw "Active drag did not retain full terrain geometry: $($dragActiveState.interactionGeometry | ConvertTo-Json -Compress)"
    }
    $schedulerMid = $dragActiveState.renderScheduler
    if (-not (Test-RenderSchedulerSnapshot -Scheduler $schedulerMid)) {
        throw "Render scheduler conservation failed during interaction: $($schedulerMid | ConvertTo-Json -Compress)"
    }
    for ($step = 0; $step -lt $dragSteps; $step += 1) {
        $angle = 2 * [Math]::PI * $step / $dragSteps
        $x = $canvas.x + [Math]::Cos($angle) * $dragRadiusX
        $y = $canvas.y + [Math]::Sin($angle * 1.5) * $dragRadiusY
        Send-MouseEvent -Socket $socket -Type "mouseMoved" -X $x -Y $y `
            -Button "left" -Buttons 1
        Start-Sleep -Milliseconds 12
    }

    [void](Invoke-JavaScript -Socket $socket -Expression @'
window.__demStudioSynthetic307kProbe.setPhase("dragRecovery"); "ok"
'@)
    Send-MouseEvent -Socket $socket -Type "mouseReleased" -X $canvas.x -Y $canvas.y `
        -Button "left" -Buttons 0 -ClickCount 1
    Start-Sleep -Milliseconds $RecoveryMilliseconds
    $dragRecoverySnapshot = (
        Invoke-JavaScript -Socket $socket -Expression @'
JSON.stringify({
  performance: window.__demStudioHarness.getRenderPerformanceSnapshot(),
  renderer: window.__demStudioHarness.getRendererDiagnostics()
})
'@
    ) | ConvertFrom-Json

    [void](Invoke-JavaScript -Socket $socket -Expression @'
window.__demStudioSynthetic307kProbe.setPhase("wheel"); "ok"
'@)
    $wheelActiveState = $null
    $wheelActiveGeometryGate = $false
    for ($step = 0; $step -lt $WheelSteps; $step += 1) {
        $direction = if (($step % 2) -eq 0) { -1 } else { 1 }
        Send-MouseEvent -Socket $socket -Type "mouseWheel" -X $canvas.x -Y $canvas.y `
            -DeltaY ($direction * 120)
        if ($step -eq 0) {
            $wheelActiveState = (
                Invoke-JavaScript -Socket $socket -Expression @'
JSON.stringify(window.__demStudioHarness.getRendererDiagnostics())
'@
            ) | ConvertFrom-Json
            $wheelActiveGeometryGate =
                $wheelActiveState.interactionActive -and
                (Test-FullInteractionGeometry -RendererState $wheelActiveState)
            if (-not $wheelActiveGeometryGate) {
                throw "First wheel event did not retain full terrain geometry: $($wheelActiveState | ConvertTo-Json -Depth 6 -Compress)"
            }
        }
        Start-Sleep -Milliseconds 70
    }

    [void](Invoke-JavaScript -Socket $socket -Expression @'
window.__demStudioSynthetic307kProbe.setPhase("wheelRecovery"); "ok"
'@)
    Start-Sleep -Milliseconds $RecoveryMilliseconds
    $wheelRecoverySnapshot = (
        Invoke-JavaScript -Socket $socket -Expression @'
JSON.stringify({
  performance: window.__demStudioHarness.getRenderPerformanceSnapshot(),
  renderer: window.__demStudioHarness.getRendererDiagnostics()
})
'@
    ) | ConvertFrom-Json

    $finalJson = Invoke-JavaScript -Socket $socket -Expression @'
(() => {
  const probe = window.__demStudioSynthetic307kProbe;
  probe.stop();
  return JSON.stringify({
    intervals: probe.intervals,
    longTasks: probe.longTasks,
    events: probe.events,
    renderer: window.__demStudioHarness.getRendererDiagnostics(),
    visibilityState: document.visibilityState,
    hasFocus: document.hasFocus()
  });
})()
'@
    $final = $finalJson | ConvertFrom-Json

    $schedulerEndRenderer = $null
    for ($attempt = 0; $attempt -lt 80; $attempt += 1) {
        $schedulerEndRenderer = (
            Invoke-JavaScript -Socket $socket -Expression @'
JSON.stringify(window.__demStudioHarness.getRendererDiagnostics())
'@
        ) | ConvertFrom-Json
        if (
            -not $schedulerEndRenderer.interactionActive -and
            $schedulerEndRenderer.renderScheduler.pending -eq 0 -and
            $schedulerEndRenderer.renderScheduler.backlog -eq 0
        ) {
            break
        }
        Start-Sleep -Milliseconds 50
    }
    $schedulerEnd = $schedulerEndRenderer.renderScheduler
    if (-not (Test-RenderSchedulerSnapshot -Scheduler $schedulerEnd -RequireSettled)) {
        throw "Render scheduler did not settle with conserved callbacks: $($schedulerEnd | ConvertTo-Json -Compress)"
    }
    $final.renderer = $schedulerEndRenderer

    $dragStats = Get-FrameStatistics -Values @($final.intervals.drag)
    $dragRecoveryStats = Get-FrameStatistics -Values @($final.intervals.dragRecovery)
    $wheelStats = Get-FrameStatistics -Values @($final.intervals.wheel)
    $wheelRecoveryStats = Get-FrameStatistics -Values @($final.intervals.wheelRecovery)
    $longTasks = @($final.longTasks)
    $inputGate =
        $final.events.pointerdown -ge 1 -and
        $final.events.pointermove -ge $dragSteps -and
        $final.events.pointerup -ge 1 -and
        $final.events.wheel -ge $WheelSteps -and
        $final.events.untrusted -eq 0 -and
        $dragActiveState.interactionActive
    $longTaskGate = $longTasks.Count -le $MaxLongTasks
    $schedulerMonotonicGate =
        [long]$schedulerStart.scheduled -le [long]$schedulerMid.scheduled -and
        [long]$schedulerMid.scheduled -le [long]$schedulerEnd.scheduled -and
        [long]$schedulerStart.callbacks -le [long]$schedulerMid.callbacks -and
        [long]$schedulerMid.callbacks -le [long]$schedulerEnd.callbacks
    $schedulerDeltaGate =
        (
            [long]$schedulerEnd.scheduled -
            [long]$schedulerStart.scheduled
        ) -eq (
            [long]$schedulerEnd.callbacks -
            [long]$schedulerStart.callbacks
        )
    $schedulerGate =
        (Test-RenderSchedulerSnapshot -Scheduler $schedulerStart -RequireSettled) -and
        (Test-RenderSchedulerSnapshot -Scheduler $schedulerMid) -and
        (Test-RenderSchedulerSnapshot -Scheduler $schedulerEnd -RequireSettled) -and
        $schedulerMonotonicGate -and
        $schedulerDeltaGate
    $foregroundGate =
        [DemStudioPerfWindow]::GetForegroundWindow() -eq $mainWindow -and
        $final.visibilityState -eq "visible" -and
        $final.hasFocus
    $dragRecoveryQualityGate = Test-FullQualityRecovery -RendererState $dragRecoverySnapshot.renderer
    $wheelRecoveryQualityGate = Test-FullQualityRecovery -RendererState $wheelRecoverySnapshot.renderer
    $finalRecoveryQualityGate = Test-FullQualityRecovery -RendererState $final.renderer
    $activeGeometryGate =
        $dragActiveGeometryGate -and
        $wheelActiveGeometryGate
    $recoveryQualityGate =
        $dragRecoveryQualityGate -and
        $wheelRecoveryQualityGate -and
        $finalRecoveryQualityGate
    $dragGate = Test-FrameGate -Statistics $dragStats `
        -MaxP95Milliseconds $ActiveMaxP95FrameMilliseconds `
        -MaxP99Milliseconds $ActiveMaxP99FrameMilliseconds
    $dragRecoveryGate = Test-FrameGate -Statistics $dragRecoveryStats `
        -MaxP95Milliseconds $RecoveryMaxP95FrameMilliseconds `
        -MaxP99Milliseconds $RecoveryMaxP99FrameMilliseconds
    $wheelGate = Test-FrameGate -Statistics $wheelStats `
        -MaxP95Milliseconds $ActiveMaxP95FrameMilliseconds `
        -MaxP99Milliseconds $ActiveMaxP99FrameMilliseconds
    $wheelRecoveryGate = Test-FrameGate -Statistics $wheelRecoveryStats `
        -MaxP95Milliseconds $RecoveryMaxP95FrameMilliseconds `
        -MaxP99Milliseconds $RecoveryMaxP99FrameMilliseconds
    $verdict = (
        $topologyGate -and
        $inputGate -and
        $activeGeometryGate -and
        $foregroundGate -and
        $recoveryQualityGate -and
        $dragGate -and
        $dragRecoveryGate -and
        $wheelGate -and
        $wheelRecoveryGate -and
        $schedulerGate -and
        $longTaskGate
    )

    $capture = Invoke-Cdp -Socket $socket -Method "Page.captureScreenshot" -Params @{
        format = "png"
        captureBeyondViewport = $false
    }
    [System.IO.File]::WriteAllBytes(
        $screenshotPath,
        [Convert]::FromBase64String($capture.result.data)
    )

    $evidence = [ordered]@{
        schema = "dem-studio-synthetic-307k-foreground-performance-v2"
        verdict = if ($verdict) { "PASS" } else { "FAIL" }
        utc = [DateTime]::UtcNow.ToString("o")
        executable = $resolvedExecutable
        executableSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $resolvedExecutable).Hash
        nativeForeground = $foregroundGate
        gpu = $gpu
        profile = [ordered]@{
            datasetName = $datasetState.name
            displayedType = $state.displayedType
            sourceSize = @($datasetState.width, $datasetState.height)
            sourceSamples = $datasetState.rawLength
            sampledSize = @($final.renderer.sampledSize)
            sampledVertices = $datasetState.sampledLength
            actualGeometryVertices = $final.renderer.terrainVertices
            actualGeometryTriangles = $final.renderer.terrainTriangles
            materialMode = $final.renderer.materialMode
            resolution = $final.renderer.resolution
            cameraMode = $final.renderer.cameraMode
            canvasCssSize = @($final.renderer.canvasCssSize)
            drawingBufferSize = @($final.renderer.drawingBufferSize)
            devicePixelRatio = $final.renderer.devicePixelRatio
            rendererInfo = $final.renderer.rendererInfo
            shadowMap = $final.renderer.shadowMap
            postProcessing = $final.renderer.postProcessing
        }
        thresholds = [ordered]@{
            activeInteraction = [ordered]@{
                maxP95FrameMilliseconds = $ActiveMaxP95FrameMilliseconds
                maxP99FrameMilliseconds = $ActiveMaxP99FrameMilliseconds
                maxFrameMilliseconds = $MaxFrameMilliseconds
            }
            fullQualityRecovery = [ordered]@{
                maxP95FrameMilliseconds = $RecoveryMaxP95FrameMilliseconds
                maxP99FrameMilliseconds = $RecoveryMaxP99FrameMilliseconds
                maxFrameMilliseconds = $MaxFrameMilliseconds
                rationale = "Static 4x HDR MSAA plus GTAO recovery may consume one 30 FPS frame budget; frames above 50 ms remain forbidden."
            }
            maxLongTasks = $MaxLongTasks
            minimumDrawingBuffer = @($MinimumDrawingBufferWidth, $MinimumDrawingBufferHeight)
        }
        sampling = [ordered]@{
            dragMilliseconds = $DragMilliseconds
            recoveryMillisecondsPerPhase = $RecoveryMilliseconds
            wheelSteps = $WheelSteps
            wheelStepDelayMilliseconds = 70
        }
        phases = [ordered]@{
            drag = $dragStats
            dragRecovery = $dragRecoveryStats
            wheel = $wheelStats
            wheelRecovery = $wheelRecoveryStats
        }
        renderCpuSubmission = [ordered]@{
            dragRecovery = $dragRecoverySnapshot.performance
            wheelRecovery = $wheelRecoverySnapshot.performance
        }
        activeGeometry = [ordered]@{
            passed = $activeGeometryGate
            rollbackQuery = "legacyTerrainInteractionProxy=1"
            drag = [ordered]@{
                passed = $dragActiveGeometryGate
                renderer = $dragActiveState
            }
            wheel = [ordered]@{
                passed = $wheelActiveGeometryGate
                renderer = $wheelActiveState
            }
        }
        recoveryQuality = [ordered]@{
            drag = [ordered]@{
                passed = $dragRecoveryQualityGate
                renderer = $dragRecoverySnapshot.renderer
            }
            wheel = [ordered]@{
                passed = $wheelRecoveryQualityGate
                renderer = $wheelRecoverySnapshot.renderer
            }
            final = [ordered]@{
                passed = $finalRecoveryQualityGate
                renderer = $final.renderer
            }
        }
        renderScheduler = [ordered]@{
            start = $schedulerStart
            mid = $schedulerMid
            end = $schedulerEnd
            monotonic = $schedulerMonotonicGate
            scheduledCallbackDeltaConserved = $schedulerDeltaGate
        }
        longTasks = $longTasks
        trustedInputEvents = $final.events
        gates = [ordered]@{
            PROFILE_307K = $topologyGate
            TRUSTED_CDP_POINTER_AND_WHEEL = $inputGate
            ACTIVE_GEOMETRY_FULL = $activeGeometryGate
            FOREGROUND_VISIBLE_FOCUSED = $foregroundGate
            ACTIVE_DRAG = $dragGate
            DRAG_RECOVERY_FULL_QUALITY = ($dragRecoveryGate -and $dragRecoveryQualityGate)
            ACTIVE_WHEEL = $wheelGate
            WHEEL_RECOVERY_FULL_QUALITY = ($wheelRecoveryGate -and $wheelRecoveryQualityGate)
            FULL_QUALITY_RESTORED = $recoveryQualityGate
            RENDER_SCHEDULER_CONSERVATION = $schedulerGate
            LONG_TASKS = $longTaskGate
        }
        screenshot = $screenshotPath
    }
    [System.IO.File]::WriteAllText(
        $evidencePath,
        (($evidence | ConvertTo-Json -Depth 20) + [Environment]::NewLine),
        [System.Text.UTF8Encoding]::new($false)
    )
    Write-Output ($evidence | ConvertTo-Json -Depth 20)
    Write-Output "PERF_SYNTHETIC_307K_EVIDENCE=$evidencePath"
    if (-not $verdict) {
        throw "Synthetic 307K foreground performance gates failed. See $evidencePath"
    }
}
finally {
    if ($socket) {
        try {
            if ($socket.State -eq [System.Net.WebSockets.WebSocketState]::Open) {
                [void]$socket.CloseAsync(
                    [System.Net.WebSockets.WebSocketCloseStatus]::NormalClosure,
                    "done",
                    [System.Threading.CancellationToken]::None
                ).GetAwaiter().GetResult()
            }
        }
        catch {
        }
        $socket.Dispose()
    }
    if ($studioProcess -and -not $studioProcess.HasExited) {
        Stop-Process -Id $studioProcess.Id -Force -ErrorAction SilentlyContinue
        try {
            $studioProcess.WaitForExit(5000)
        }
        catch {
        }
    }
}
