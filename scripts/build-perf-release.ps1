param(
    [string]$TargetDirectory = (Join-Path $PSScriptRoot "..\src-tauri\target\perf")
)

$ErrorActionPreference = "Stop"
$resolvedTarget = [System.IO.Path]::GetFullPath($TargetDirectory)
$projectRoot = Split-Path -Parent $PSScriptRoot
$viteCli = Join-Path $projectRoot "node_modules\vite\bin\vite.js"
$tauriCli = Join-Path $projectRoot "node_modules\@tauri-apps\cli\tauri.js"
$previousTarget = $env:CARGO_TARGET_DIR
try {
    $env:CARGO_TARGET_DIR = $resolvedTarget
    & node --preserve-symlinks-main $viteCli build
    if ($LASTEXITCODE -ne 0) { throw "Vite production build failed." }
    & node --preserve-symlinks-main $tauriCli build --no-bundle --config src-tauri/tauri.smoke.conf.json
    if ($LASTEXITCODE -ne 0) { throw "Optimized performance Release build failed." }
}
finally {
    if ($null -eq $previousTarget) {
        Remove-Item Env:CARGO_TARGET_DIR -ErrorAction SilentlyContinue
    }
    else {
        $env:CARGO_TARGET_DIR = $previousTarget
    }
}
$executable = Join-Path $resolvedTarget "release\dem-studio.exe"
if (-not [System.IO.File]::Exists($executable)) {
    throw "Performance Release executable was not produced: $executable"
}
& powershell -NoProfile -ExecutionPolicy Bypass -File `
    (Join-Path $PSScriptRoot "verify-release-exe.ps1") -ExePath $executable
if ($LASTEXITCODE -ne 0) {
    throw "Performance Release EXE verification failed with exit code $LASTEXITCODE."
}
$bytes = [System.IO.File]::ReadAllBytes($executable)
$sha256 = [System.Security.Cryptography.SHA256]::Create()
try {
    $hashBytes = $sha256.ComputeHash($bytes)
    $hash = [System.BitConverter]::ToString($hashBytes).Replace("-", "")
}
finally {
    $sha256.Dispose()
}
Write-Output "PERF_RELEASE_EXE=$executable"
Write-Output "PERF_RELEASE_SHA256=$hash"
