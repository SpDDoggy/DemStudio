param(
    [string]$Executable = (Join-Path $PSScriptRoot "..\src-tauri\target\perf\release\dem-studio.exe"),
    [string]$Fixture = (Join-Path $PSScriptRoot "..\artifacts\perf-fixtures\perf-100m-mountain-f32-deflate-tiled.tif"),
    [int]$SoakMinutes = 15
)

$ErrorActionPreference = "Stop"
$continuousInteractionMilliseconds = [Math]::Max(60000, $SoakMinutes * 60 * 1000)
& (Join-Path $PSScriptRoot "perf-100m-release.ps1") `
    -Executable $Executable `
    -Fixture $Fixture `
    -Runs 1 `
    -SoakMinutes 0 `
    -FrameSampleMilliseconds $continuousInteractionMilliseconds `
    -MinP95Fps 55 `
    -MaxFirstFrameMilliseconds 2000 `
    -MaxProcessTreeWorkingSetMiB 1536
exit $LASTEXITCODE
