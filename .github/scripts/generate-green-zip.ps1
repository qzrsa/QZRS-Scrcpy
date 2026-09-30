# Package the green (portable-folder) build into a zip and verify key files are inside.
#
# Why a standalone .ps1 instead of an inline `powershell -Command "..."`
#   An inline command has to survive three parsing layers (bash double quotes ->
#   PowerShell string -> cmd tokenizer). Backslashes and quotes get eaten in ways
#   that cannot be reproduced reliably off the runner (this bit us once in CI).
#   As a file, PowerShell reads it directly -- no escaping layer at all.
#
# Why not Compress-Archive
#   It SILENTLY SKIPS files it cannot read and still produces a zip, so you get
#   "compression succeeded" with missing content. ZipFile::CreateFromDirectory
#   throws instead of pretending to succeed.
#
# NOTE: keep this file ASCII-only. PowerShell 5.1 decodes .ps1 without a BOM as
#   the system ANSI codepage; non-ASCII text gets mangled and can break string
#   terminators (observed: garbled Chinese + "string is missing the terminator").
#
# Usage: generate-green-zip.ps1 -DirName "QZRS Scrcpy 20260930003"
#        generate-green-zip.ps1 -DirName "QZRS Scrcpy 20260930003" -ZipName "QZRS-Scrcpy-Green-20260930003.zip"
#
# -ZipName overrides the output zip filename. Default is "<DirName>.zip".
#   We pass an explicit hyphenated name in CI because GitHub normalizes release
#   asset filenames -- spaces become dots (QZRS Scrcpy X.zip -> QZRS.Scrcpy.X.zip)
#   and action-gh-release cannot override the final download name.

param(
  [Parameter(Mandatory = $true)][string]$DirName,
  [string]$ZipName = ''
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem

if (-not (Test-Path -LiteralPath $DirName -PathType Container)) {
  throw "Green build directory not found: $DirName"
}

$zip = if ([string]::IsNullOrEmpty($ZipName)) { "$DirName.zip" } else { $ZipName }
if (Test-Path -LiteralPath $zip) { [IO.File]::Delete($zip) }

# Archive the directory CONTENTS at the zip root (no wrapping folder),
# so extracting shows QZRS Scrcpy.exe immediately.
[IO.Compression.ZipFile]::CreateFromDirectory(
  (Resolve-Path -LiteralPath $DirName).Path,
  (Join-Path (Get-Location).Path $zip),
  [IO.Compression.CompressionLevel]::Optimal,
  $false # includeBaseDirectory = false
)

if (-not (Test-Path -LiteralPath $zip)) { throw "zip was not created: $zip" }

$sizeMB = [math]::Round((Get-Item -LiteralPath $zip).Length / 1MB, 1)
Write-Host "created $zip  ($sizeMB MB)"

# ---- Verify ----
# Normalize '\' to '/' before comparing so a separator difference cannot
# produce a false negative.
$archive = [IO.Compression.ZipFile]::OpenRead((Resolve-Path -LiteralPath $zip).Path)
try {
  $names = @($archive.Entries | ForEach-Object { $_.FullName.Replace('\', '/') })
} finally {
  $archive.Dispose()
}

$need = @(
  'QZRS Scrcpy.exe',
  'resources/app.asar',
  'resources/scrcpy-server',
  'resources/adb/adb.exe',
  'resources/scrcpy/scrcpy.exe'
)

$miss = @($need | Where-Object { $names -notcontains $_ })

Write-Host "entries = $($names.Count)"
if ($miss.Count -gt 0) {
  Write-Host "missing: $($miss -join ', ')"
  Write-Host 'first 20 entries actually present:'
  $names | Select-Object -First 20 | ForEach-Object { Write-Host "   [$_]" }
  throw "zip verification failed: $($miss.Count) required file(s) missing"
}
Write-Host 'zip verification PASSED'
