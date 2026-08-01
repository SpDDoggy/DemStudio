param(
    [string]$Executable = (Join-Path $PSScriptRoot "..\..\src-tauri\target\perf\release\dem-studio.exe"),
    [string]$Fixture = (Join-Path $PSScriptRoot "..\..\artifacts\perf-fixtures\perf-100m-mountain-f32-deflate-tiled.tif"),
    [string]$EvidenceDirectory = (Join-Path $PSScriptRoot "..\..\artifacts\perf-evidence"),
    [ValidateRange(1, 20)]
    [int]$Runs = 3,
    [ValidateRange(0, 1440)]
    [int]$SoakMinutes = 0,
    [ValidateRange(1000, 900000)]
    [int]$FrameSampleMilliseconds = 15000,
    [ValidateRange(1, 240)]
    [double]$MinP95Fps = 55,
    [ValidateRange(1, 600000)]
    [double]$MaxFirstFrameMilliseconds = 2000,
    [ValidateRange(1, 32768)]
    [int]$MaxProcessTreeWorkingSetMiB = 1536,
    [int]$DebugPortBase = 9333
)

$ErrorActionPreference = "Stop"

function Get-PrefixedJson {
    param([string[]]$Lines, [string]$Prefix)
    $line = $Lines | Where-Object { $_ -like "$Prefix*" } | Select-Object -Last 1
    if (-not $line) {
        throw "Missing runtime evidence line: $Prefix"
    }
    return $line.Substring($Prefix.Length) | ConvertFrom-Json
}

function Get-PrefixedInt64 {
    param([string[]]$Lines, [string]$Prefix)
    $line = $Lines | Where-Object { $_ -like "$Prefix*" } | Select-Object -Last 1
    if (-not $line) {
        throw "Missing runtime evidence line: $Prefix"
    }
    return [long]$line.Substring($Prefix.Length)
}

