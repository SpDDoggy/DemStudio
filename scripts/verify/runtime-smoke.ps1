param(
    [string]$Executable = (Join-Path $PSScriptRoot "..\..\src-tauri\target\debug\dem-studio.exe"),
    [string]$Screenshot = (Join-Path $PSScriptRoot "..\..\runtime-smoke.png"),
    [string]$FocusScreenshot = "",
    [string]$PresetScreenshot = "",
    [string]$PresetCanvasScreenshot = "",
    [string]$LightingAblationDirectory = "",
    [string]$Fixture = (Join-Path $PSScriptRoot "..\..\tests\fixtures\smoke-terrain.asc"),
    [int]$DebugPort = 9457,
    [ValidateSet("", "webgpu", "webgl2")]
    [string]$RendererBackend = "",
    [switch]$ForceWebGpuInitFailure,
    [switch]$NativeImportDialog,
    [string]$ExpectedName = "smoke-terrain.asc",
    [string]$ExpectedType = "ASCII Grid",
    [string]$ExpectedSizePattern = "^4\s+\D\s+4$",
    [string]$QuickPreset = "",
    [switch]$PresetRoundTripProbe,
    [switch]$RecentClick,
    [string]$RecentSeedPath = "",
    [string]$SeedRecentOnly = "",
    [string]$RecentExpectedSizePattern = "",
    [switch]$CinematicProbe,
    [string]$CinematicOutput = "",
    [switch]$CinematicTransparent,
    [int]$CinematicSamples = 1,
    [int]$CinematicMaxDimension = 384,
    [switch]$FileBackedProbe,
    [ValidateSet(0, 256, 512, 1024, 2048, 4096)]
    [int]$ExpectedLodTargetDimension = 0,
    [ValidateRange(2, 4096)]
    [int]$ExpectedOverviewCols = 128,
    [ValidateRange(2, 4096)]
    [int]$ExpectedOverviewRows = 128,
    [ValidateRange(0, 16777216)]
    [int]$ExpectedOverviewValidCount = 0,
    [uint32]$ExpectedOverviewMaskHash = 0,
    [ValidateRange(0, 100000000)]
    [int]$ExpectedMinimumReadyVertices = 0,
    [ValidateRange(0, 100000000)]
    [int]$ExpectedReadyTriangles = 0,
    [ValidateRange(0, 100000)]
    [int]$ExpectedMinimumTargetLevelTiles = 0,
    [ValidateRange(0, 17179869184)]
    [long]$MaxProcessTreeWorkingSetBytes = 0,
    [double]$ExpectedMinimum = [double]::NaN,
    [double]$ExpectedMaximum = [double]::NaN,
    [string]$SummaryJson = "",
    [switch]$ExpectBrowserImage,
    [switch]$SyntheticDemo,
    [switch]$PerformanceProbe,
    [switch]$CameraControlProbe,
    [switch]$TerrainSettingsProbe,
    [switch]$VisualAppearanceProbe,
    [ValidateRange(250, 900000)]
    [int]$FrameSampleMilliseconds = 3000,
    [ValidateRange(0, 1000)]
    [double]$MinP95Fps = 0,
    [ValidateRange(0, 1000)]
    [double]$MaxP99FrameMilliseconds = 0,
    [ValidateRange(0, 1000)]
    [double]$MaxFrameMilliseconds = 0,
    [ValidateRange(0, 100000)]
    [int]$MaxLongTaskCount = 0,
    [ValidateRange(0, 600000)]
    [double]$MaxFirstFrameMilliseconds = 0,
    [ValidateRange(0, 300)]
    [int]$TerrainStabilitySeconds = 0,
    [switch]$RefinementCacheProbe,
    [switch]$MemoryTrendProbe,
    [ValidateRange(1, 10000000)]
    [int]$MinimumViewportChanges = 200
)

$ErrorActionPreference = "Stop"

function Resolve-OutputPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    $resolved = [System.IO.Path]::GetFullPath($Path)
    $parent = [System.IO.Path]::GetDirectoryName($resolved)
    if ($parent) {
        [System.IO.Directory]::CreateDirectory($parent) | Out-Null
    }
    return $resolved
}

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
    $null = $Socket.SendAsync(
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

function Get-ProcessTreeMemorySnapshot {
    param(
        [int]$RootProcessId,
        [string]$Stage
    )

    try {
        $processRows = @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name)
        $processIds = [System.Collections.Generic.HashSet[int]]::new()
        [void]$processIds.Add($RootProcessId)
        $changed = $true
        while ($changed) {
            $changed = $false
            foreach ($row in $processRows) {
                if ($processIds.Contains([int]$row.ParentProcessId) -and
                    $processIds.Add([int]$row.ProcessId)) {
                    $changed = $true
                }
            }
        }

        [long]$treeWorkingSetBytes = 0
        [long]$treePrivateBytes = 0
        [long]$webView2WorkingSetBytes = 0
        [long]$webView2PrivateBytes = 0
        [int]$liveProcessCount = 0
        [int]$webView2ProcessCount = 0
        foreach ($row in $processRows) {
            if (-not $processIds.Contains([int]$row.ProcessId)) {
                continue
            }
            $liveProcess = Get-Process -Id ([int]$row.ProcessId) -ErrorAction SilentlyContinue
            if (-not $liveProcess) {
                continue
            }
            $liveProcessCount += 1
            $treeWorkingSetBytes += [long]$liveProcess.WorkingSet64
            $treePrivateBytes += [long]$liveProcess.PrivateMemorySize64
            if ([string]$row.Name -match "^(msedgewebview2|WebView2).*[.]exe$") {
                $webView2ProcessCount += 1
                $webView2WorkingSetBytes += [long]$liveProcess.WorkingSet64
                $webView2PrivateBytes += [long]$liveProcess.PrivateMemorySize64
            }
        }

        return [ordered]@{
            stage = $Stage
            available = $true
            rootProcessId = $RootProcessId
            processCount = $liveProcessCount
            workingSetBytes = $treeWorkingSetBytes
            privateBytes = $treePrivateBytes
            webView2ProcessCount = $webView2ProcessCount
            webView2WorkingSetBytes = $webView2WorkingSetBytes
            webView2PrivateBytes = $webView2PrivateBytes
        }
    }
    catch {
        return [ordered]@{
            stage = $Stage
            available = $false
            rootProcessId = $RootProcessId
            error = $_.Exception.Message
        }
    }
}

