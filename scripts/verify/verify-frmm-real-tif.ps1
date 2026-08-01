param(
    [string]$TifPath = (
        "F:\BaiduNetdiskDownload\" +
        (-join [char[]]@(0x897F, 0x5357, 0x6218, 0x533A)) + "\" +
        (-join [char[]]@(0x6EC7, 0x5357)) +
        "\FRMM_EarthPrinter_DN_PREC_2024.tif"
    ),
    [string]$Executable = (Join-Path $PSScriptRoot "..\..\src-tauri\target\perf\release\dem-studio.exe"),
    [string]$EvidenceDirectory = (Join-Path $PSScriptRoot "..\..\artifacts\real-tif-regression"),
    [ValidateSet(1024, 2048, 4096)]
    [int[]]$Dimensions = @(1024, 2048, 4096),
    [switch]$Performance1024,
    [switch]$Soak1024,
    [ValidateRange(0, 300)]
    [int]$TerrainStability1024Seconds = 60
)

$ErrorActionPreference = "Stop"

$resolvedTif = (Resolve-Path -LiteralPath $TifPath).Path
$resolvedExecutable = (Resolve-Path -LiteralPath $Executable).Path
$expectedHash = "EB5FEDDF70C0333629DF6BC622A9B001379278F372884B90B7C9D547E7A721BC"
$actualHash = (Get-FileHash -LiteralPath $resolvedTif -Algorithm SHA256).Hash
if ($actualHash -ne $expectedHash) {
    throw "Real GeoTIFF fixture hash mismatch: expected $expectedHash, actual $actualHash."
}

foreach ($suffix in @(".ovr", ".aux.xml")) {
    $sidecar = "$resolvedTif$suffix"
    if (-not (Test-Path -LiteralPath $sidecar -PathType Leaf)) {
        throw "Required exact sidecar is missing: $sidecar"
    }
}

New-Item -ItemType Directory -Path $EvidenceDirectory -Force | Out-Null
$runtimeSmoke = Join-Path $PSScriptRoot "runtime-smoke.ps1"
$pwshExecutable = (Get-Process -Id $PID).Path
$qualityCases = @(
    [pscustomobject]@{
        Dimension = 1024
        MinimumVertices = 650000
        Triangles = 750000
        MinimumTargetTiles = 0
        MaximumDecodedChunks = 256
        TerrainStabilitySeconds = $TerrainStability1024Seconds
        DebugPort = 9457
    },
    [pscustomobject]@{
        Dimension = 2048
        MinimumVertices = 650000
        Triangles = 750000
        MinimumTargetTiles = 40
        MaximumDecodedChunks = 1024
        TerrainStabilitySeconds = 0
        DebugPort = 9457
    },
    [pscustomobject]@{
        Dimension = 4096
        MinimumVertices = 650000
        Triangles = 750000
        MinimumTargetTiles = 3
        MaximumDecodedChunks = 1024
        TerrainStabilitySeconds = 0
        DebugPort = 9457
    }
)

foreach ($qualityCase in @($qualityCases | Where-Object { $_.Dimension -in $Dimensions })) {
    $soakProbe = $Soak1024 -and $qualityCase.Dimension -eq 1024
    $performanceProbe = (
        ($Performance1024 -or $Soak1024) -and
        $qualityCase.Dimension -eq 1024
    )
    $frameSampleMilliseconds = if ($soakProbe) { 900000 } else { 60000 }
    $caseDirectory = Join-Path $EvidenceDirectory ([string]$qualityCase.Dimension)
    New-Item -ItemType Directory -Path $caseDirectory -Force | Out-Null
    $runtimeLog = Join-Path $caseDirectory "runtime.log"
    $summaryJson = Join-Path $caseDirectory "summary.json"
    $runtimeArguments = @(
        "-Executable", $resolvedExecutable,
        "-Fixture", $resolvedTif,
        "-Screenshot", (Join-Path $caseDirectory "final.png"),
        "-FocusScreenshot", (Join-Path $caseDirectory "settled.png"),
        "-ExpectedName", "FRMM_EarthPrinter_DN_PREC_2024.tif",
        "-ExpectedType", "GeoTIFF",
        "-ExpectedSizePattern", "^31,984\s+\D\s+18,495$",
        "-FileBackedProbe",
        "-ExpectedOverviewCols", 128,
        "-ExpectedOverviewRows", 74,
        "-ExpectedOverviewValidCount", 3447,
        "-ExpectedOverviewMaskHash", 986830350,
        "-ExpectedMinimum", 622,
        "-ExpectedMaximum", 2239,
        "-ExpectedLodTargetDimension", $qualityCase.Dimension,
        "-ExpectedMinimumReadyVertices", $qualityCase.MinimumVertices,
        "-ExpectedReadyTriangles", $qualityCase.Triangles,
        "-ExpectedMinimumTargetLevelTiles", $qualityCase.MinimumTargetTiles,
        "-TerrainStabilitySeconds", $qualityCase.TerrainStabilitySeconds,
        "-MinimumViewportChanges", 200,
        "-FrameSampleMilliseconds", $frameSampleMilliseconds,
        "-MinP95Fps", 59.88,
        "-MaxP99FrameMilliseconds", 25,
        "-MaxFrameMilliseconds", 50,
        "-MaxLongTaskCount", 0,
        "-MaxProcessTreeWorkingSetBytes", 1610612736,
        "-SummaryJson", $summaryJson,
        "-DebugPort", $qualityCase.DebugPort
    )
    if ($qualityCase.Dimension -eq 1024) {
        $runtimeArguments += "-CameraControlProbe"
        $runtimeArguments += "-TerrainSettingsProbe"
    }
    if ($qualityCase.Dimension -gt 1024) {
        $runtimeArguments += "-RefinementCacheProbe"
    }
    if ($performanceProbe) {
        $runtimeArguments += "-PerformanceProbe"
    }
    if ($soakProbe) {
        $runtimeArguments += "-MemoryTrendProbe"
    }

    & $pwshExecutable -NoProfile -File $runtimeSmoke @runtimeArguments *>&1 |
        Tee-Object -FilePath $runtimeLog

    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }

    $summary = Get-Content -LiteralPath $summaryJson -Raw | ConvertFrom-Json
    $coreStats = $summary.final.coreStats
    if ($null -eq $coreStats) {
        throw "Real GeoTIFF summary omitted final Core cache statistics."
    }
    if ([int64]$coreStats.chunkCacheDecodedChunks -gt $qualityCase.MaximumDecodedChunks) {
        throw (
            "OVR-aware sampling regression at LOD {0}: decoded {1} chunks, maximum {2}." -f
            $qualityCase.Dimension,
            $coreStats.chunkCacheDecodedChunks,
            $qualityCase.MaximumDecodedChunks
        )
    }
    if ([int64]$coreStats.chunkCacheEvictions -ne 0) {
        throw (
            "OVR-aware sampling cache thrashed at LOD {0}: {1} evictions." -f
            $qualityCase.Dimension,
            $coreStats.chunkCacheEvictions
        )
    }
}
