param(
    [switch]$BundleNsis
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$tauriCli = Join-Path $projectRoot "node_modules\@tauri-apps\cli\tauri.js"

if (-not (Test-Path -LiteralPath $tauriCli -PathType Leaf)) {
    throw "Tauri CLI is missing: $tauriCli"
}

Push-Location $projectRoot
try {
    $buildArguments = @("--preserve-symlinks-main", $tauriCli, "build")
    if ($BundleNsis) {
        $buildArguments += @("--bundles", "nsis")
    }
    else {
        $buildArguments += "--no-bundle"
    }

    & node @buildArguments
    if ($LASTEXITCODE -ne 0) {
        throw "Tauri production build failed with exit code $LASTEXITCODE."
    }

    & powershell -NoProfile -ExecutionPolicy Bypass -File `
        (Join-Path $PSScriptRoot "..\verify\verify-release-exe.ps1")
    if ($LASTEXITCODE -ne 0) {
        throw "Release EXE verification failed with exit code $LASTEXITCODE."
    }
}
finally {
    Pop-Location
}