if ($NativeImportDialog) {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    Add-Type @'
using System;
using System.Runtime.InteropServices;

public static class DemStudioNativeImport {
    [DllImport("user32.dll")]
    public static extern IntPtr GetLastActivePopup(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr SendMessage(IntPtr hWnd, uint message, IntPtr wParam, string lParam);

    [DllImport("user32.dll")]
    private static extern IntPtr SendMessage(IntPtr hWnd, uint message, IntPtr wParam, IntPtr lParam);

    public static void SetControlText(IntPtr hWnd, string value) {
        SendMessage(hWnd, 0x000C, IntPtr.Zero, value);
    }

    public static void ClickButton(IntPtr hWnd) {
        SendMessage(hWnd, 0x00F5, IntPtr.Zero, IntPtr.Zero);
    }
}
'@
}

$resolvedExecutable = [System.IO.Path]::GetFullPath($Executable)
if (-not (Test-Path -LiteralPath $resolvedExecutable)) {
    throw "Executable not found: $resolvedExecutable"
}

$process = $null
$socket = $null
$performanceStages = [ordered]@{}
[long]$peakProcessTreeWorkingSetBytes = 0
[long]$peakWebView2WorkingSetBytes = 0
$memoryAggregationAvailable = $false
$memorySamples = [System.Collections.Generic.List[object]]::new()
$overviewState = $null
$focusState = $null
$finalDatasetState = $null
$frameState = $null
$whitePerformance = $null
$terrainStabilityState = $null
$refinementCacheProbeState = $null
$memoryTrendState = $null

function Measure-DemStudioMemory {
    param([string]$Stage)

    if (-not $process -or $process.HasExited) {
        return $null
    }
    $snapshot = Get-ProcessTreeMemorySnapshot -RootProcessId $process.Id -Stage $Stage
    if ($snapshot.available) {
        $script:memorySamples.Add([pscustomobject]$snapshot)
        $script:memoryAggregationAvailable = $true
        $script:peakProcessTreeWorkingSetBytes = [Math]::Max(
            $script:peakProcessTreeWorkingSetBytes,
            [long]$snapshot.workingSetBytes
        )
        $script:peakWebView2WorkingSetBytes = [Math]::Max(
            $script:peakWebView2WorkingSetBytes,
            [long]$snapshot.webView2WorkingSetBytes
        )
    }
    Write-Output "MEMORY_STAGE=$($snapshot | ConvertTo-Json -Compress)"
}

try {
    $process = Start-Process -FilePath $resolvedExecutable -PassThru
    $startedAt = [DateTime]::UtcNow
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
    $performanceStages.startupToDebugTargetMs = [Math]::Round(
        ([DateTime]::UtcNow - $startedAt).TotalMilliseconds,
        2
    )
    Measure-DemStudioMemory -Stage "debug-target"

    $socket = [System.Net.WebSockets.ClientWebSocket]::new()
    $null = $socket.ConnectAsync(
        [Uri]$target.webSocketDebuggerUrl,
        [System.Threading.CancellationToken]::None
    ).GetAwaiter().GetResult()

    if ($ForceWebGpuInitFailure -and $RendererBackend -ne "webgpu") {
        throw "ForceWebGpuInitFailure requires RendererBackend=webgpu."
    }
    if ($RendererBackend) {
        $backendJson = $RendererBackend | ConvertTo-Json -Compress
        $forceWebGpuFailureJson = ([bool]$ForceWebGpuInitFailure) | ConvertTo-Json -Compress
        $backendSeed = Invoke-Cdp -Socket $socket -Id 90 -Method "Runtime.evaluate" -Params @{
            expression = "sessionStorage.setItem('dem-studio-render-backend', $backendJson); sessionStorage.setItem('dem-studio-force-webgpu-init-failure', String($forceWebGpuFailureJson))"
            returnByValue = $true
        }
        if ($backendSeed.result.exceptionDetails) {
            throw ($backendSeed.result.exceptionDetails.text)
        }
        Invoke-Cdp -Socket $socket -Id 91 -Method "Page.reload" | Out-Null
        Start-Sleep -Milliseconds 750
    }

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
  coreSampleBinary: typeof window.lens?.core?.sampleDemBinary,
  coreSampleOverviewBinary: typeof window.lens?.core?.sampleDemOverviewBinary,
  coreRelease: typeof window.lens?.core?.releaseDem,
  coreStats: typeof window.lens?.core?.coreStats,
  coreExport: typeof window.lens?.core?.encodeGeoTiff,
  windowMinimize: typeof window.lens?.window?.minimize,
  titlebarHeight: Math.round(document.getElementById("titlebar")?.getBoundingClientRect().height ?? 0),
  titlebarBackground: getComputedStyle(document.getElementById("titlebar")).backgroundColor,
  titlebarBackdrop: getComputedStyle(document.getElementById("titlebar")).backdropFilter,
  titlebarPointerEvents: getComputedStyle(document.getElementById("titlebar")).pointerEvents,
  duplicateImportAction: Boolean(document.getElementById("dropzone")),
  duplicateHeaderActions: Boolean(document.getElementById("btnSavePreset") || document.getElementById("btnExport")),
  workspaceFooter: Boolean(document.querySelector(".workspace-footer")),
  panelSaveExport: Boolean(document.getElementById("btnSavePresetPanel") && document.getElementById("btnExportPanel")),
  circularWindowControls: Array.from(document.querySelectorAll(".caption-button")).length === 3
    && Array.from(document.querySelectorAll(".caption-button")).every(button => {
      const rect = button.getBoundingClientRect();
      return Math.abs(rect.width - rect.height) < 1
        && getComputedStyle(button).borderRadius === "50%";
    }),
  canvasCount: document.querySelectorAll("canvas").length,
  browserFileInputs: document.querySelectorAll('input[type="file"]').length,
  appDialog: Boolean(document.getElementById("appDialogLayer")),
  panelCapsules: document.querySelectorAll(".panel-capsule").length,
  status: document.getElementById("importStatus")?.textContent ?? null,
  bootError: document.getElementById("importStatus")?.classList.contains("err") ?? false
})
'@

    $state = $null
    for ($attempt = 0; $attempt -lt 40; $attempt += 1) {
        $runtime = Invoke-Cdp -Socket $socket -Id (101 + $attempt) -Method "Runtime.evaluate" -Params @{
            expression = $expression
            returnByValue = $true
        }
        if ($runtime.result.exceptionDetails) {
            throw ($runtime.result.exceptionDetails.text)
        }
        $state = $runtime.result.result.value | ConvertFrom-Json
        if ($state.hostRuntime -eq "tauri" -and $state.hostCore -eq "rust-dem-core") {
            break
        }
        Start-Sleep -Milliseconds 250
    }
    $state | ConvertTo-Json -Compress

    if ($state.title -ne "DEM Studio" -or
        $state.hostRuntime -ne "tauri" -or
        $state.hostCore -ne "rust-dem-core" -or
        $state.lensDbLoad -ne "function" -or
        $state.lensFsWriteBlob -ne "function" -or
        $state.coreOpenPath -ne "function" -or
        $state.coreOpenTexture -ne "function" -or
        $state.coreSample -ne "function" -or
        $state.coreSampleBinary -ne "function" -or
        $state.coreSampleOverviewBinary -ne "function" -or
        $state.coreRelease -ne "function" -or
        $state.coreStats -ne "function" -or
        $state.coreExport -ne "function" -or
        $state.windowMinimize -ne "function" -or
        $state.titlebarHeight -ne 52 -or
        $state.titlebarBackground -ne "rgba(0, 0, 0, 0)" -or
        $state.titlebarBackdrop -ne "none" -or
        $state.titlebarPointerEvents -ne "auto" -or
        $state.duplicateImportAction -or
        $state.duplicateHeaderActions -or
        $state.workspaceFooter -or
        -not $state.panelSaveExport -or
        -not $state.circularWindowControls -or
        $state.canvasCount -lt 1 -or
        $state.browserFileInputs -ne 0 -or
        -not $state.appDialog -or
        $state.panelCapsules -ne 2 -or
        $state.bootError) {
        throw "Runtime smoke assertions failed."
    }

    $rendererBackendState = $null
    for ($attempt = 0; $attempt -lt 80; $attempt += 1) {
        $backendResult = Invoke-Cdp -Socket $socket -Id (3000 + $attempt) -Method "Runtime.evaluate" -Params @{
            expression = "JSON.stringify(window.__demStudioRenderer?.diagnostics?.() ?? null)"
            returnByValue = $true
        }
        if ($backendResult.result.exceptionDetails) {
            throw ($backendResult.result.exceptionDetails.text)
        }
        if ($backendResult.result.result.value -and
            $backendResult.result.result.value -ne "null") {
            $rendererBackendState = $backendResult.result.result.value | ConvertFrom-Json
            break
        }
        Start-Sleep -Milliseconds 250
    }
    Write-Output "BABYLON_BACKEND=$($rendererBackendState | ConvertTo-Json -Compress)"
    if (-not $rendererBackendState -or
        $rendererBackendState.renderer -ne "babylon" -or
        -not $rendererBackendState.rightHanded -or
        $rendererBackendState.backend -notin @("webgpu", "webgl2")) {
        throw "Babylon renderer did not initialize."
    }
    if ($RendererBackend -eq "webgl2" -and
        ($rendererBackendState.requestedBackend -ne "webgl2" -or
            $rendererBackendState.backend -ne "webgl2")) {
        throw "Forced Babylon WebGL2 backend assertion failed."
    }
    if ($RendererBackend -eq "webgpu") {
        $validWebGpuResult =
            $rendererBackendState.requestedBackend -eq "webgpu" -and (
                $rendererBackendState.backend -eq "webgpu" -or (
                    $rendererBackendState.backend -eq "webgl2" -and
                    -not [string]::IsNullOrWhiteSpace(
                        [string]$rendererBackendState.fallbackReason
                    )
                )
            )
        if (-not $validWebGpuResult) {
            throw "Forced Babylon WebGPU or evidenced WebGL2 fallback assertion failed."
        }
        if ($ForceWebGpuInitFailure -and (
            $rendererBackendState.backend -ne "webgl2" -or
            [string]::IsNullOrWhiteSpace([string]$rendererBackendState.fallbackReason) -or
            -not ([string]$rendererBackendState.fallbackReason).Contains(
                "Harness injected WebGPU initialization failure"
            )
        )) {
            throw "Injected Babylon WebGPU failure did not produce an evidenced WebGL2 fallback."
        }
    }

    if ($SeedRecentOnly) {
        $resolvedSeedOnlyPath = [System.IO.Path]::GetFullPath($SeedRecentOnly)
        if (-not [System.IO.File]::Exists($resolvedSeedOnlyPath)) {
            throw "Recent seed does not exist: $resolvedSeedOnlyPath"
        }
        $seedOnlyPathJson = $resolvedSeedOnlyPath | ConvertTo-Json -Compress
        $seedOnlyNameJson = [System.IO.Path]::GetFileName($resolvedSeedOnlyPath) | ConvertTo-Json -Compress
        Start-Sleep -Milliseconds 1000
        $seedOnlyExpression = @"
(async () => {
await window.lens.db.save("dem-studio", "recentFiles", [{
  id: $seedOnlyPathJson,
  name: $seedOnlyNameJson,
  type: "Image Heightmap",
  size: 0,
  width: 1,
  height: 1,
  range: "0 - 0",
  path: $seedOnlyPathJson,
  companionPaths: [],
  time: new Date().toISOString()
}]);
return JSON.stringify(await window.lens.db.load("dem-studio", "recentFiles"));
})()
"@
        $seedOnlyResult = Invoke-Cdp -Socket $socket -Id 199 -Method "Runtime.evaluate" -Params @{
            expression = $seedOnlyExpression
            awaitPromise = $true
            returnByValue = $true
        }
        if ($seedOnlyResult.result.exceptionDetails) {
            throw ($seedOnlyResult.result.exceptionDetails.text)
        }
        Start-Sleep -Milliseconds 750
        Write-Output "RECENT_SEED_ONLY=$($seedOnlyResult.result.result.value)"
        return
    }

    $resolvedFixture = [System.IO.Path]::GetFullPath($Fixture)
    if ($RecentClick) {
        $recentTargetExpression = @'
(() => {
  const button = document.querySelector("#recentList [data-recent-id]");
  if (!button) return null;
  const rect = button.getBoundingClientRect();
  const x = rect.x + rect.width / 2;
  const y = rect.y + rect.height / 2;
  const hit = document.elementFromPoint(x, y)?.closest?.("[data-recent-id]");
  return JSON.stringify({
    x,
    y,
    id: button.dataset.recentId,
    title: button.querySelector(".recent-title")?.textContent ?? "",
    hit: hit === button
  });
})()
'@

        $recentTargetValue = $null
        if ($RecentSeedPath) {
            $resolvedRecentSeedPath = [System.IO.Path]::GetFullPath($RecentSeedPath)
            if (-not [System.IO.File]::Exists($resolvedRecentSeedPath)) {
                throw "Recent seed does not exist: $resolvedRecentSeedPath"
            }
            $recentPathJson = $resolvedRecentSeedPath | ConvertTo-Json -Compress
            $recentNameJson = [System.IO.Path]::GetFileName($resolvedRecentSeedPath) | ConvertTo-Json -Compress
            $seedExpression = @"
window.lens.db.save("dem-studio", "recentFiles", [{
  id: $recentPathJson,
  name: $recentNameJson,
  type: "Image Heightmap",
  size: 0,
  width: 1,
  height: 1,
  range: "0 - 0",
  path: $recentPathJson,
  companionPaths: [],
  time: new Date().toISOString()
}])
"@
            $seedResult = Invoke-Cdp -Socket $socket -Id 3 -Method "Runtime.evaluate" -Params @{
                expression = $seedExpression
                awaitPromise = $true
                returnByValue = $true
            }
            if ($seedResult.result.exceptionDetails) {
                throw ($seedResult.result.exceptionDetails.text)
            }
            Invoke-Cdp -Socket $socket -Id 4 -Method "Page.reload" | Out-Null

            for ($attempt = 0; $attempt -lt 40; $attempt += 1) {
                Start-Sleep -Milliseconds 250
                $recentTargetResult = Invoke-Cdp -Socket $socket -Id (201 + $attempt) -Method "Runtime.evaluate" -Params @{
                    expression = $recentTargetExpression
                    returnByValue = $true
                }
                $recentTargetValue = $recentTargetResult.result.result.value
                if ($recentTargetValue) { break }
            }
        }
        else {
            $recentTargetResult = Invoke-Cdp -Socket $socket -Id 2 -Method "Runtime.evaluate" -Params @{
                expression = $recentTargetExpression
                returnByValue = $true
            }
            $recentTargetValue = $recentTargetResult.result.result.value
            if (-not $recentTargetValue) {
                $fixturePathJson = $resolvedFixture | ConvertTo-Json -Compress
                $fixtureNameJson = [System.IO.Path]::GetFileName($resolvedFixture) | ConvertTo-Json -Compress
                $seedExpression = @"
window.lens.db.save("dem-studio", "recentFiles", [{
  id: $fixturePathJson,
  name: $fixtureNameJson,
  type: "ASCII Grid",
  size: 0,
  width: 4,
  height: 4,
  range: "0 - 0",
  path: $fixturePathJson,
  companionPaths: [],
  time: new Date().toISOString()
}])
"@
                $seedResult = Invoke-Cdp -Socket $socket -Id 3 -Method "Runtime.evaluate" -Params @{
                    expression = $seedExpression
                    awaitPromise = $true
                    returnByValue = $true
                }
                if ($seedResult.result.exceptionDetails) {
                    throw ($seedResult.result.exceptionDetails.text)
                }
                Invoke-Cdp -Socket $socket -Id 4 -Method "Page.reload" | Out-Null

                for ($attempt = 0; $attempt -lt 40; $attempt += 1) {
                    Start-Sleep -Milliseconds 250
                    $recentTargetResult = Invoke-Cdp -Socket $socket -Id (201 + $attempt) -Method "Runtime.evaluate" -Params @{
                        expression = $recentTargetExpression
                        returnByValue = $true
                    }
                    $recentTargetValue = $recentTargetResult.result.result.value
                    if ($recentTargetValue) { break }
                }
            }
        }
        $recentTarget = if ($recentTargetValue) { $recentTargetValue | ConvertFrom-Json } else { $null }
        if (-not $recentTarget -or -not $recentTarget.hit) {
            throw "Recent item is missing or not physically clickable on cold start."
        }
        Write-Output "RECENT_TARGET=$($recentTarget | ConvertTo-Json -Compress)"

        Invoke-Cdp -Socket $socket -Id 7 -Method "Input.dispatchMouseEvent" -Params @{
            type = "mousePressed"
            x = $recentTarget.x
            y = $recentTarget.y
            button = "left"
            clickCount = 1
        } | Out-Null
        Invoke-Cdp -Socket $socket -Id 8 -Method "Input.dispatchMouseEvent" -Params @{
            type = "mouseReleased"
            x = $recentTarget.x
            y = $recentTarget.y
            button = "left"
            clickCount = 1
        } | Out-Null

        $recentOpened = $false
        for ($attempt = 0; $attempt -lt 40; $attempt += 1) {
            Start-Sleep -Milliseconds 250
            $recentStateResult = Invoke-Cdp -Socket $socket -Id (10 + $attempt) -Method "Runtime.evaluate" -Params @{
                expression = @'
(async () => {
const datasetState = await window.__demStudioHarness.getDatasetState();
return JSON.stringify({
  title: document.getElementById("titlebarDocument")?.textContent ?? "",
  size: document.getElementById("mSize")?.textContent ?? "",
  width: datasetState?.width ?? 0,
  height: datasetState?.height ?? 0,
  sampledLength: datasetState?.sampledLength ?? 0,
  dialogVisible: getComputedStyle(document.getElementById("appDialogLayer")).display !== "none",
  dialogMessage: document.getElementById("appDialogMessage")?.textContent ?? ""
});
})()
'@
                awaitPromise = $true
                returnByValue = $true
            }
            $recentState = $recentStateResult.result.result.value | ConvertFrom-Json
            $recentSizeMatches = -not $RecentExpectedSizePattern -or
                ([string]$recentState.size -match $RecentExpectedSizePattern)
            if ($recentState.title -eq $recentTarget.title -and
                $recentState.sampledLength -gt 0 -and
                $recentSizeMatches) {
                $recentOpened = $true
                Write-Output "RECENT_OPENED=$($recentState | ConvertTo-Json -Compress)"
                break
            }
            if ($recentState.dialogVisible) {
                throw "Recent item click reached an error dialog: $($recentState.dialogMessage)"
            }
        }
        if (-not $recentOpened) {
            $recentDiagnostic = if ($recentState) {
                $recentState | ConvertTo-Json -Compress
            } else {
                "no state"
            }
            throw "Recent item click did not open the selected dataset. Last state: $recentDiagnostic"
        }
    }

    if ($FileBackedProbe -and $ExpectedLodTargetDimension -gt 0) {
        $preOpenResolutionResult = Invoke-Cdp -Socket $socket -Id 3980 -Method "Runtime.evaluate" -Params @{
            expression = "window.__demStudioHarness.seedTerrainResolutionForNextDataset($ExpectedLodTargetDimension)"
            returnByValue = $true
        }
        if ($preOpenResolutionResult.result.exceptionDetails) {
            throw ($preOpenResolutionResult.result.exceptionDetails.text)
        }
        if ([int]$preOpenResolutionResult.result.result.value -ne
            $ExpectedLodTargetDimension) {
            throw "Terrain LOD target could not be seeded before file-backed import."
        }
        Start-Sleep -Milliseconds 350
    }

    $openStartedAt = [DateTime]::UtcNow
    if ($SyntheticDemo) {
        $syntheticState = $null
        for ($attempt = 0; $attempt -lt 120; $attempt += 1) {
            $syntheticResult = Invoke-Cdp -Socket $socket -Id (3900 + $attempt) -Method "Runtime.evaluate" -Params @{
                expression = @'
(async () => {
  const dataset = await window.__demStudioHarness.getDatasetState();
  const renderer = window.__demStudioHarness.getRendererDiagnostics();
  const subMeshes = renderer?.terrainRuntime?.subMeshes || [];
  const ready = dataset?.width === 640
    && dataset?.height === 480
    && renderer?.terrainBuildSettled === true
    && renderer?.terrainVertices > 0
    && subMeshes.length > 0
    && subMeshes.every(mesh =>
      mesh?.ready === true
      && mesh?.effectReady === true
      && !mesh?.compilationError
    );
  return JSON.stringify({ dataset, renderer, ready });
})()
'@
                awaitPromise = $true
                returnByValue = $true
            }
            if ($syntheticResult.result.exceptionDetails) {
                throw ($syntheticResult.result.exceptionDetails.text)
            }
            $syntheticState = $syntheticResult.result.result.value | ConvertFrom-Json
            if ([bool]$syntheticState.ready) {
                break
            }
            Start-Sleep -Milliseconds 250
        }
        if (-not $syntheticState -or -not [bool]$syntheticState.ready) {
            $syntheticFailure = if ($syntheticState) {
                $syntheticState | ConvertTo-Json -Depth 8 -Compress
            } else {
                "null"
            }
            throw "Synthetic DEM did not reach a compiled, transactionally committed terrain state: $syntheticFailure"
        }
        Write-Output "SYNTHETIC_DEMO=$($syntheticState | ConvertTo-Json -Depth 8 -Compress)"
    }
    elseif ($NativeImportDialog) {
        $buttonResult = Invoke-Cdp -Socket $socket -Id 4 -Method "Runtime.evaluate" -Params @{
            expression = @'
(() => {
  const rect = document.getElementById("btnImport")?.getBoundingClientRect();
  return rect ? JSON.stringify({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }) : null;
})()
'@
            returnByValue = $true
        }
        $buttonPoint = $buttonResult.result.result.value | ConvertFrom-Json
        if (-not $buttonPoint) {
            throw "Import button was not found."
        }
        Invoke-Cdp -Socket $socket -Id 5 -Method "Input.dispatchMouseEvent" -Params @{
            type = "mousePressed"
            x = $buttonPoint.x
            y = $buttonPoint.y
            button = "left"
            clickCount = 1
        } | Out-Null
        Invoke-Cdp -Socket $socket -Id 6 -Method "Input.dispatchMouseEvent" -Params @{
            type = "mouseReleased"
            x = $buttonPoint.x
            y = $buttonPoint.y
            button = "left"
            clickCount = 1
        } | Out-Null

        $popup = [IntPtr]::Zero
        for ($attempt = 0; $attempt -lt 40; $attempt += 1) {
            Start-Sleep -Milliseconds 250
            $process.Refresh()
            $candidate = [DemStudioNativeImport]::GetLastActivePopup($process.MainWindowHandle)
            if ($candidate -ne [IntPtr]::Zero -and
                $candidate -ne $process.MainWindowHandle -and
                [DemStudioNativeImport]::IsWindowVisible($candidate)) {
                $popup = $candidate
                break
            }
        }
        if ($popup -eq [IntPtr]::Zero) {
            throw "Native DEM import dialog did not open from the visible button."
        }
        $dialogRoot = [System.Windows.Automation.AutomationElement]::FromHandle($popup)
        $allDialogElements = $dialogRoot.FindAll(
            [System.Windows.Automation.TreeScope]::Descendants,
            [System.Windows.Automation.Condition]::TrueCondition
        )
        $fileNameElement = $allDialogElements | Where-Object {
            $_.Current.AutomationId -eq "1148" -and $_.Current.ClassName -eq "Edit"
        } | Select-Object -First 1
        $openElement = $allDialogElements | Where-Object {
            $_.Current.AutomationId -eq "1" -and $_.Current.ClassName -eq "Button"
        } | Select-Object -First 1
        if (-not $fileNameElement -or -not $openElement) {
            throw "Native DEM import dialog controls could not be resolved."
        }
        [DemStudioNativeImport]::SetControlText(
            [IntPtr]$fileNameElement.Current.NativeWindowHandle,
            $resolvedFixture
        )
        [DemStudioNativeImport]::ClickButton(
            [IntPtr]$openElement.Current.NativeWindowHandle
        )
    }
    else {
        $fixtureJson = $resolvedFixture | ConvertTo-Json -Compress
        $openResult = Invoke-Cdp -Socket $socket -Id 4 -Method "Runtime.evaluate" -Params @{
            expression = "(async () => { await window.__demStudioOpenPath($fixtureJson); return true; })()"
            awaitPromise = $true
            returnByValue = $true
        }
        if ($openResult.result.exceptionDetails) {
            $openResult.result.exceptionDetails | ConvertTo-Json -Depth 12
            throw ($openResult.result.exceptionDetails.text)
        }
    }
    $openCompletedAt = [DateTime]::UtcNow
    $performanceStages.openMs = [Math]::Round(
        ($openCompletedAt - $openStartedAt).TotalMilliseconds,
        2
    )
    if (-not $SyntheticDemo) {
    $importState = $null
    $escapedExpectedName = [Regex]::Escape($ExpectedName)
    $statusPattern = if ($ExpectBrowserImage) {
        $escapedExpectedName
    }
    else {
        "^Rust Core .*$escapedExpectedName"
    }
    for ($attempt = 0; $attempt -lt 40; $attempt += 1) {
        Start-Sleep -Milliseconds 250
        $importResult = Invoke-Cdp -Socket $socket -Id (10 + $attempt) -Method "Runtime.evaluate" -Params @{
            expression = @'
JSON.stringify({
  status: document.getElementById("importStatus")?.textContent ?? null,
  name: document.getElementById("mName")?.textContent ?? null,
  type: document.getElementById("mType")?.textContent ?? null,
  size: document.getElementById("mSize")?.textContent ?? null,
  terrainReady: document.getElementById("emptyState")?.classList.contains("hidden") ?? false
})
'@
            returnByValue = $true
        }
        $importState = $importResult.result.result.value | ConvertFrom-Json
        if ($importState.status -match $statusPattern) {
            break
        }
    }

    $importState | ConvertTo-Json -Compress
    $importChecks = [ordered]@{
        status = $importState.status -match $statusPattern
        name = $importState.name -eq $ExpectedName
        type = $importState.type -eq $ExpectedType
        size = $importState.size -match $ExpectedSizePattern
        terrainReady = [bool]$importState.terrainReady
    }
    $importChecks | ConvertTo-Json -Compress
    $importPassed =
        $importChecks.status -and
        $importChecks.name -and
        $importChecks.type -and
        $importChecks.size -and
        $importChecks.terrainReady
    if (-not $importPassed) {
        throw "ASC import smoke assertions failed."
    }
    $overviewReadyAt = [DateTime]::UtcNow
    $performanceStages.overviewMs = [Math]::Round(
        ($overviewReadyAt - $openStartedAt).TotalMilliseconds,
        2
    )
    }
    else {
        $performanceStages.overviewMs = $performanceStages.openMs
    }

    $firstFrameResult = Invoke-Cdp -Socket $socket -Id 480 -Method "Runtime.evaluate" -Params @{
        expression = @'
new Promise(resolve => {
  requestAnimationFrame(() => requestAnimationFrame(() => resolve(JSON.stringify({
    performanceNow: performance.now(),
    visibilityState: document.visibilityState,
    canvasCount: document.querySelectorAll("canvas").length
  }))));
})
'@
        awaitPromise = $true
        returnByValue = $true
    }
    if ($firstFrameResult.result.exceptionDetails) {
        throw ($firstFrameResult.result.exceptionDetails.text)
    }
    $firstFrameState = $firstFrameResult.result.result.value | ConvertFrom-Json
    $firstFrameReadyAt = [DateTime]::UtcNow
    $performanceStages.firstFrameMs = [Math]::Round(
        ($firstFrameReadyAt - $openStartedAt).TotalMilliseconds,
        2
    )
    Write-Output "FIRST_FRAME_STATE=$($firstFrameState | ConvertTo-Json -Compress)"
    $rendererStateResult = Invoke-Cdp -Socket $socket -Id 481 -Method "Runtime.evaluate" -Params @{
        expression = "JSON.stringify(window.__demStudioHarness.getRendererDiagnostics())"
        returnByValue = $true
    }
    if ($rendererStateResult.result.exceptionDetails) {
        $rendererStateResult.result.exceptionDetails | ConvertTo-Json -Depth 12
        throw ($rendererStateResult.result.exceptionDetails.text)
    }
    $rendererState = $rendererStateResult.result.result.value | ConvertFrom-Json
    Write-Output "RENDERER_STATE=$($rendererState | ConvertTo-Json -Depth 8 -Compress)"
    if (
        @($rendererState.runtimeErrors).Count -ne 0 -or
        [int]$rendererState.terrainVertices -le 0 -or
        [int]$rendererState.terrainTriangles -le 0 -or
        -not $rendererState.terrainRuntime.enabled -or
        -not $rendererState.terrainRuntime.visible -or
        [int]$rendererState.terrainRuntime.totalVertices -le 0 -or
        [int]$rendererState.terrainRuntime.totalIndices -le 0 -or
        @($rendererState.terrainRuntime.subMeshes).Count -le 0 -or
        [int]$rendererState.rendererInfo.calls -le 0 -or
        [int]$rendererState.rendererInfo.triangles -le 0
    ) {
        throw "Babylon terrain exists in application state but is not active in the rendered scene."
    }
    foreach ($subMeshState in @($rendererState.terrainRuntime.subMeshes)) {
        if (-not $subMeshState.ready -or -not $subMeshState.effectReady) {
            throw "Babylon terrain material is not ready: $($subMeshState.className)."
        }
    }
    Measure-DemStudioMemory -Stage "first-frame"

    if ($FileBackedProbe) {
        $expectedOverviewLength = $ExpectedOverviewCols * $ExpectedOverviewRows
        $overviewState = $null
        for ($attempt = 0; $attempt -lt 40; $attempt += 1) {
            $overviewResult = Invoke-Cdp -Socket $socket -Id (510 + $attempt) -Method "Runtime.evaluate" -Params @{
                expression = "(async () => JSON.stringify(await window.__demStudioHarness.getDatasetState()))()"
                awaitPromise = $true
                returnByValue = $true
            }
            if ($overviewResult.result.exceptionDetails) {
                throw ($overviewResult.result.exceptionDetails.text)
            }
            $overviewState = $overviewResult.result.result.value | ConvertFrom-Json
            if ($overviewState.sampledCols -eq $ExpectedOverviewCols -and
                $overviewState.sampledRows -eq $ExpectedOverviewRows -and
                $overviewState.sampledLength -eq $expectedOverviewLength -and
                -not $overviewState.previewRefined -and
                -not $overviewState.focusLodActive) {
                break
            }
            Start-Sleep -Milliseconds 250
        }
        Write-Output "FILE_BACKED_OVERVIEW=$($overviewState | ConvertTo-Json -Depth 5 -Compress)"
        Write-Output "STREAMING_PREREQUISITES=$($overviewState.streamingLod.prerequisites | ConvertTo-Json -Compress)"
        if (
            -not $overviewState.streamingLod.prerequisites.fileBackedLod -or
            [string]::IsNullOrWhiteSpace(
                [string]$overviewState.streamingLod.prerequisites.coreId
            ) -or
            -not $overviewState.streamingLod.prerequisites.terrainTileLodGroup -or
            -not $overviewState.streamingLod.prerequisites.terrainStyleSupported
        ) {
            throw "File-backed streaming prerequisites are not satisfied."
        }
        if ($overviewState.engine -ne "rust-dem-core-v2" -or
            $overviewState.rawLength -ne 0 -or
            $overviewState.previewRefined -or
            $overviewState.sampledCols -ne $ExpectedOverviewCols -or
            $overviewState.sampledRows -ne $ExpectedOverviewRows -or
            $overviewState.sampledLength -ne $expectedOverviewLength -or
            $overviewState.focusLodActive -or
            $overviewState.coreStats.datasetCount -ne 1 -or
            $overviewState.coreStats.fileBackedCount -ne 1) {
            throw "File-backed DEM overview runtime assertion failed."
        }
        if (($ExpectedOverviewValidCount -gt 0 -and
                $overviewState.sampledValidCount -ne $ExpectedOverviewValidCount) -or
            ($ExpectedOverviewMaskHash -gt 0 -and
                [uint32]$overviewState.sampledMaskHash -ne $ExpectedOverviewMaskHash)) {
            throw "File-backed DEM overview mask assertion failed."
        }
        if ((-not [double]::IsNaN($ExpectedMinimum) -and
                [Math]::Abs([double]$overviewState.minimum - $ExpectedMinimum) -gt 0.000001) -or
            (-not [double]::IsNaN($ExpectedMaximum) -and
                [Math]::Abs([double]$overviewState.maximum - $ExpectedMaximum) -gt 0.000001)) {
            throw "File-backed DEM statistics runtime assertion failed."
        }

        if ($ExpectedLodTargetDimension -gt 0) {
            $setResolutionResult = Invoke-Cdp -Socket $socket -Id 558 -Method "Runtime.evaluate" -Params @{
                expression = "window.__demStudioHarness.setTerrainResolution($ExpectedLodTargetDimension)"
                returnByValue = $true
            }
            if ($setResolutionResult.result.exceptionDetails) {
                throw ($setResolutionResult.result.exceptionDetails.text)
            }
            if ([int]$setResolutionResult.result.result.value -ne $ExpectedLodTargetDimension) {
                throw "Terrain LOD target could not be selected."
            }
        }

        $focusLodStartedAt = [DateTime]::UtcNow
        $focusTriggerResult = Invoke-Cdp -Socket $socket -Id 560 -Method "Runtime.evaluate" -Params @{
            expression = "(async () => JSON.stringify({ triggered: await window.__demStudioHarness.refineCurrentView() }))()"
            awaitPromise = $true
            returnByValue = $true
        }
        if ($focusTriggerResult.result.exceptionDetails) {
            throw ($focusTriggerResult.result.exceptionDetails.text)
        }
        Write-Output "FOCUS_LOD_TRIGGER=$($focusTriggerResult.result.result.value)"

        $focusState = $null
        for ($attempt = 0; $attempt -lt 120; $attempt += 1) {
            $focusResult = Invoke-Cdp -Socket $socket -Id (570 + $attempt) -Method "Runtime.evaluate" -Params @{
                expression = "(async () => JSON.stringify(await window.__demStudioHarness.getDatasetState()))()"
                awaitPromise = $true
                returnByValue = $true
            }
            if ($focusResult.result.exceptionDetails) {
                throw ($focusResult.result.exceptionDetails.text)
            }
            $focusState = $focusResult.result.result.value | ConvertFrom-Json
            if (($attempt % 8) -eq 0) {
                Measure-DemStudioMemory -Stage "lod-$attempt"
            }
            $rootCoverageReady = $focusState.streamingLod.rootCoverageExact -and
                $focusState.streamingLod.rootBaseRequired -and
                $focusState.streamingLod.rootBasePreserved
            $streamingReady = $focusState.streamingLod.enabled -and
                -not $focusState.focusLodActive -and
                $focusState.streamingLod.baseComplete -and
                $focusState.streamingLod.readyBaseTileCount -eq
                    $focusState.streamingLod.requiredBaseTileCount -and
                $focusState.streamingLod.requested -gt 0 -and
                $focusState.streamingLod.completed -gt 0 -and
                $focusState.streamingLod.uploaded -gt 0 -and
                $focusState.streamingLod.activeMeshCount -gt 0 -and
                $focusState.streamingLod.coverageComplete -and
                -not $focusState.streamingLod.rootTopVisible -and
                $focusState.streamingLod.rootTopIndexCount -eq 0 -and
                $focusState.streamingLod.expectedBaseIndexCount -gt 0 -and
                $rootCoverageReady -and
                $focusState.streamingLod.rootIndexExact -and
                $focusState.streamingLod.rootIndexCount -eq $focusState.streamingLod.rootGroupIndexCount -and
                $focusState.streamingLod.readyDesiredHorizonVertexCount -eq $focusState.streamingLod.readyDesiredVertexCount -and
                $focusState.streamingLod.readyDesiredHorizonSourceCount -eq $focusState.streamingLod.readyDesiredCount -and
                $focusState.streamingLod.pendingRequestCount -eq 0 -and
                $focusState.streamingLod.queuedRequestCount -eq 0 -and
                $focusState.streamingLod.queuedUploadCount -eq 0
            if ($streamingReady -and $ExpectedLodTargetDimension -gt 0) {
                $streamingReady =
                    $focusState.streamingLod.targetMaxDimension -eq $ExpectedLodTargetDimension -and
                    $focusState.streamingLod.maximumReadyLevel -eq $focusState.streamingLod.targetMaxLevel -and
                    $focusState.streamingLod.achievedMaxDimension -ge $ExpectedLodTargetDimension -and
                    $focusState.streamingLod.readyDesiredVertexCount -gt $focusState.sampledLength
                if ($streamingReady -and $ExpectedLodTargetDimension -le 1024) {
                    $expectedBaseTileCount = [int][Math]::Pow(
                        4,
                        [int]$focusState.streamingLod.targetMaxLevel
                    )
                    $streamingReady =
                        $focusState.streamingLod.minimumReadyLevel -eq $focusState.streamingLod.targetMaxLevel -and
                        $focusState.streamingLod.requiredBaseTileCount -eq $expectedBaseTileCount -and
                        $focusState.streamingLod.readyBaseTileCount -eq $expectedBaseTileCount -and
                        [int]$focusState.streamingLod.levelHistogram."$($focusState.streamingLod.targetMaxLevel)" -eq
                            $focusState.streamingLod.readyDesiredCount
                }
            }
            $legacyFocusReady = $focusState.focusLodActive -and
                $focusState.windowCacheSize -ge 1 -and
                $focusState.focusTopology.rootIndexExact -and
                $focusState.focusTopology.indexCount -eq $focusState.focusTopology.expectedIndexCount
            $lodReady = if ($focusState.streamingLod.enabled) {
                $streamingReady
            } else {
                $legacyFocusReady
            }
            if ($lodReady -and
                $focusState.skyLighting.applied) {
                break
            }
            Start-Sleep -Milliseconds 250
        }
        Write-Output "FILE_BACKED_FOCUS_LOD=$($focusState | ConvertTo-Json -Depth 5 -Compress)"
        $rootCoveragePassed = $focusState.streamingLod.rootCoverageExact -and
            $focusState.streamingLod.rootBaseRequired -and
            $focusState.streamingLod.rootBasePreserved
        $streamingFocusPassed = $focusState.streamingLod.enabled -and
            -not $focusState.focusLodActive -and
            $focusState.streamingLod.baseComplete -and
            $focusState.streamingLod.readyBaseTileCount -eq
                $focusState.streamingLod.requiredBaseTileCount -and
            $focusState.streamingLod.requested -gt 0 -and
            $focusState.streamingLod.completed -gt 0 -and
            $focusState.streamingLod.uploaded -gt 0 -and
            $focusState.streamingLod.activeMeshCount -gt 0 -and
            $focusState.streamingLod.coverageComplete -and
            -not $focusState.streamingLod.rootTopVisible -and
            $focusState.streamingLod.rootTopIndexCount -eq 0 -and
            $focusState.streamingLod.expectedBaseIndexCount -gt 0 -and
            $rootCoveragePassed -and
            $focusState.streamingLod.rootIndexExact -and
            $focusState.streamingLod.rootIndexCount -eq $focusState.streamingLod.rootGroupIndexCount -and
            $focusState.streamingLod.readyDesiredHorizonVertexCount -eq $focusState.streamingLod.readyDesiredVertexCount -and
            $focusState.streamingLod.readyDesiredHorizonSourceCount -eq $focusState.streamingLod.readyDesiredCount -and
            $focusState.streamingLod.pendingRequestCount -eq 0 -and
            $focusState.streamingLod.queuedRequestCount -eq 0 -and
            $focusState.streamingLod.queuedUploadCount -eq 0 -and
            @($focusState.streamingLod.edgeMorphWidths).Count -eq 1 -and
            [double]($focusState.streamingLod.edgeMorphWidths[0]) -eq 0 -and
            $focusState.streamingLod.cacheBytes -le $focusState.streamingLod.cacheBudgetBytes -and
            $focusState.streamingLod.gpuBytes -le $focusState.streamingLod.gpuBudgetBytes
        if ($streamingFocusPassed -and $ExpectedLodTargetDimension -gt 0) {
            $streamingFocusPassed =
                $focusState.streamingLod.targetMaxDimension -eq $ExpectedLodTargetDimension -and
                $focusState.streamingLod.maximumReadyLevel -eq $focusState.streamingLod.targetMaxLevel -and
                $focusState.streamingLod.achievedMaxDimension -ge $ExpectedLodTargetDimension -and
                $focusState.streamingLod.readyDesiredVertexCount -gt $focusState.sampledLength
            if ($streamingFocusPassed -and $ExpectedLodTargetDimension -le 1024) {
                $expectedBaseTileCount = [int][Math]::Pow(
                    4,
                    [int]$focusState.streamingLod.targetMaxLevel
                )
                $streamingFocusPassed =
                    $focusState.streamingLod.minimumReadyLevel -eq $focusState.streamingLod.targetMaxLevel -and
                    $focusState.streamingLod.requiredBaseTileCount -eq $expectedBaseTileCount -and
                    $focusState.streamingLod.readyBaseTileCount -eq $expectedBaseTileCount -and
                    [int]$focusState.streamingLod.levelHistogram."$($focusState.streamingLod.targetMaxLevel)" -eq
                        $focusState.streamingLod.readyDesiredCount
            }
        }
        if ($streamingFocusPassed -and $ExpectedMinimumReadyVertices -gt 0) {
            $streamingFocusPassed =
                $focusState.streamingLod.readyDesiredVertexCount -ge $ExpectedMinimumReadyVertices
        }
        if ($streamingFocusPassed -and $ExpectedReadyTriangles -gt 0) {
            $streamingFocusPassed =
                $focusState.streamingLod.readyDesiredTriangleCount -ge $ExpectedReadyTriangles
        }
        if ($streamingFocusPassed -and $ExpectedMinimumTargetLevelTiles -gt 0) {
            if ($ExpectedLodTargetDimension -gt 1024) {
                $streamingFocusPassed =
                    [int]$focusState.streamingLod.desiredRefinementLevelHistogram."$($focusState.streamingLod.targetMaxLevel)" -ge
                        $ExpectedMinimumTargetLevelTiles -and
                    $focusState.streamingLod.residentRefinementTileCount -ge
                        $focusState.streamingLod.desiredRefinementTileCount
            }
            else {
                $streamingFocusPassed =
                    [int]$focusState.streamingLod.levelHistogram."$($focusState.streamingLod.targetMaxLevel)" -ge
                        $ExpectedMinimumTargetLevelTiles
            }
        }
        if ($streamingFocusPassed) {
            $expectedHudVertexText =
                [string]::Format('{0:N0}', [long]$focusState.streamingLod.activeVertexCount)
            $expectedHudTriangleText =
                [string]::Format('{0:N0}', [long]$focusState.streamingLod.activeTriangleCount)
            $streamingFocusPassed =
                ([string]$focusState.hudTopologyText).Contains($expectedHudVertexText) -and
                ([string]$focusState.hudTopologyText).Contains($expectedHudTriangleText)
        }
        $legacyFocusPassed = $focusState.focusLodActive -and
            $focusState.windowCacheSize -ge 1 -and
            $focusState.focusTopology.rootIndexExact -and
            $focusState.focusTopology.indexCount -eq $focusState.focusTopology.expectedIndexCount
        $focusLodPassed = if ($focusState.streamingLod.enabled) {
            $streamingFocusPassed
        } else {
            $legacyFocusPassed
        }
        Write-Output "FOCUS_LOD_ORACLE=$(@{
            focusLodPassed = $focusLodPassed
            streamingFocusPassed = $streamingFocusPassed
            rootCoveragePassed = $rootCoveragePassed
            expectedHudVertexText = $expectedHudVertexText
            expectedHudTriangleText = $expectedHudTriangleText
            actualHudTopology = $focusState.hudTopologyText
            skyLightingApplied = $focusState.skyLighting.applied
            previewRefined = $focusState.previewRefined
            rawLength = $focusState.rawLength
            datasetCount = $focusState.coreStats.datasetCount
            fileBackedCount = $focusState.coreStats.fileBackedCount
            cacheCapacity = $focusState.coreStats.chunkCacheCapacityBytes
            cacheResident = $focusState.coreStats.chunkCacheResidentBytes
        } | ConvertTo-Json -Compress)"
        if (-not $focusLodPassed -or
            -not $focusState.skyLighting.applied -or
            $focusState.previewRefined -or
            $focusState.rawLength -ne 0 -or
            $focusState.coreStats.datasetCount -ne 1 -or
            $focusState.coreStats.fileBackedCount -ne 1 -or
            $focusState.coreStats.chunkCacheCapacityBytes -ne 67108864 -or
            $focusState.coreStats.chunkCacheResidentBytes -gt
                $focusState.coreStats.chunkCacheCapacityBytes) {
            throw "File-backed DEM focus LOD runtime assertion failed."
        }
        if ($TerrainStabilitySeconds -gt 0) {
            if (-not $focusState.streamingLod.enabled -or
                -not $focusState.streamingLod.baseComplete) {
                throw "Terrain stability probe requires a completed persistent base."
            }
            $stabilityBefore = $focusState
            $surfaceResult = Invoke-Cdp -Socket $socket -Id 12000 -Method "Runtime.evaluate" -Params @{
                expression = @'
(() => {
  const canvas = document.querySelector("canvas.babylon-render-surface");
  if (!canvas) return JSON.stringify(null);
  const rect = canvas.getBoundingClientRect();
  return JSON.stringify({
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height
  });
})()
'@
                returnByValue = $true
            }
            if ($surfaceResult.result.exceptionDetails) {
                throw ($surfaceResult.result.exceptionDetails.text)
            }
            $surface = $surfaceResult.result.result.value | ConvertFrom-Json
            if (-not $surface -or $surface.width -lt 64 -or $surface.height -lt 64) {
                throw "Babylon render surface is unavailable for the terrain stability probe."
            }

            $centerX = [double]$surface.left + ([double]$surface.width / 2)
            $centerY = [double]$surface.top + ([double]$surface.height / 2)
            $stabilityStartedAt = [DateTime]::UtcNow
            $stabilityIteration = 0
            $lastObservedStabilityState = $null
            while (([DateTime]::UtcNow - $stabilityStartedAt).TotalSeconds -lt
                $TerrainStabilitySeconds) {
                $stabilityIteration += 1
                $direction = if (($stabilityIteration % 2) -eq 0) { -1 } else { 1 }
                $eventId = 12100 + ($stabilityIteration * 10)
                $null = Invoke-Cdp -Socket $socket -Id $eventId -Method "Input.dispatchMouseEvent" -Params @{
                    type = "mousePressed"
                    x = $centerX
                    y = $centerY
                    button = "left"
                    buttons = 1
                    clickCount = 1
                }
                $null = Invoke-Cdp -Socket $socket -Id ($eventId + 1) -Method "Input.dispatchMouseEvent" -Params @{
                    type = "mouseMoved"
                    x = $centerX + ($direction * 42)
                    y = $centerY + ($direction * 18)
                    button = "left"
                    buttons = 1
                }
                $null = Invoke-Cdp -Socket $socket -Id ($eventId + 2) -Method "Input.dispatchMouseEvent" -Params @{
                    type = "mouseReleased"
                    x = $centerX + ($direction * 42)
                    y = $centerY + ($direction * 18)
                    button = "left"
                    buttons = 0
                    clickCount = 1
                }
                if (($stabilityIteration % 3) -eq 0) {
                    $null = Invoke-Cdp -Socket $socket -Id ($eventId + 3) -Method "Input.dispatchMouseEvent" -Params @{
                        type = "mousePressed"
                        x = $centerX
                        y = $centerY
                        button = "right"
                        buttons = 2
                        clickCount = 1
                    }
                    $null = Invoke-Cdp -Socket $socket -Id ($eventId + 4) -Method "Input.dispatchMouseEvent" -Params @{
                        type = "mouseMoved"
                        x = $centerX + ($direction * 16)
                        y = $centerY - ($direction * 12)
                        button = "right"
                        buttons = 2
                    }
                    $null = Invoke-Cdp -Socket $socket -Id ($eventId + 5) -Method "Input.dispatchMouseEvent" -Params @{
                        type = "mouseReleased"
                        x = $centerX + ($direction * 16)
                        y = $centerY - ($direction * 12)
                        button = "right"
                        buttons = 0
                        clickCount = 1
                    }
                }
                $null = Invoke-Cdp -Socket $socket -Id ($eventId + 6) -Method "Input.dispatchMouseEvent" -Params @{
                    type = "mouseWheel"
                    x = $centerX
                    y = $centerY
                    deltaX = 0
                    deltaY = $direction * 120
                }

                if (($stabilityIteration % 2) -eq 0) {
                    $observedResult = Invoke-Cdp -Socket $socket -Id ($eventId + 7) -Method "Runtime.evaluate" -Params @{
                        expression = @'
(async () => JSON.stringify({
  dataset: await window.__demStudioHarness.getDatasetState(),
  renderer: window.__demStudioRenderer.diagnostics()
}))()
'@
                        awaitPromise = $true
                        returnByValue = $true
                    }
                    if ($observedResult.result.exceptionDetails) {
                        throw ($observedResult.result.exceptionDetails.text)
                    }
                    $lastObservedStabilityState =
                        $observedResult.result.result.value | ConvertFrom-Json
                    if ($lastObservedStabilityState.dataset.streamingLod.activeMeshCount -le 0 -or
                        -not $lastObservedStabilityState.dataset.streamingLod.baseComplete -or
                        $lastObservedStabilityState.dataset.streamingLod.readyBaseTileCount -ne
                            $lastObservedStabilityState.dataset.streamingLod.requiredBaseTileCount) {
                        throw "Terrain model became incomplete or blank during real camera input."
                    }
                    if ($lastObservedStabilityState.renderer.contextLossCount -ne 0) {
                        throw "Babylon context loss observed during real camera input."
                    }
                }
                if (($stabilityIteration % 10) -eq 0) {
                    Measure-DemStudioMemory -Stage "terrain-stability-$stabilityIteration"
                }
                Start-Sleep -Milliseconds 250
            }

            $stabilityAfterEnvelope = $null
            for ($stabilityAttempt = 0; $stabilityAttempt -lt 120; $stabilityAttempt += 1) {
                $afterResult = Invoke-Cdp -Socket $socket -Id (15000 + $stabilityAttempt) -Method "Runtime.evaluate" -Params @{
                    expression = @'
(async () => JSON.stringify({
  dataset: await window.__demStudioHarness.getDatasetState(),
  renderer: window.__demStudioRenderer.diagnostics()
}))()
'@
                    awaitPromise = $true
                    returnByValue = $true
                }
                if ($afterResult.result.exceptionDetails) {
                    throw ($afterResult.result.exceptionDetails.text)
                }
                $stabilityAfterEnvelope =
                    $afterResult.result.result.value | ConvertFrom-Json
                if ($stabilityAfterEnvelope.dataset.streamingLod.pendingBaseRequestCount -eq 0 -and
                    $stabilityAfterEnvelope.dataset.streamingLod.inflightBaseTileCount -eq 0) {
                    break
                }
                Start-Sleep -Milliseconds 250
            }
            $stabilityAfter = $stabilityAfterEnvelope.dataset
            $beforeBaseObjectIds = ConvertTo-Json `
                -InputObject @($stabilityBefore.streamingLod.baseObjectIds) -Compress
            $afterBaseObjectIds = ConvertTo-Json `
                -InputObject @($stabilityAfter.streamingLod.baseObjectIds) -Compress
            $stableBase =
                $stabilityAfter.streamingLod.terrainBuildGeneration -eq
                    $stabilityBefore.streamingLod.terrainBuildGeneration -and
                $stabilityAfter.streamingLod.baseSamples -eq
                    $stabilityBefore.streamingLod.baseSamples -and
                $stabilityAfter.streamingLod.baseBuilds -eq
                    $stabilityBefore.streamingLod.baseBuilds -and
                $stabilityAfter.streamingLod.baseUploads -eq
                    $stabilityBefore.streamingLod.baseUploads -and
                $stabilityAfter.streamingLod.baseDisposals -eq
                    $stabilityBefore.streamingLod.baseDisposals -and
                $stabilityAfter.streamingLod.readyBaseTileCount -eq
                    $stabilityBefore.streamingLod.readyBaseTileCount -and
                $beforeBaseObjectIds -eq $afterBaseObjectIds -and
                $stabilityAfter.streamingLod.baseVertexCount -eq
                    $stabilityBefore.streamingLod.baseVertexCount -and
                $stabilityAfter.streamingLod.baseTriangleCount -eq
                    $stabilityBefore.streamingLod.baseTriangleCount -and
                $stabilityAfter.streamingLod.pendingBaseRequestCount -eq 0 -and
                $stabilityAfter.streamingLod.activeMeshCount -gt 0 -and
                $stabilityAfterEnvelope.renderer.contextLossCount -eq 0
            $terrainStabilityState = [ordered]@{
                passed = $stableBase
                requestedSeconds = $TerrainStabilitySeconds
                iterations = $stabilityIteration
                terrainBuildGenerationBefore =
                    $stabilityBefore.streamingLod.terrainBuildGeneration
                terrainBuildGenerationAfter =
                    $stabilityAfter.streamingLod.terrainBuildGeneration
                baseSamplesDelta =
                    $stabilityAfter.streamingLod.baseSamples -
                    $stabilityBefore.streamingLod.baseSamples
                baseBuildsDelta =
                    $stabilityAfter.streamingLod.baseBuilds -
                    $stabilityBefore.streamingLod.baseBuilds
                baseUploadsDelta =
                    $stabilityAfter.streamingLod.baseUploads -
                    $stabilityBefore.streamingLod.baseUploads
                baseDisposalsDelta =
                    $stabilityAfter.streamingLod.baseDisposals -
                    $stabilityBefore.streamingLod.baseDisposals
                baseObjectIdsStable = $beforeBaseObjectIds -eq $afterBaseObjectIds
                baseVertexCount = $stabilityAfter.streamingLod.baseVertexCount
                baseTriangleCount = $stabilityAfter.streamingLod.baseTriangleCount
                contextLossCount = $stabilityAfterEnvelope.renderer.contextLossCount
            }
            Write-Output "TERRAIN_BASE_STABILITY=$($terrainStabilityState | ConvertTo-Json -Compress)"
            if (-not $stableBase) {
                throw "Persistent terrain base changed during real rotate/pan/wheel input."
            }
            Measure-DemStudioMemory -Stage "terrain-stability-complete"
        }
        if ($RefinementCacheProbe) {
            $refinementProbeOffset = if ($ExpectedLodTargetDimension -ge 4096) {
                0.08
            }
            else {
                0.22
            }
            $refinementProbeResult = Invoke-Cdp -Socket $socket -Id 556 -Method "Runtime.evaluate" -Params @{
                expression = "(async () => JSON.stringify(await window.__demStudioHarness.probeRefinementCacheReturn($refinementProbeOffset)))()"
                awaitPromise = $true
                returnByValue = $true
            }
            if ($refinementProbeResult.result.exceptionDetails) {
                throw ($refinementProbeResult.result.exceptionDetails.text)
            }
            $refinementCacheProbeState = (
                [string]$refinementProbeResult.result.result.value
            ) | ConvertFrom-Json
            Write-Output "REFINEMENT_CACHE_RETURN=$($refinementCacheProbeState | ConvertTo-Json -Depth 100 -Compress)"
            if (
                (-not $refinementCacheProbeState.supported) -or
                (-not $refinementCacheProbeState.passed)
            ) {
                throw "Babylon refinement cache return probe failed."
            }
            Measure-DemStudioMemory -Stage "refinement-cache-return"
        }
        if ($FocusScreenshot) {
            $resolvedFocusScreenshot = Resolve-OutputPath -Path $FocusScreenshot
            $focusCapture = Invoke-Cdp -Socket $socket -Id 555 -Method "Page.captureScreenshot" -Params @{
                format = "png"
                captureBeyondViewport = $false
            }
            [System.IO.File]::WriteAllBytes(
                $resolvedFocusScreenshot,
                [Convert]::FromBase64String($focusCapture.result.data)
            )
            Write-Output "FOCUS_SCREENSHOT=$resolvedFocusScreenshot"
        }

        $refineReadyAt = [DateTime]::UtcNow
        $performanceStages.refineMs = [Math]::Round(
            ($refineReadyAt - $openStartedAt).TotalMilliseconds,
            2
        )
        $performanceStages.focusLodMs = [Math]::Round(
            ($refineReadyAt - $focusLodStartedAt).TotalMilliseconds,
            2
        )
        Measure-DemStudioMemory -Stage "refine-complete"
    }

    if ($PerformanceProbe) {
        $remainingMilliseconds = $FrameSampleMilliseconds
        $chunkIndex = 0
        $sampleDurationMilliseconds = 0.0
        $allFrameIntervals = [System.Collections.Generic.List[double]]::new()
        $interactionLongTaskCount = 0
        $interactionLongTaskMaxMilliseconds = 0.0
        $interactionViewportChangeCount = 0
        $lastChunkState = $null
        while ($remainingMilliseconds -gt 0) {
            $chunkIndex += 1
            $chunkMilliseconds = [Math]::Min(15000, $remainingMilliseconds)
            $chunkMillisecondsJson = $chunkMilliseconds | ConvertTo-Json -Compress
            $keepInteractionActiveJson = (
                $remainingMilliseconds - $chunkMilliseconds -gt 0
            ) | ConvertTo-Json -Compress
            $performanceResult = Invoke-Cdp -Socket $socket -Id (490 + $chunkIndex) -Method "Runtime.evaluate" -Params @{
                expression = @"
(async () => {
  const harness = window.__demStudioHarness;
  if (typeof harness?.runInteractionPerformanceProbe !== "function") {
    throw new Error("Interaction performance Harness is unavailable.");
  }
  const renderCanvas = document.querySelector("#viewport canvas") || document.querySelector("canvas");
  const gl = renderCanvas?.getContext?.("webgl2") || renderCanvas?.getContext?.("webgl") || null;
  const debugRendererInfo = gl?.getExtension?.("WEBGL_debug_renderer_info") || null;
  const interaction = await harness.runInteractionPerformanceProbe(
    $chunkMillisecondsJson,
    { keepInteractionActive: $keepInteractionActiveJson }
  );
  return JSON.stringify({
    interaction,
    gpuRenderer: debugRendererInfo
      ? gl.getParameter(debugRendererInfo.UNMASKED_RENDERER_WEBGL)
      : gl?.getParameter?.(gl.RENDERER) || null,
    gpuVendor: debugRendererInfo
      ? gl.getParameter(debugRendererInfo.UNMASKED_VENDOR_WEBGL)
      : gl?.getParameter?.(gl.VENDOR) || null,
    visibilityState: document.visibilityState
  });
})()
"@
                awaitPromise = $true
                returnByValue = $true
            }
            if ($performanceResult.result.exceptionDetails) {
                throw ($performanceResult.result.exceptionDetails.text)
            }
            $lastChunkState = $performanceResult.result.result.value | ConvertFrom-Json
            if ($lastChunkState.visibilityState -ne "visible") {
                throw "Rendering window became non-visible during interaction chunk $chunkIndex."
            }
            foreach ($interval in $lastChunkState.interaction.interactionFrameIntervals) {
                if ([double]$interval -gt 0) {
                    $allFrameIntervals.Add([double]$interval)
                }
            }
            $interactionLongTaskCount +=
                [int]$lastChunkState.interaction.longTaskCount
            $interactionLongTaskMaxMilliseconds = [Math]::Max(
                $interactionLongTaskMaxMilliseconds,
                [double]$lastChunkState.interaction.longTaskMaxMs
            )
            $interactionViewportChangeCount +=
                [int]$lastChunkState.interaction.interactionViewportChangeCount
            $sampleDurationMilliseconds += [double]$lastChunkState.interaction.durationMs
            $remainingMilliseconds -= $chunkMilliseconds
            Measure-DemStudioMemory -Stage ("frame-sample-chunk-{0:D3}" -f $chunkIndex)
        }
        $sortedFrameIntervals = @($allFrameIntervals | Sort-Object)
        if ($sortedFrameIntervals.Count -lt 2) {
            throw "Frame statistics are not valid for a visible rendering window."
        }
        $p50FrameMs = [double]$sortedFrameIntervals[[Math]::Floor(($sortedFrameIntervals.Count - 1) * 0.50)]
        $p95FrameMs = [double]$sortedFrameIntervals[[Math]::Floor(($sortedFrameIntervals.Count - 1) * 0.95)]
        $p99FrameMs = [double]$sortedFrameIntervals[[Math]::Floor(($sortedFrameIntervals.Count - 1) * 0.99)]
        $frameState = [ordered]@{
            source = "window-harness-interaction"
            harnessReader = "runInteractionPerformanceProbe"
            harnessMetrics = [ordered]@{
                soakChunkCount = $chunkIndex
                durationMs = $sampleDurationMilliseconds
                interactionFrameCount = $sortedFrameIntervals.Count
                interactionFrameMsP50 = $p50FrameMs
                interactionFrameMsP95 = $p95FrameMs
                interactionFrameMsP99 = $p99FrameMs
            }
            gpuRenderer = $lastChunkState.gpuRenderer
            gpuVendor = $lastChunkState.gpuVendor
            visibilityState = $lastChunkState.visibilityState
            sampleDurationMs = $sampleDurationMilliseconds
            frameCount = $sortedFrameIntervals.Count
            averageFps = $sortedFrameIntervals.Count * 1000 / $sampleDurationMilliseconds
            p50FrameMs = $p50FrameMs
            p95FrameMs = $p95FrameMs
            p99FrameMs = $p99FrameMs
            maxFrameMs = [double]$sortedFrameIntervals[-1]
            p95Fps = 1000 / $p95FrameMs
            longTaskCount = $interactionLongTaskCount
            longTaskMaxMs = $interactionLongTaskMaxMilliseconds
            viewportChangeCount = $interactionViewportChangeCount
        }
        Write-Output "FRAME_STATS=$($frameState | ConvertTo-Json -Depth 8 -Compress)"
        if ($frameState.visibilityState -ne "visible" -or $frameState.frameCount -lt 2) {
            throw "Frame statistics are not valid for a visible rendering window."
        }
        if ($MinP95Fps -gt 0 -and [double]$frameState.p95Fps -lt $MinP95Fps) {
            throw "Frame p95 FPS $([Math]::Round([double]$frameState.p95Fps, 2)) is below $MinP95Fps."
        }
        if (
            $MaxP99FrameMilliseconds -gt 0 -and
            [double]$frameState.p99FrameMs -gt $MaxP99FrameMilliseconds
        ) {
            throw "Frame p99 $([Math]::Round([double]$frameState.p99FrameMs, 2)) ms exceeds $MaxP99FrameMilliseconds ms."
        }
        if (
            $MaxFrameMilliseconds -gt 0 -and
            [double]$frameState.maxFrameMs -gt $MaxFrameMilliseconds
        ) {
            throw "Maximum frame $([Math]::Round([double]$frameState.maxFrameMs, 2)) ms exceeds $MaxFrameMilliseconds ms."
        }
        if ([int]$frameState.longTaskCount -gt $MaxLongTaskCount) {
            throw "Long-task count $($frameState.longTaskCount) exceeds $MaxLongTaskCount."
        }
        Measure-DemStudioMemory -Stage "frame-sample-complete"
        if ($MemoryTrendProbe) {
            if ($FrameSampleMilliseconds -lt 900000) {
                throw "Memory trend probe requires at least 15 minutes of interaction."
            }
            $trendSamples = @(
                $memorySamples | Where-Object {
                    $_.available -and $_.stage -like "frame-sample-chunk-*"
                }
            )
            if ($trendSamples.Count -lt 12) {
                throw "Memory trend probe did not collect enough process-tree samples."
            }
            $warmupCount = [Math]::Max(
                4,
                [Math]::Floor($trendSamples.Count * 0.20)
            )
            $steadySamples = @($trendSamples | Select-Object -Skip $warmupCount)
            $quartileSize = [Math]::Max(
                1,
                [Math]::Floor($steadySamples.Count / 4)
            )
            $quartileMedians = [System.Collections.Generic.List[long]]::new()
            for ($quartileIndex = 0; $quartileIndex -lt 4; $quartileIndex += 1) {
                $quartile = @(
                    $steadySamples |
                        Select-Object -Skip ($quartileIndex * $quartileSize) `
                            -First $quartileSize
                )
                if ($quartile.Count -eq 0) {
                    continue
                }
                $sortedWorkingSets = @(
                    $quartile.workingSetBytes | ForEach-Object { [long]$_ } |
                        Sort-Object
                )
                $medianIndex = [Math]::Floor(
                    ($sortedWorkingSets.Count - 1) / 2
                )
                $quartileMedians.Add([long]$sortedWorkingSets[$medianIndex])
            }
            if ($quartileMedians.Count -ne 4) {
                throw "Memory trend probe could not form four steady-state windows."
            }
            $strictlyIncreasing = $true
            for ($medianIndex = 1; $medianIndex -lt $quartileMedians.Count; $medianIndex += 1) {
                if ($quartileMedians[$medianIndex] -le $quartileMedians[$medianIndex - 1]) {
                    $strictlyIncreasing = $false
                    break
                }
            }
            [long]$steadyGrowthBytes =
                $quartileMedians[-1] - $quartileMedians[0]
            [long]$allowedSteadyGrowthBytes = 64MB
            $memoryTrendState = [ordered]@{
                passed = (
                    $interactionViewportChangeCount -ge $MinimumViewportChanges -and
                    $steadyGrowthBytes -le $allowedSteadyGrowthBytes
                )
                requestedDurationMilliseconds = $FrameSampleMilliseconds
                sampleCount = $trendSamples.Count
                warmupSampleCount = $warmupCount
                viewportChangeCount = $interactionViewportChangeCount
                minimumViewportChanges = $MinimumViewportChanges
                quartileMedianWorkingSetBytes = @($quartileMedians)
                steadyGrowthBytes = $steadyGrowthBytes
                allowedSteadyGrowthBytes = $allowedSteadyGrowthBytes
                strictlyIncreasingQuartileMedians = $strictlyIncreasing
            }
            Write-Output "MEMORY_TREND=$($memoryTrendState | ConvertTo-Json -Compress)"
            if (-not $memoryTrendState.passed) {
                throw "Process-tree memory did not reach a bounded steady state."
            }
        }
    }

    if ($CinematicProbe) {
        if ($QuickPreset) {
            $cinematicPresetJson = $QuickPreset | ConvertTo-Json -Compress
            $cinematicPresetResult = Invoke-Cdp -Socket $socket -Id 49 -Method "Runtime.evaluate" -Params @{
                expression = @"
(async () => {
  const button = document.querySelector('[data-quick-preset=' + $cinematicPresetJson + ']');
  if (!button) throw new Error("Cinematic preset button is unavailable.");
  button.click();
  await new Promise(resolve => setTimeout(resolve, 1000));
  return true;
})()
"@
                awaitPromise = $true
                returnByValue = $true
            }
            if ($cinematicPresetResult.result.exceptionDetails) {
                throw ($cinematicPresetResult.result.exceptionDetails.text)
            }
        }
        $cinematicOutputJson = if ($CinematicOutput) {
            [System.IO.Path]::GetFullPath($CinematicOutput) | ConvertTo-Json -Compress
        }
        else {
            "null"
        }
        $cinematicTransparentJson = ([bool]$CinematicTransparent) | ConvertTo-Json -Compress
        $cinematicResult = Invoke-Cdp -Socket $socket -Id 52 -Method "Runtime.evaluate" -Params @{
            expression = "(async () => JSON.stringify(await window.__demStudioHarness.renderCinematicProbe($cinematicOutputJson, $CinematicSamples, $CinematicMaxDimension, $cinematicTransparentJson)))()"
            awaitPromise = $true
            returnByValue = $true
        }
        if ($cinematicResult.result.exceptionDetails) {
            $cinematicResult.result.exceptionDetails | ConvertTo-Json -Depth 12
            throw ($cinematicResult.result.exceptionDetails.text)
        }
        $cinematicState = $cinematicResult.result.result.value | ConvertFrom-Json
        $cinematicState | ConvertTo-Json -Compress
        if ($cinematicState.renderer -ne "babylon-high-quality-raster" -or
            $cinematicState.accumulationFrames -ne 32 -or
            $cinematicState.msaaSamples -lt 1 -or
            $cinematicState.width -gt $CinematicMaxDimension -or
            $cinematicState.height -gt $CinematicMaxDimension -or
            $cinematicState.byteLength -lt 100 -or
            $cinematicState.opaquePixelCount -lt 1 -or
            $cinematicState.luminanceRange -lt 8) {
            throw "Babylon cinematic raster runtime assertion failed."
        }
        if ($CinematicTransparent -and (
            -not $cinematicState.transparentBackground -or
            $cinematicState.alphaMinimum -ne 0 -or
            $cinematicState.alphaMaximum -lt 250 -or
            $cinematicState.transparentPixelCount -lt 1
        )) {
            throw "Babylon cinematic transparent background assertion failed."
        }
        if ($CinematicOutput) {
            $cinematicBytesResult = Invoke-Cdp -Socket $socket -Id 50 -Method "Runtime.evaluate" -Params @{
                expression = @'
(async () => {
  const blob = window.__demStudioLastCinematicBlob;
  if (!blob) throw new Error("Cinematic probe blob is unavailable.");
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
})()
'@
                awaitPromise = $true
                returnByValue = $true
            }
            if ($cinematicBytesResult.result.exceptionDetails) {
                throw ($cinematicBytesResult.result.exceptionDetails.text)
            }
            $resolvedCinematicOutput = Resolve-OutputPath -Path $CinematicOutput
            [System.IO.File]::WriteAllBytes(
                $resolvedCinematicOutput,
                [Convert]::FromBase64String($cinematicBytesResult.result.result.value)
            )
        }
    }

    if ($QuickPreset) {
        $presetJson = $QuickPreset | ConvertTo-Json -Compress
        $presetResult = Invoke-Cdp -Socket $socket -Id 53 -Method "Runtime.evaluate" -Params @{
            expression = @"
(async () => {
  const button = document.querySelector('[data-quick-preset=' + $presetJson + ']');
  if (!button) return JSON.stringify({ found: false });
  button.click();
  const deadline = performance.now() + 30000;
  let diagnostics = null;
  do {
    await new Promise(resolve => setTimeout(resolve, 50));
    diagnostics = window.__demStudioHarness.getRendererDiagnostics();
    if (
      diagnostics.renderPreset === $presetJson
      && diagnostics.terrainBuildSettled
      && diagnostics.terrainRuntime?.subMeshes?.every(
        subMesh => subMesh.ready && subMesh.effectReady && !subMesh.compilationError
      )
    ) break;
  } while (performance.now() < deadline);
  return JSON.stringify({
    found: true,
    active: button.getAttribute("aria-pressed"),
    settled: Boolean(diagnostics?.terrainBuildSettled),
    committedGeneration: diagnostics?.terrainCommittedGeneration ?? 0,
    buildGeneration: diagnostics?.terrainBuildGeneration ?? 0,
    rendererPreset: diagnostics?.renderPreset ?? null,
    materialMode: diagnostics?.materialMode ?? null,
    directShadow: document.querySelector('[data-key="directShadowEnabled"]')?.checked ?? null,
    transparentExport: document.querySelector('[data-key="transparentExport"]')?.checked ?? null,
    backgroundColor: document.querySelector('[data-key="backgroundColor"]')?.value ?? null,
    resolution: document.querySelector('[data-key="resolution"]')?.value ?? null,
    smoothSteps: document.querySelector('[data-key="smoothSteps"]')?.value ?? null
  });
})()
"@
            awaitPromise = $true
            returnByValue = $true
        }
        if ($presetResult.result.exceptionDetails) {
            throw ($presetResult.result.exceptionDetails.text)
        }
        $presetState = $presetResult.result.result.value | ConvertFrom-Json
        $presetState | ConvertTo-Json -Compress
        if (
            -not $presetState.found -or
            $presetState.active -ne "true" -or
            -not $presetState.settled -or
            $presetState.rendererPreset -ne $QuickPreset -or
            $presetState.committedGeneration -ne $presetState.buildGeneration
        ) {
            throw "Quick preset runtime assertion failed."
        }
        if ($QuickPreset -eq "white" -and (
            $presetState.materialMode -ne "white" -or
            -not $presetState.directShadow -or
            $presetState.transparentExport -or
            $presetState.backgroundColor -ne "#dce4ed"
        )) {
            throw "White studio render profile runtime assertion failed."
        }
        if ($FileBackedProbe) {
            # Applying a preset can rebuild the terrain because it changes the
            # requested resolution. Lighting diagnostics and screenshots must
            # observe the settled target LOD, not the temporary overview mesh.
            for ($presetLodAttempt = 0; $presetLodAttempt -lt 480; $presetLodAttempt += 1) {
                $presetLodResult = Invoke-Cdp -Socket $socket -Id (3059 + $presetLodAttempt) -Method "Runtime.evaluate" -Params @{
                    expression = "(async () => JSON.stringify(await window.__demStudioHarness.getDatasetState()))()"
                    awaitPromise = $true
                    returnByValue = $true
                }
                if ($presetLodResult.result.exceptionDetails) {
                    throw ($presetLodResult.result.exceptionDetails.text)
                }
                $presetLodState = $presetLodResult.result.result.value | ConvertFrom-Json
                $presetRootReady = $presetLodState.streamingLod.rootCoverageExact -and
                    $presetLodState.streamingLod.rootBaseRequired -and
                    $presetLodState.streamingLod.rootBasePreserved
                $presetStreamingReady =
                    -not $presetLodState.streamingLod.enabled -or (
                        $presetLodState.streamingLod.coverageComplete -and
                        -not $presetLodState.streamingLod.rootTopVisible -and
                        $presetLodState.streamingLod.rootTopIndexCount -eq 0 -and
                        $presetRootReady -and
                        $presetLodState.streamingLod.pendingRequestCount -eq 0 -and
                        $presetLodState.streamingLod.queuedRequestCount -eq 0 -and
                        $presetLodState.streamingLod.queuedUploadCount -eq 0
                    )
                if ($presetStreamingReady) {
                    break
                }
                Start-Sleep -Milliseconds 250
            }
            if (-not $presetStreamingReady) {
                throw "White preset target LOD did not settle before lighting capture."
            }
        }
        if ($QuickPreset -eq "white") {
            $lightingResult = Invoke-Cdp -Socket $socket -Id 537 -Method "Runtime.evaluate" -Params @{
                expression = "JSON.stringify(window.__demStudioHarness.getLightingDiagnostics())"
                returnByValue = $true
            }
            if ($lightingResult.result.exceptionDetails) {
                $lightingException = $lightingResult.result.exceptionDetails
                $lightingDescription = [string]$lightingException.exception.description
                throw "$($lightingException.text): $lightingDescription"
            }
            $lightingState = $lightingResult.result.result.value | ConvertFrom-Json
            Write-Output "LIGHTING_DIAGNOSTICS=$($lightingState | ConvertTo-Json -Depth 6 -Compress)"
            if (
                -not $lightingState.studio.active -or
                [double]$lightingState.studio.metrics.xyDiagonal -le 0 -or
                [double]$lightingState.studio.metrics.gridSpacing -le 0 -or
                [double]$lightingState.studio.metrics.projectedTerrainSize -le 0 -or
                [double]$lightingState.studio.metrics.worldUnitsPerPixel -le 0 -or
                [double]$lightingState.studio.derived.microDetailWeight -le 0 -or
                [double]$lightingState.studio.derived.microDetailWeight -gt 0.82 -or
                [double]$lightingState.studio.gtaoResolutionScale -lt 0.50 -or
                [double]$lightingState.studio.gtaoResolutionScale -gt 0.75 -or
                [int]$lightingState.lightModel.sourceCount -ne 2 -or
                [int]$lightingState.lightModel.babylonLightCount -ne 1 -or
                $lightingState.mainLight.role -ne "directional-key" -or
                $lightingState.mainLight.intensity -lt 0.5 -or
                -not $lightingState.mainLight.castShadow -or
                $lightingState.projection.role -ne "directional-key" -or
                $lightingState.projection.intensity -lt 0.5 -or
                -not $lightingState.projection.terrainInfluence -or
                -not $lightingState.projection.castShadow -or
                $lightingState.projection.shadowMapTypeName -ne "PCFSoftShadowMap" -or
                $lightingState.projection.shadowMapSize -lt 1024 -or
                [Math]::Abs([double]$lightingState.projection.normalBias) -gt 0.01 -or
                $lightingState.environmentLight.type -ne "pbr-diffuse-irradiance" -or
                -not $lightingState.environmentLight.sphericalPolynomial -or
                $lightingState.environmentIntensity -lt 0.10 -or
                $lightingState.environmentIntensity -gt 1.50 -or
                -not $lightingState.gtao.enabled -or
                $lightingState.gtao.composition -ne "ssao2-postprocess" -or
                [double]$lightingState.gtao.indirectStrength -gt 0.12 -or
                [Math]::Abs([double]$lightingState.horizon.indirectStrength) -gt 0.000001 -or
                -not $lightingState.terrain.castShadow -or
                -not $lightingState.terrain.receiveShadow -or
                $lightingState.terrain.normalMap -or
                $lightingState.terrain.normalSource -ne "dem-gradient-multiscale" -or
                [double]$lightingState.floatShadow.opacity -gt 0.24 -or
                $lightingState.studio.exposure.mode -ne "fixed" -or
                [double]$lightingState.studio.exposure.value -lt 0.70 -or
                [double]$lightingState.studio.exposure.value -gt 1.50 -or
                -not $lightingState.studioFloor.enabled -or
                -not $lightingState.studioFloor.visible -or
                -not $lightingState.studioFloor.receiveShadow -or
                $lightingState.studioFloor.castShadow
            ) {
                throw "Layered white lighting runtime assertion failed."
            }
            $aoToggleResult = Invoke-Cdp -Socket $socket -Id 538 -Method "Runtime.evaluate" -Params @{
                expression = "JSON.stringify(window.__demStudioHarness.probeLightingAoToggle())"
                returnByValue = $true
            }
            if ($aoToggleResult.result.exceptionDetails) {
                throw ($aoToggleResult.result.exceptionDetails.text)
            }
            $aoToggleState = $aoToggleResult.result.result.value | ConvertFrom-Json
            Write-Output "LIGHTING_AO_TOGGLE=$($aoToggleState | ConvertTo-Json -Compress)"
            if (
                [Math]::Abs([double]$aoToggleState.disabledHorizonStrength) -gt 0.000001 -or
                $aoToggleState.disabledGtao -or
                [Math]::Abs([double]$aoToggleState.enabledHorizonStrength) -gt 0.000001 -or
                -not $aoToggleState.enabledGtao
            ) {
                throw "AO toggle did not disable and restore SSAO2 independently of environment irradiance."
            }
            $isolationResult = Invoke-Cdp -Socket $socket -Id 5381 -Method "Runtime.evaluate" -Params @{
                expression = "JSON.stringify(window.__demStudioHarness.probeLightingControlIsolation())"
                returnByValue = $true
            }
            if ($isolationResult.result.exceptionDetails) {
                throw ($isolationResult.result.exceptionDetails.text)
            }
            $isolation = $isolationResult.result.result.value | ConvertFrom-Json
            Write-Output "LIGHTING_CONTROL_ISOLATION=$($isolation | ConvertTo-Json -Depth 4 -Compress)"
            if (
                [int]$isolation.terrainBuildGenerationBefore -ne [int]$isolation.terrainBuildGenerationAfter -or
                [double]$isolation.keyChanged.main -le [double]$isolation.base.main -or
                [Math]::Abs([double]$isolation.keyChanged.environment - [double]$isolation.base.environment) -gt 0.000001 -or
                [Math]::Abs([double]$isolation.keyChanged.exposure - [double]$isolation.base.exposure) -gt 0.000001 -or
                [double]$isolation.environmentChanged.environment -le [double]$isolation.base.environment -or
                [Math]::Abs([double]$isolation.environmentChanged.main - [double]$isolation.base.main) -gt 0.000001 -or
                [Math]::Abs([double]$isolation.environmentChanged.exposure - [double]$isolation.base.exposure) -gt 0.000001 -or
                [double]$isolation.exposureChanged.exposure -le [double]$isolation.base.exposure -or
                [Math]::Abs([double]$isolation.exposureChanged.main - [double]$isolation.base.main) -gt 0.000001 -or
                [Math]::Abs([double]$isolation.exposureChanged.environment - [double]$isolation.base.environment) -gt 0.000001
            ) {
                throw "Main light, environment diffuse, and exposure are not independent."
            }
            if ($PerformanceProbe) {
                $whitePerformanceResult = Invoke-Cdp -Socket $socket -Id 539 -Method "Runtime.evaluate" -Params @{
                    expression = "(async () => JSON.stringify(await window.__demStudioHarness.runInteractionPerformanceProbe($FrameSampleMilliseconds)))()"
                    awaitPromise = $true
                    returnByValue = $true
                }
                if ($whitePerformanceResult.result.exceptionDetails) {
                    throw ($whitePerformanceResult.result.exceptionDetails.text)
                }
                $whitePerformance = $whitePerformanceResult.result.result.value | ConvertFrom-Json
                $whiteP95Fps = if ([double]$whitePerformance.interactionFrameMsP95 -gt 0) {
                    1000 / [double]$whitePerformance.interactionFrameMsP95
                } else {
                    0
                }
                Write-Output "WHITE_INTERACTION_PERFORMANCE=$($whitePerformance | ConvertTo-Json -Depth 5 -Compress)"
                Write-Output "WHITE_INTERACTION_P95_FPS=$([Math]::Round($whiteP95Fps, 2))"
                if ($MinP95Fps -gt 0 -and $whiteP95Fps -lt $MinP95Fps) {
                    throw "White profile interaction p95 FPS $([Math]::Round($whiteP95Fps, 2)) is below $MinP95Fps."
                }
                if ($MaxP99FrameMilliseconds -gt 0 -and
                    [double]$whitePerformance.interactionFrameMsP99 -gt $MaxP99FrameMilliseconds) {
                    throw "White profile interaction p99 frame time exceeds $MaxP99FrameMilliseconds ms."
                }
                if ($MaxFrameMilliseconds -gt 0 -and
                    [double]$whitePerformance.interactionFrameMsMax -gt $MaxFrameMilliseconds) {
                    throw "White profile maximum frame time exceeds $MaxFrameMilliseconds ms."
                }
                if ([int]$whitePerformance.longTaskCount -gt $MaxLongTaskCount) {
                    throw "White profile long-task count exceeds $MaxLongTaskCount."
                }
                # endInteractiveRendering restores settled post-processing after 220 ms.
                # Do not let the following lighting captures inherit interaction quality.
                Start-Sleep -Milliseconds 350
            }
        }
        if ($PresetScreenshot) {
            $resolvedPresetScreenshot = Resolve-OutputPath -Path $PresetScreenshot
            Start-Sleep -Milliseconds 500
            $presetCapture = Invoke-Cdp -Socket $socket -Id 535 -Method "Page.captureScreenshot" -Params @{
                format = "png"
                captureBeyondViewport = $false
            }
            [System.IO.File]::WriteAllBytes(
                $resolvedPresetScreenshot,
                [Convert]::FromBase64String($presetCapture.result.data)
            )
            Write-Output "PRESET_SCREENSHOT=$resolvedPresetScreenshot"
        }
        if ($PresetCanvasScreenshot) {
            $resolvedPresetCanvasScreenshot = Resolve-OutputPath -Path $PresetCanvasScreenshot
            $canvasCapture = Invoke-Cdp -Socket $socket -Id 536 -Method "Runtime.evaluate" -Params @{
                expression = "(async () => await window.__demStudioHarness.captureViewportPng())()"
                awaitPromise = $true
                returnByValue = $true
            }
            if ($canvasCapture.result.exceptionDetails) {
                throw ($canvasCapture.result.exceptionDetails.text)
            }
            $canvasBase64 = ([string]$canvasCapture.result.result.value).Split(",")[-1]
            [System.IO.File]::WriteAllBytes(
                $resolvedPresetCanvasScreenshot,
                [Convert]::FromBase64String($canvasBase64)
            )
            Write-Output "PRESET_CANVAS_SCREENSHOT=$resolvedPresetCanvasScreenshot"
        }
        if ($VisualAppearanceProbe) {
            $appearanceResult = Invoke-Cdp -Socket $socket -Id 5361 -Method "Runtime.evaluate" -Params @{
                expression = "(async () => JSON.stringify(await window.__demStudioHarness.analyzeViewportAppearance()))()"
                awaitPromise = $true
                returnByValue = $true
            }
            if ($appearanceResult.result.exceptionDetails) {
                throw ($appearanceResult.result.exceptionDetails.text)
            }
            $appearance = $appearanceResult.result.result.value | ConvertFrom-Json
            Write-Output "VISUAL_APPEARANCE=$($appearance | ConvertTo-Json -Depth 8 -Compress)"
            if (
                [double]$appearance.foregroundCoverage -lt 0.05 -or
                [int]$appearance.foregroundPixels -lt 1000 -or
                -not $appearance.verdict.passed
            ) {
                throw "Visual appearance probe rejected the terrain frame: $($appearance.verdict.reason)"
            }
            # Windows PowerShell 5 reads BOM-less scripts with the active ANSI code page.
            # Build the Chinese product label from code points so this assertion is encoding-independent.
            $gypsumHudLabel = ([string][char]0x77F3) + ([string][char]0x818F)
            $whiteAppearanceOk = (
                ([string]$appearance.materialMode -eq "white") -and
                ([string]$appearance.surfaceMaterial -eq "gypsum") -and
                ([string]$appearance.activeQuickStyle -eq "white") -and
                ([string]$appearance.hudMode).Contains($gypsumHudLabel) -and
                ([string]$appearance.toneMapping.toneMapping -eq "neutral") -and
                ([int]$appearance.toneMapping.toneMappingType -eq 2) -and
                ([double]$appearance.luminanceP10 -ge 0.55) -and
                ([double]$appearance.luminanceP50 -ge 0.80) -and
                ([double]$appearance.luminanceP90 -ge 0.82) -and
                ([double]$appearance.luminanceP90 -lt 0.985) -and
                ([double]$appearance.luminanceRange -ge 0.10)
            )
            if ($QuickPreset -eq "white" -and -not $whiteAppearanceOk) {
                throw "White visual appearance is gray, clipped, flat, or semantically mislabeled."
            }
            $clayAppearanceOk = (
                ([string]$appearance.materialMode -eq "white") -and
                ([string]$appearance.surfaceMaterial -eq "gypsum") -and
                ([string]$appearance.activeQuickStyle -eq "clay") -and
                ([string]$appearance.hudMode).Contains($gypsumHudLabel) -and
                ([string]$appearance.toneMapping.toneMapping -eq "neutral") -and
                ([int]$appearance.toneMapping.toneMappingType -eq 2) -and
                ([double]$appearance.luminanceP50 -ge 0.22) -and
                ([double]$appearance.luminanceP90 -lt 0.985) -and
                ([double]$appearance.luminanceRange -ge 0.06)
            )
            if ($QuickPreset -eq "clay" -and -not $clayAppearanceOk) {
                throw "Natural gypsum appearance is dark, clipped, flat, or semantically mislabeled."
            }
            $reliefAppearanceOk = (
                ([string]$appearance.materialMode -eq "white") -and
                ([string]$appearance.surfaceMaterial -eq "gypsum") -and
                ([string]$appearance.activeQuickStyle -eq "relief") -and
                ([string]$appearance.hudMode).Contains($gypsumHudLabel) -and
                ([string]$appearance.toneMapping.toneMapping -eq "neutral") -and
                ([int]$appearance.toneMapping.toneMappingType -eq 2)
            )
            if ($QuickPreset -eq "relief" -and -not $reliefAppearanceOk) {
                throw "Relief gypsum appearance is black or semantically mislabeled."
            }
        }
        if ($LightingAblationDirectory) {
            $ablationDirectory = [System.IO.Path]::GetFullPath($LightingAblationDirectory)
            [System.IO.Directory]::CreateDirectory($ablationDirectory) | Out-Null
            $variantIndex = 0
            foreach ($variant in @("base", "environment", "ssao", "direct", "floor", "shadow", "all")) {
                $variantJson = $variant | ConvertTo-Json -Compress
                $variantCapture = Invoke-Cdp -Socket $socket -Id (600 + $variantIndex) -Method "Runtime.evaluate" -Params @{
                    expression = "(async () => await window.__demStudioHarness.captureLightingVariantPng($variantJson))()"
                    awaitPromise = $true
                    returnByValue = $true
                }
                if ($variantCapture.result.exceptionDetails) {
                    throw ($variantCapture.result.exceptionDetails.text)
                }
                $variantBase64 = ([string]$variantCapture.result.result.value).Split(",")[-1]
                $variantPath = Join-Path $ablationDirectory "${variant}.png"
                [System.IO.File]::WriteAllBytes(
                    $variantPath,
                    [Convert]::FromBase64String($variantBase64)
                )
                Write-Output "LIGHTING_VARIANT_$($variant.ToUpperInvariant())=$variantPath"
                $variantIndex += 1
            }
            $signatureResult = Invoke-Cdp -Socket $socket -Id 620 -Method "Runtime.evaluate" -Params @{
                expression = "JSON.stringify(window.__demStudioHarness.getLightingVariantSignatures())"
                returnByValue = $true
            }
            if ($signatureResult.result.exceptionDetails) {
                throw ($signatureResult.result.exceptionDetails.text)
            }
            $lightingSignatures = $signatureResult.result.result.value | ConvertFrom-Json
            $signatureHashes = @(
                $lightingSignatures.base.hash,
                $lightingSignatures.environment.hash,
                $lightingSignatures.ssao.hash,
                $lightingSignatures.direct.hash,
                $lightingSignatures.floor.hash,
                $lightingSignatures.shadow.hash,
                $lightingSignatures.all.hash
            )
            Write-Output "LIGHTING_SIGNATURES=$($lightingSignatures | ConvertTo-Json -Depth 4 -Compress)"
            if (($signatureHashes | Sort-Object -Unique).Count -ne 7) {
                throw "Lighting ablation pixel signatures are not all distinct."
            }
            if ([double]$lightingSignatures.direct.meanLuminance -le 1) {
                throw "Directional key alone rendered black."
            }
            $environmentMean = [double]$lightingSignatures.environment.meanLuminance
            $ssaoMean = [double]$lightingSignatures.ssao.meanLuminance
            if (
                $environmentMean -le 0 -or
                [Math]::Abs($ssaoMean - $environmentMean) / $environmentMean -gt 0.05
            ) {
                throw "SSAO changed global mean luminance by more than 5%."
            }
        }
    }

    if ($PresetRoundTripProbe) {
        $roundTripResult = Invoke-Cdp -Socket $socket -Id 5390 -Method "Runtime.evaluate" -Params @{
            expression = @'
(async () => {
  const sequence = ["white", "clay", "relief", "white", "relief"];
  const results = [];
  for (const key of sequence) {
    const button = document.querySelector(`[data-quick-preset="${key}"]`);
    if (!button) throw new Error(`Missing quick preset button: ${key}`);
    const before = window.__demStudioHarness.getRendererDiagnostics();
    button.click();
    const deadline = performance.now() + 30000;
    let diagnostics = null;
    do {
      await new Promise(resolve => setTimeout(resolve, 50));
      diagnostics = window.__demStudioHarness.getRendererDiagnostics();
      if (
        diagnostics.renderPreset === key
        && diagnostics.terrainBuildSettled
        && diagnostics.terrainRuntime?.subMeshes?.every(
          subMesh => subMesh.ready && subMesh.effectReady && !subMesh.compilationError
        )
      ) break;
    } while (performance.now() < deadline);
    const appearance = await window.__demStudioHarness.analyzeViewportAppearance();
    results.push({
      key,
      beforeGeneration: before.terrainBuildGeneration,
      buildGeneration: diagnostics?.terrainBuildGeneration ?? 0,
      committedGeneration: diagnostics?.terrainCommittedGeneration ?? 0,
      renderPreset: diagnostics?.renderPreset ?? null,
      materialMode: diagnostics?.materialMode ?? null,
      surfaceMaterial: diagnostics?.surfaceMaterial ?? null,
      effectErrors: diagnostics?.runtime?.effectErrors ?? [],
      runtimeErrors: diagnostics?.runtimeErrors ?? [],
      allSubMeshesReady: Boolean(
        diagnostics?.terrainRuntime?.subMeshes?.every(
          subMesh => subMesh.ready && subMesh.effectReady && !subMesh.compilationError
        )
      ),
      appearance,
    });
  }
  return JSON.stringify(results);
})()
'@
            awaitPromise = $true
            returnByValue = $true
        }
        if ($roundTripResult.result.exceptionDetails) {
            throw ($roundTripResult.result.exceptionDetails.text)
        }
        $roundTrip = $roundTripResult.result.result.value | ConvertFrom-Json
        Write-Output "PRESET_ROUND_TRIP=$($roundTrip | ConvertTo-Json -Depth 10 -Compress)"
        $expectedModes = @{
            white = "white"
            clay = "custom"
            relief = "relief"
        }
        foreach ($entry in $roundTrip) {
            if (
                $entry.renderPreset -ne $entry.key -or
                $entry.materialMode -ne $expectedModes[$entry.key] -or
                $entry.surfaceMaterial -ne "gypsum" -or
                $entry.buildGeneration -ne $entry.committedGeneration -or
                -not $entry.allSubMeshesReady -or
                @($entry.effectErrors).Count -gt 0 -or
                @($entry.runtimeErrors).Count -gt 0 -or
                -not $entry.appearance.verdict.passed
            ) {
                throw "Preset round-trip failed for $($entry.key): $($entry | ConvertTo-Json -Depth 8 -Compress)"
            }
        }
    }

    if ($CameraControlProbe) {
        $cameraSurfaceResult = Invoke-Cdp -Socket $socket -Id 24000 -Method "Runtime.evaluate" -Params @{
            expression = @'
(() => {
  const canvas = document.querySelector("canvas.babylon-render-surface");
  const rect = canvas?.getBoundingClientRect();
  const hit = rect
    ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
    : null;
  return JSON.stringify({
    rect: rect ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : null,
    hit: hit ? { tag: hit.tagName, id: hit.id, className: hit.className } : null,
    camera: window.__demStudioRenderer.diagnostics().camera,
    renderer: window.__demStudioHarness.getRendererDiagnostics()
  });
})()
'@
            returnByValue = $true
        }
        if ($cameraSurfaceResult.result.exceptionDetails) {
            throw ($cameraSurfaceResult.result.exceptionDetails.text)
        }
        $cameraBefore = $cameraSurfaceResult.result.result.value | ConvertFrom-Json
        if (-not $cameraBefore.rect -or
            $cameraBefore.rect.width -lt 64 -or
            $cameraBefore.rect.height -lt 64 -or
            -not $cameraBefore.camera.inputsAttached) {
            throw "Babylon camera inputs are not attached to an interactive render surface."
        }
        $cameraX = [double]$cameraBefore.rect.left + ([double]$cameraBefore.rect.width / 2)
        $cameraY = [double]$cameraBefore.rect.top + ([double]$cameraBefore.rect.height / 2)

        $null = Invoke-Cdp -Socket $socket -Id 24001 -Method "Input.dispatchMouseEvent" -Params @{
            type = "mousePressed"; x = $cameraX; y = $cameraY
            button = "left"; buttons = 1; clickCount = 1
        }
        $null = Invoke-Cdp -Socket $socket -Id 24002 -Method "Input.dispatchMouseEvent" -Params @{
            type = "mouseMoved"; x = $cameraX + 64; y = $cameraY + 24
            button = "left"; buttons = 1
        }
        $null = Invoke-Cdp -Socket $socket -Id 24003 -Method "Input.dispatchMouseEvent" -Params @{
            type = "mouseReleased"; x = $cameraX + 64; y = $cameraY + 24
            button = "left"; buttons = 0; clickCount = 1
        }
        Start-Sleep -Milliseconds 350
        $cameraRotateResult = Invoke-Cdp -Socket $socket -Id 24004 -Method "Runtime.evaluate" -Params @{
            expression = "JSON.stringify(window.__demStudioRenderer.diagnostics().camera)"
            returnByValue = $true
        }
        $cameraAfterRotate = $cameraRotateResult.result.result.value | ConvertFrom-Json

        $null = Invoke-Cdp -Socket $socket -Id 24005 -Method "Input.dispatchMouseEvent" -Params @{
            type = "mousePressed"; x = $cameraX; y = $cameraY
            button = "right"; buttons = 2; clickCount = 1
        }
        $null = Invoke-Cdp -Socket $socket -Id 24006 -Method "Input.dispatchMouseEvent" -Params @{
            type = "mouseMoved"; x = $cameraX + 38; y = $cameraY - 28
            button = "right"; buttons = 2
        }
        $null = Invoke-Cdp -Socket $socket -Id 24007 -Method "Input.dispatchMouseEvent" -Params @{
            type = "mouseReleased"; x = $cameraX + 38; y = $cameraY - 28
            button = "right"; buttons = 0; clickCount = 1
        }
        Start-Sleep -Milliseconds 350
        $cameraPanResult = Invoke-Cdp -Socket $socket -Id 24008 -Method "Runtime.evaluate" -Params @{
            expression = "JSON.stringify(window.__demStudioRenderer.diagnostics().camera)"
            returnByValue = $true
        }
        $cameraAfterPan = $cameraPanResult.result.result.value | ConvertFrom-Json

        $null = Invoke-Cdp -Socket $socket -Id 24009 -Method "Input.dispatchMouseEvent" -Params @{
            type = "mouseWheel"; x = $cameraX; y = $cameraY; deltaX = 0; deltaY = -240
        }
        Start-Sleep -Milliseconds 450
        $cameraWheelResult = Invoke-Cdp -Socket $socket -Id 24010 -Method "Runtime.evaluate" -Params @{
            expression = "JSON.stringify({ camera: window.__demStudioRenderer.diagnostics().camera, renderer: window.__demStudioHarness.getRendererDiagnostics() })"
            returnByValue = $true
        }
        $cameraAfterWheelState = $cameraWheelResult.result.result.value | ConvertFrom-Json
        $cameraAfterWheel = $cameraAfterWheelState.camera

        $rotateChanged =
            [Math]::Abs([double]$cameraAfterRotate.alpha - [double]$cameraBefore.camera.alpha) -gt 0.0001 -or
            [Math]::Abs([double]$cameraAfterRotate.beta - [double]$cameraBefore.camera.beta) -gt 0.0001
        $panDelta = 0.0
        for ($cameraAxis = 0; $cameraAxis -lt 3; $cameraAxis += 1) {
            $axisDelta =
                [double]$cameraAfterPan.target[$cameraAxis] -
                [double]$cameraAfterRotate.target[$cameraAxis]
            $panDelta += $axisDelta * $axisDelta
        }
        $wheelChanged = if ($cameraAfterPan.mode -eq "orthographic") {
            [Math]::Abs([double]$cameraAfterWheel.zoom - [double]$cameraAfterPan.zoom) -gt 0.0001 -and
            [Math]::Abs([double]$cameraAfterWheel.orthoHeight - [double]$cameraAfterPan.orthoHeight) -gt 0.0001
        } else {
            [Math]::Abs([double]$cameraAfterWheel.radius - [double]$cameraAfterPan.radius) -gt 0.0001
        }
        $topologyStable =
            [long]$cameraAfterWheelState.renderer.postProcessing.babylon.topologyChangeCount -eq
            [long]$cameraBefore.renderer.postProcessing.babylon.topologyChangeCount
        $terrainGenerationStable =
            [long]$cameraAfterWheelState.renderer.terrainBuildGeneration -eq
            [long]$cameraBefore.renderer.terrainBuildGeneration
        $cameraControlState = [ordered]@{
            passed =
                $rotateChanged -and
                $panDelta -gt 0.00000001 -and
                $wheelChanged -and
                $topologyStable -and
                $terrainGenerationStable
            inputsAttached = [bool]$cameraBefore.camera.inputsAttached
            rotateChanged = $rotateChanged
            panChanged = $panDelta -gt 0.00000001
            wheelChanged = $wheelChanged
            postProcessTopologyStable = $topologyStable
            topologyChangeCountBefore =
                [long]$cameraBefore.renderer.postProcessing.babylon.topologyChangeCount
            topologyChangeCountAfter =
                [long]$cameraAfterWheelState.renderer.postProcessing.babylon.topologyChangeCount
            terrainGenerationStable = $terrainGenerationStable
            terrainBuildGenerationBefore = [long]$cameraBefore.renderer.terrainBuildGeneration
            terrainBuildGenerationAfter =
                [long]$cameraAfterWheelState.renderer.terrainBuildGeneration
            before = $cameraBefore.camera
            hit = $cameraBefore.hit
            afterRotate = $cameraAfterRotate
            afterPan = $cameraAfterPan
            afterWheel = $cameraAfterWheel
        }
        Write-Output "CAMERA_CONTROL=$($cameraControlState | ConvertTo-Json -Depth 8 -Compress)"
        if (-not $cameraControlState.passed) {
            throw "Babylon real rotate, pan, and wheel camera input probe failed."
        }
    }

    if ($TerrainSettingsProbe) {
        $settingsBeforeResult = Invoke-Cdp -Socket $socket -Id 24100 -Method "Runtime.evaluate" -Params @{
            expression = "JSON.stringify(window.__demStudioHarness.getRendererDiagnostics())"
            returnByValue = $true
        }
        $settingsBefore = $settingsBeforeResult.result.result.value | ConvertFrom-Json
        $textureAppearanceResult = Invoke-Cdp -Socket $socket -Id 24101 -Method "Runtime.evaluate" -Params @{
            expression = "JSON.stringify(window.__demStudioHarness.probeTextureAppearanceTransform())"
            returnByValue = $true
        }
        $textureAppearance = $textureAppearanceResult.result.result.value | ConvertFrom-Json

        $settingsMutationResult = Invoke-Cdp -Socket $socket -Id 24102 -Method "Runtime.evaluate" -Params @{
            expression = @'
(() => {
  const heightScale = window.__demStudioHarness.setTerrainSetting("heightScale", 2.2);
  const baseThickness = window.__demStudioHarness.setTerrainSetting("baseThickness", 0);
  const aoStrength = window.__demStudioHarness.setTerrainSetting("aoStrength", 1.1);
  const aoEnabled = window.__demStudioHarness.setTerrainSetting("aoEnabled", true);
  return JSON.stringify({
    heightScale,
    baseThickness,
    aoStrength,
    aoEnabled,
    checked: document.querySelector('[data-key="aoEnabled"]')?.checked,
    renderer: window.__demStudioHarness.getRendererDiagnostics()
  });
})()
'@
            returnByValue = $true
        }
        $settingsMutation = $settingsMutationResult.result.result.value | ConvertFrom-Json
        $settingsEnabled = $null
        for ($settingsAttempt = 0; $settingsAttempt -lt 30; $settingsAttempt += 1) {
            Start-Sleep -Milliseconds 200
            $settingsEnabledResult = Invoke-Cdp -Socket $socket -Id (24103 + $settingsAttempt) -Method "Runtime.evaluate" -Params @{
                expression = "JSON.stringify(window.__demStudioHarness.getRendererDiagnostics())"
                returnByValue = $true
            }
            $settingsEnabled = $settingsEnabledResult.result.result.value | ConvertFrom-Json
            if ($settingsEnabled.terrainRuntime.bounds.maximum -and
                $settingsEnabled.postProcessing.babylon.ssao2.active) {
                break
            }
        }

        $null = Invoke-Cdp -Socket $socket -Id 24140 -Method "Runtime.evaluate" -Params @{
            expression = "window.__demStudioHarness.setTerrainSetting('aoEnabled', false)"
            returnByValue = $true
        }
        Start-Sleep -Milliseconds 350
        $settingsDisabledResult = Invoke-Cdp -Socket $socket -Id 24141 -Method "Runtime.evaluate" -Params @{
            expression = "JSON.stringify(window.__demStudioHarness.getRendererDiagnostics())"
            returnByValue = $true
        }
        $settingsDisabled = $settingsDisabledResult.result.result.value | ConvertFrom-Json

        $detailBeforeGeneration = [long]$settingsDisabled.terrainBuildGeneration
        $null = Invoke-Cdp -Socket $socket -Id 24142 -Method "Runtime.evaluate" -Params @{
            expression = "window.__demStudioHarness.setTerrainSetting('detailShapingEnabled', false)"
            returnByValue = $true
        }
        $null = Invoke-Cdp -Socket $socket -Id 24143 -Method "Runtime.evaluate" -Params @{
            expression = "window.__demStudioHarness.setTerrainSetting('detailShapingStrength', 0.85)"
            returnByValue = $true
        }
        $null = Invoke-Cdp -Socket $socket -Id 24144 -Method "Runtime.evaluate" -Params @{
            expression = "window.__demStudioHarness.setTerrainSetting('detailShapingEnabled', true)"
            returnByValue = $true
        }
        Start-Sleep -Milliseconds 350
        $detailEnabledResult = Invoke-Cdp -Socket $socket -Id 24145 -Method "Runtime.evaluate" -Params @{
            expression = "JSON.stringify(window.__demStudioHarness.getRendererDiagnostics())"
            returnByValue = $true
        }
        $detailEnabled = $detailEnabledResult.result.result.value | ConvertFrom-Json
        $terrainPlugin = $detailEnabled.terrainRuntime.subMeshes[0].terrainPlugin
        $detailShapingEffective =
            [Math]::Abs([double]$terrainPlugin.detailShapingStrength - 0.85) -lt 0.001
        $detailShapingAvoidsRebuild =
            [long]$detailEnabled.terrainBuildGeneration -eq $detailBeforeGeneration

        $heightEffective =
            [double]$settingsEnabled.terrainRuntime.bounds.maximum[1] -gt
            ([double]$settingsBefore.terrainRuntime.bounds.maximum[1] * 1.8)
        $zeroBaseThicknessApplied =
            [Math]::Abs([double]$settingsMutation.baseThickness) -lt 0.000001
        $aoEnabledEffective =
            [bool]$settingsEnabled.postProcessing.babylon.ssao2.active -and
            [Math]::Abs(
                [double]$settingsEnabled.postProcessing.babylon.ssao2.strength -
                (0.72 * (1.0 - [Math]::Exp(-1.35 * 1.1)))
            ) -lt 0.01
        $aoDisabledEffective =
            [Math]::Abs(
                [double]$settingsDisabled.postProcessing.babylon.ssao2.strength
            ) -lt 0.000001
        $terrainSettingsState = [ordered]@{
            passed =
                $heightEffective -and
                $zeroBaseThicknessApplied -and
                $aoEnabledEffective -and
                $aoDisabledEffective -and
                $detailShapingEffective -and
                $detailShapingAvoidsRebuild -and
                [bool]$textureAppearance.strengthEffective -and
                [bool]$textureAppearance.colorEffective
            heightEffective = $heightEffective
            heightBefore = $settingsBefore.terrainRuntime.bounds.maximum[1]
            heightAfter = $settingsEnabled.terrainRuntime.bounds.maximum[1]
            zeroBaseThicknessApplied = $zeroBaseThicknessApplied
            aoEnabledEffective = $aoEnabledEffective
            aoDisabledEffective = $aoDisabledEffective
            aoStrength = $settingsEnabled.postProcessing.babylon.ssao2.strength
            detailShapingEffective = $detailShapingEffective
            detailShapingStrength = $terrainPlugin.detailShapingStrength
            detailShapingAvoidsRebuild = $detailShapingAvoidsRebuild
            textureStrengthEffective = [bool]$textureAppearance.strengthEffective
            textureColorEffective = [bool]$textureAppearance.colorEffective
        }
        Write-Output "TERRAIN_SETTINGS=$($terrainSettingsState | ConvertTo-Json -Depth 8 -Compress)"
        if (-not $terrainSettingsState.passed) {
            throw "Babylon terrain setting runtime effect probe failed."
        }
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

    Start-Sleep -Milliseconds 500
    if ($FileBackedProbe) {
        # Preset/camera probes can legitimately invalidate the tile selection.
        # Wait for the replacement selection to settle before asserting the
        # final geometry; a fixed 500 ms delay races real file-backed DEMs.
        $finalDatasetState = $null
        for ($finalAttempt = 0; $finalAttempt -lt 480; $finalAttempt += 1) {
            $finalDatasetResult = Invoke-Cdp -Socket $socket -Id (2059 + $finalAttempt) -Method "Runtime.evaluate" -Params @{
                expression = "(async () => JSON.stringify(await window.__demStudioHarness.getDatasetState()))()"
                awaitPromise = $true
                returnByValue = $true
            }
            if ($finalDatasetResult.result.exceptionDetails) {
                throw ($finalDatasetResult.result.exceptionDetails.text)
            }
            $finalDatasetState = $finalDatasetResult.result.result.value | ConvertFrom-Json
            $finalRootCoverageReady = $finalDatasetState.streamingLod.rootCoverageExact -and
                $finalDatasetState.streamingLod.rootBaseRequired -and
                $finalDatasetState.streamingLod.rootBasePreserved
            $finalStreamingReady =
                -not $finalDatasetState.streamingLod.enabled -or (
                    -not $finalDatasetState.focusLodActive -and
                    $finalDatasetState.streamingLod.coverageComplete -and
                    -not $finalDatasetState.streamingLod.rootTopVisible -and
                    $finalDatasetState.streamingLod.rootTopIndexCount -eq 0 -and
                    $finalRootCoverageReady -and
                    $finalDatasetState.streamingLod.pendingRequestCount -eq 0 -and
                    $finalDatasetState.streamingLod.queuedRequestCount -eq 0 -and
                    $finalDatasetState.streamingLod.queuedUploadCount -eq 0
                )
            if ($finalStreamingReady) {
                break
            }
            Start-Sleep -Milliseconds 250
        }
        Write-Output "FILE_BACKED_FINAL_STATE=$($finalDatasetState | ConvertTo-Json -Depth 6 -Compress)"
        $finalRootCoverageExact = $finalDatasetState.streamingLod.rootCoverageExact -and
            $finalDatasetState.streamingLod.rootBaseRequired -and
            $finalDatasetState.streamingLod.rootBasePreserved
        if ($finalDatasetState.streamingLod.enabled -and (
            $finalDatasetState.focusLodActive -or
            -not $finalDatasetState.streamingLod.coverageComplete -or
            $finalDatasetState.streamingLod.rootTopVisible -or
            $finalDatasetState.streamingLod.rootTopIndexCount -ne 0 -or
            $finalDatasetState.streamingLod.expectedBaseIndexCount -le 0 -or
            -not $finalRootCoverageExact -or
            -not $finalDatasetState.streamingLod.rootIndexExact -or
            $finalDatasetState.streamingLod.rootIndexCount -ne $finalDatasetState.streamingLod.rootGroupIndexCount -or
            $finalDatasetState.streamingLod.readyDesiredHorizonVertexCount -ne $finalDatasetState.streamingLod.readyDesiredVertexCount -or
            $finalDatasetState.streamingLod.readyDesiredHorizonSourceCount -ne $finalDatasetState.streamingLod.readyDesiredCount -or
            $finalDatasetState.streamingLod.pendingRequestCount -ne 0 -or
            $finalDatasetState.streamingLod.queuedRequestCount -ne 0 -or
            $finalDatasetState.streamingLod.queuedUploadCount -ne 0
        )) {
            throw "File-backed DEM final streaming geometry assertion failed."
        }
        if ($finalDatasetState.focusLodActive -and (
            -not $finalDatasetState.focusTopology.rootIndexExact -or
            $finalDatasetState.focusTopology.indexCount -ne $finalDatasetState.focusTopology.expectedIndexCount
        )) {
            throw "File-backed DEM final topology assertion failed."
        }
    }

    $capture = Invoke-Cdp -Socket $socket -Id 60 -Method "Page.captureScreenshot" -Params @{
        format = "png"
        captureBeyondViewport = $false
    }
    $resolvedScreenshot = Resolve-OutputPath -Path $Screenshot
    [System.IO.File]::WriteAllBytes(
        $resolvedScreenshot,
        [Convert]::FromBase64String($capture.result.data)
    )

    if ($MaxFirstFrameMilliseconds -gt 0 -and
        [double]$performanceStages.firstFrameMs -gt $MaxFirstFrameMilliseconds) {
        throw "First frame $($performanceStages.firstFrameMs) ms exceeds $MaxFirstFrameMilliseconds ms."
    }
    Write-Output "PERFORMANCE_STAGES=$($performanceStages | ConvertTo-Json -Compress)"
    Measure-DemStudioMemory -Stage "final"
    if ($MaxProcessTreeWorkingSetBytes -gt 0) {
        if (-not $memoryAggregationAvailable) {
            throw "Process-tree memory aggregation is unavailable."
        }
        if ($peakProcessTreeWorkingSetBytes -gt $MaxProcessTreeWorkingSetBytes) {
            throw "Process-tree working set $peakProcessTreeWorkingSetBytes exceeds $MaxProcessTreeWorkingSetBytes bytes."
        }
    }
    $process.Refresh()
    Write-Output "PARENT_PEAK_WORKING_SET_BYTES=$($process.PeakWorkingSet64)"
    Write-Output "MEMORY_AGGREGATION_AVAILABLE=$memoryAggregationAvailable"
    Write-Output "PEAK_WORKING_SET_BYTES=$peakProcessTreeWorkingSetBytes"
    Write-Output "PROCESS_TREE_PEAK_OBSERVED_WORKING_SET_BYTES=$peakProcessTreeWorkingSetBytes"
    Write-Output "WEBVIEW2_PEAK_OBSERVED_WORKING_SET_BYTES=$peakWebView2WorkingSetBytes"
    $elapsedSeconds = [Math]::Round(([DateTime]::UtcNow - $startedAt).TotalSeconds, 2)
    Write-Output "ELAPSED_SECONDS=$elapsedSeconds"
    if ($SummaryJson) {
        $resolvedSummaryJson = [System.IO.Path]::GetFullPath($SummaryJson)
        $summaryDirectory = [System.IO.Path]::GetDirectoryName($resolvedSummaryJson)
        if ($summaryDirectory) {
            [System.IO.Directory]::CreateDirectory($summaryDirectory) | Out-Null
        }
        $runtimeSummary = [ordered]@{
            schema = "dem-studio-runtime-smoke-v1"
            verdict = "PASS"
            utc = [DateTime]::UtcNow.ToString("o")
            executable = $resolvedExecutable
            executableSha256 = (Get-FileHash -LiteralPath $resolvedExecutable -Algorithm SHA256).Hash
            fixture = $resolvedFixture
            fixtureSha256 = (Get-FileHash -LiteralPath $resolvedFixture -Algorithm SHA256).Hash
            renderer = $rendererBackendState
            harnessConfiguration = [ordered]@{
                requestedRendererBackend = $RendererBackend
                forcedWebGpuInitFailure = [bool]$ForceWebGpuInitFailure
                expectedLodTargetDimension = $ExpectedLodTargetDimension
                expectedMinimumReadyVertices = $ExpectedMinimumReadyVertices
                expectedReadyTriangles = $ExpectedReadyTriangles
                expectedMinimumTargetLevelTiles = $ExpectedMinimumTargetLevelTiles
                terrainStabilitySeconds = $TerrainStabilitySeconds
                refinementCacheProbe = [bool]$RefinementCacheProbe
                memoryTrendProbe = [bool]$MemoryTrendProbe
                minimumViewportChanges = $MinimumViewportChanges
                maxProcessTreeWorkingSetBytes = $MaxProcessTreeWorkingSetBytes
                performanceProbe = [bool]$PerformanceProbe
                frameSampleMilliseconds = $FrameSampleMilliseconds
                minP95Fps = $MinP95Fps
                maxP99FrameMilliseconds = $MaxP99FrameMilliseconds
                maxFrameMilliseconds = $MaxFrameMilliseconds
                maxLongTaskCount = $MaxLongTaskCount
                memorySampling = "observed-process-tree-working-set"
            }
            performanceStages = $performanceStages
            interaction = $frameState
            whiteInteraction = $whitePerformance
            overview = $overviewState
            settled = $focusState
            terrainStability = $terrainStabilityState
            refinementCacheReturn = $refinementCacheProbeState
            memoryTrend = $memoryTrendState
            final = $finalDatasetState
            memory = [ordered]@{
                aggregationAvailable = $memoryAggregationAvailable
                parentPeakWorkingSetBytes = $process.PeakWorkingSet64
                processTreePeakWorkingSetBytes = $peakProcessTreeWorkingSetBytes
                webView2PeakWorkingSetBytes = $peakWebView2WorkingSetBytes
            }
            elapsedSeconds = $elapsedSeconds
            screenshots = [ordered]@{
                final = [System.IO.Path]::GetFullPath($Screenshot)
                settled = if ($FocusScreenshot) {
                    [System.IO.Path]::GetFullPath($FocusScreenshot)
                } else {
                    $null
                }
            }
        }
        [System.IO.File]::WriteAllText(
            $resolvedSummaryJson,
            ($runtimeSummary | ConvertTo-Json -Depth 12),
            [System.Text.UTF8Encoding]::new($false)
        )
        Write-Output "SUMMARY_JSON=$resolvedSummaryJson"
    }
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
    if (-not $SeedRecentOnly) {
        $smokeStore = Join-Path $env:APPDATA "studio.dem.desktop.smoke.v2\dem-studio.json"
        if (Test-Path -LiteralPath $smokeStore) {
            Remove-Item -LiteralPath $smokeStore -Force
        }
    }
}
