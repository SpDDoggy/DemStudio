param(
    [string]$ExePath = ""
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if ([string]::IsNullOrWhiteSpace($ExePath)) {
    $ExePath = Join-Path $projectRoot "src-tauri\target\release\dem-studio.exe"
}

$resolvedExe = (Resolve-Path -LiteralPath $ExePath).Path
$bytes = [System.IO.File]::ReadAllBytes($resolvedExe)
$ascii = [System.Text.Encoding]::ASCII.GetString($bytes)
$utf16 = [System.Text.Encoding]::Unicode.GetString($bytes)
$decodedViews = @{
    ASCII = $ascii
    UTF16LE = $utf16
}
$forbiddenDevelopmentEntrypointPatterns = @(
    "https?://localhost(?::\d+)?",
    "https?://127(?:\.\d{1,3}){3}(?::\d+)?",
    "https?://0\.0\.0\.0(?::\d+)?",
    "https?://\[::1\](?::\d+)?"
)

foreach ($viewName in $decodedViews.Keys) {
    foreach ($pattern in $forbiddenDevelopmentEntrypointPatterns) {
        if ($decodedViews[$viewName] -match $pattern) {
            throw "Release gate failed: production EXE contains a $viewName development entrypoint matching '$pattern'."
        }
    }
}

if (-not $ascii.Contains("tauri://localhost")) {
    throw "Release gate failed: embedded Tauri production origin was not found."
}

$file = Get-Item -LiteralPath $resolvedExe
$sha256 = [System.Security.Cryptography.SHA256]::Create()
try {
    $hashBytes = $sha256.ComputeHash($bytes)
    $hash = [System.BitConverter]::ToString($hashBytes).Replace("-", "")
}
finally {
    $sha256.Dispose()
}
Write-Output "PASS release EXE contains no ASCII or UTF-16 loopback development entrypoint"
Write-Output "PASS embedded Tauri production origin is present"
Write-Output "EXE $($file.FullName)"
Write-Output "SIZE $($file.Length)"
Write-Output "SHA256 $hash"