$resolvedExecutable = [System.IO.Path]::GetFullPath($Executable)
$resolvedFixture = [System.IO.Path]::GetFullPath($Fixture)
$releaseSegment = [System.IO.Path]::DirectorySeparatorChar + "release" + [System.IO.Path]::DirectorySeparatorChar
if (-not [System.IO.File]::Exists($resolvedExecutable)) {
    throw "Release executable not found: $resolvedExecutable"
}
if ($resolvedExecutable.IndexOf($releaseSegment, [System.StringComparison]::OrdinalIgnoreCase) -lt 0 -or
    $resolvedExecutable.IndexOf("\debug\", [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
    throw "Performance evidence must use target/release, never a debug executable: $resolvedExecutable"
}
if (-not [System.IO.File]::Exists($resolvedFixture)) {
    throw "100M fixture not found: $resolvedFixture"
}

$timestamp = [DateTime]::UtcNow.ToString("yyyyMMdd-HHmmss")
$runDirectory = Join-Path ([System.IO.Path]::GetFullPath($EvidenceDirectory)) $timestamp
[System.IO.Directory]::CreateDirectory($runDirectory) | Out-Null
$fixtureVerificationPath = Join-Path $runDirectory "fixture-verification.json"
& python (Join-Path $PSScriptRoot "verify-perf-fixture.py") $resolvedFixture `
    --expected-width 10000 --expected-height 10000 --json-output $fixtureVerificationPath | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw "Independent 100M fixture verification failed."
}
$fixtureVerification = Get-Content -Raw $fixtureVerificationPath | ConvertFrom-Json
if (-not $fixtureVerification.passed -or
    $fixtureVerification.actual.width -ne 10000 -or
    $fixtureVerification.actual.height -ne 10000) {
    throw "SOURCE_100M fixture gate failed."
}

$executableHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $resolvedExecutable).Hash
$fixtureHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $resolvedFixture).Hash
$hardware = [ordered]@{}
try {
    $computer = Get-CimInstance Win32_ComputerSystem
    $processor = Get-CimInstance Win32_Processor | Select-Object -First 1
    $hardware.ramBytes = [long]$computer.TotalPhysicalMemory
    $hardware.cpu = [string]$processor.Name
    $hardware.cores = [int]$processor.NumberOfCores
    $hardware.logicalProcessors = [int]$processor.NumberOfLogicalProcessors
} catch {
    $hardware.error = $_.Exception.Message
}

$results = [System.Collections.Generic.List[object]]::new()
$startedAt = [DateTime]::UtcNow
$minimumRuns = [Math]::Max(1, $Runs)
$runIndex = 0
do {
    $runIndex += 1
    $debugPort = $DebugPortBase
    for ($portAttempt = 0; $portAttempt -lt 80; $portAttempt += 1) {
        $activeTarget = $null
        try {
            $activeTarget = @(Invoke-RestMethod -Uri "http://127.0.0.1:$debugPort/json" -TimeoutSec 1) |
                Where-Object { $_.type -eq "page" -and $_.title -eq "DEM Studio" } |
                Select-Object -First 1
        }
        catch {
        }
        if (-not $activeTarget) { break }
        Start-Sleep -Milliseconds 250
    }
    if ($activeTarget) {
        throw "Remote-debug target on port $debugPort did not close before run $runIndex."
    }
    $rawLog = Join-Path $runDirectory ("run-{0:D3}.log" -f $runIndex)
    $screenshot = Join-Path $runDirectory ("run-{0:D3}.png" -f $runIndex)
    $focusScreenshot = Join-Path $runDirectory ("run-{0:D3}-focus.png" -f $runIndex)
    $arguments = @(
        "-NoProfile", "-ExecutionPolicy", "Bypass",
        "-File", (Join-Path $PSScriptRoot "..\verify\runtime-smoke.ps1"),
        "-Executable", $resolvedExecutable,
        "-Fixture", $resolvedFixture,
        "-Screenshot", $screenshot,
        "-FocusScreenshot", $focusScreenshot,
        "-DebugPort", $debugPort,
        "-ExpectedName", [System.IO.Path]::GetFileName($resolvedFixture),
        "-ExpectedType", "GeoTIFF",
        "-ExpectedSizePattern", "^10,000\s+\D\s+10,000$",
        "-FileBackedProbe",
        "-PerformanceProbe",
        "-FrameSampleMilliseconds", $FrameSampleMilliseconds,
        "-MinP95Fps", $MinP95Fps,
        "-MaxFirstFrameMilliseconds", $MaxFirstFrameMilliseconds
    )
    $savedErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $lines = @(& powershell @arguments 2>&1 | ForEach-Object { "$_" })
        $runtimeExitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $savedErrorActionPreference
    }
    [System.IO.File]::WriteAllLines($rawLog, $lines, [System.Text.UTF8Encoding]::new($false))
    if ($runtimeExitCode -ne 0) {
        throw "Runtime performance run $runIndex failed. See $rawLog"
    }

    $overview = Get-PrefixedJson $lines "FILE_BACKED_OVERVIEW="
    $focus = Get-PrefixedJson $lines "FILE_BACKED_FOCUS_LOD="
    $frame = Get-PrefixedJson $lines "FRAME_STATS="
    $stages = Get-PrefixedJson $lines "PERFORMANCE_STAGES="
    $peakWorkingSet = Get-PrefixedInt64 $lines "PROCESS_TREE_PEAK_OBSERVED_WORKING_SET_BYTES="
    $gpuRenderer = [string]$frame.gpuRenderer
    $sourceGate = $overview.width -eq 10000 -and $overview.height -eq 10000 -and
        $overview.rawLength -eq 0 -and $overview.engine -eq "rust-dem-core-v2" -and
        $overview.coreStats.datasetCount -eq 1 -and $overview.coreStats.fileBackedCount -eq 1
    $firstFrameGate = [double]$stages.firstFrameMs -le $MaxFirstFrameMilliseconds -and
        [System.IO.File]::Exists($screenshot) -and (Get-Item -LiteralPath $screenshot).Length -gt 10000
    $streaming = $focus.streamingLod
    $lodGate = [bool]$streaming.enabled -and $streaming.requested -gt 0 -and
        $streaming.completed -gt 0 -and $streaming.uploaded -gt 0 -and
        $streaming.activeMeshCount -gt 0 -and
        $streaming.cacheBytes -le $streaming.cacheBudgetBytes -and
        $streaming.gpuBytes -le $streaming.gpuBudgetBytes -and
        $streaming.requestConcurrencyBudget -le 4
    $interactionGate = $frame.source -eq "window-harness-interaction" -and
        $frame.harnessReader -eq "runInteractionPerformanceProbe" -and
        [double]$frame.p95Fps -ge $MinP95Fps -and $frame.frameCount -ge 100
    $gpuGate = -not [string]::IsNullOrWhiteSpace($gpuRenderer) -and
        $gpuRenderer -notmatch "SwiftShader|llvmpipe|software"
    $memoryGate = $peakWorkingSet -gt 0 -and
        $peakWorkingSet -le ([long]$MaxProcessTreeWorkingSetMiB * 1MB)

    $result = [ordered]@{
        run = $runIndex
        utc = [DateTime]::UtcNow.ToString("o")
        SOURCE_100M = $sourceGate
        FIRST_MEANINGFUL_FRAME = $firstFrameGate
        LOD_STREAMING = $lodGate
        INTERACTION = ($interactionGate -and $gpuGate)
        MEMORY = $memoryGate
        firstFrameMs = [double]$stages.firstFrameMs
        focusLodMs = [double]$stages.focusLodMs
        streamingLod = $streaming
        p95Fps = [double]$frame.p95Fps
        p95FrameMs = [double]$frame.p95FrameMs
        gpuRenderer = $gpuRenderer
        peakProcessTreeWorkingSetBytes = $peakWorkingSet
        rawLog = $rawLog
        screenshot = $screenshot
        focusScreenshot = $focusScreenshot
    }
    $results.Add([pscustomobject]$result)
    $resultPath = Join-Path $runDirectory ("run-{0:D3}.json" -f $runIndex)
    [System.IO.File]::WriteAllText(
        $resultPath,
        (($result | ConvertTo-Json -Depth 8) + [Environment]::NewLine),
        [System.Text.UTF8Encoding]::new($false)
    )
    if (-not ($sourceGate -and $firstFrameGate -and $lodGate -and $interactionGate -and $gpuGate -and $memoryGate)) {
        throw "One or more 100M hard gates failed in run $runIndex. See $resultPath"
    }
    $soakIncomplete = $SoakMinutes -gt 0 -and
        ([DateTime]::UtcNow - $startedAt).TotalMinutes -lt $SoakMinutes
} while ($runIndex -lt $minimumRuns -or $soakIncomplete)

$stabilityGate = $results.Count -ge $minimumRuns -and
    -not ($results | Where-Object {
        -not ($_.SOURCE_100M -and $_.FIRST_MEANINGFUL_FRAME -and $_.LOD_STREAMING -and $_.INTERACTION -and $_.MEMORY)
    })
$summary = [ordered]@{
    schema = "dem-studio-100m-performance-evidence-v1"
    verdict = if ($stabilityGate) { "PASS" } else { "FAIL" }
    gates = [ordered]@{
        SOURCE_100M = -not ($results | Where-Object { -not $_.SOURCE_100M })
        FIRST_MEANINGFUL_FRAME = -not ($results | Where-Object { -not $_.FIRST_MEANINGFUL_FRAME })
        LOD_STREAMING = -not ($results | Where-Object { -not $_.LOD_STREAMING })
        INTERACTION = -not ($results | Where-Object { -not $_.INTERACTION })
        MEMORY = -not ($results | Where-Object { -not $_.MEMORY })
        STABILITY = $stabilityGate
    }
    executable = $resolvedExecutable
    executableSha256 = $executableHash
    fixture = $resolvedFixture
    fixtureSha256 = $fixtureHash
    fixtureVerification = $fixtureVerificationPath
    hardware = $hardware
    thresholds = [ordered]@{
        minP95Fps = $MinP95Fps
        maxFirstFrameMilliseconds = $MaxFirstFrameMilliseconds
        maxProcessTreeWorkingSetMiB = $MaxProcessTreeWorkingSetMiB
        frameSampleMilliseconds = $FrameSampleMilliseconds
        requestedRuns = $Runs
        soakMinutes = $SoakMinutes
    }
    elapsedSeconds = [Math]::Round(([DateTime]::UtcNow - $startedAt).TotalSeconds, 3)
    runs = $results
}
$summaryPath = Join-Path $runDirectory "summary.json"
[System.IO.File]::WriteAllText(
    $summaryPath,
    (($summary | ConvertTo-Json -Depth 12) + [Environment]::NewLine),
    [System.Text.UTF8Encoding]::new($false)
)
Write-Output ($summary | ConvertTo-Json -Depth 12)
Write-Output "PERF_100M_EVIDENCE=$summaryPath"
if (-not $stabilityGate) {
    throw "STABILITY gate failed."
}
