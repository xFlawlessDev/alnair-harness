# Alnair local installer (Windows x86_64) - installs a LOCALLY BUILT artifact.
#
# This is the offline counterpart to install.ps1: it never touches the network.
# It takes the archive produced by `cargo build --profile release-dist` (see
# docs/RELEASE.md), verifies it against the SHA256SUMS manifest beside it, and
# installs into the SAME managed layout the self-updater maintains:
#
#   <home>\downloads\alnair-<version>-windows-x86_64.exe   versioned copy
#   <home>\bin\alnair.exe                                  active binary
#
# Because the layout matches, `alnair update` takes over from a local install
# without knowing it was installed by hand.
#
# Usage:
#   pwsh scripts/install-local.ps1
#   pwsh scripts/install-local.ps1 -Archive dist/alnair-0.1.2-x86_64-pc-windows-msvc.zip
#   pwsh scripts/install-local.ps1 -AlnairHome C:\tmp\alnair-test
#
# Environment:
#   ALNAIR_SHARE_DIR   install root (default: %USERPROFILE%\.alnair)

[CmdletBinding()]
param(
    # Archive to install. Defaults to the newest alnair-*-x86_64-pc-windows-msvc.zip
    # under <repo>/dist.
    [string]$Archive = "",

    # Install root. Defaults to ALNAIR_SHARE_DIR, then %USERPROFILE%\.alnair.
    [string]$AlnairHome = "",

    # Skip SHA-256 verification. Only for an archive whose manifest you did not
    # generate; a mismatch is a hard failure either way.
    [switch]$SkipChecksum,

    # Do not touch the user PATH.
    [switch]$NoPath
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Fail([string]$Message) {
    Write-Error "install-local.ps1: error: $Message"
    exit 1
}

$Triple = "x86_64-pc-windows-msvc"

# -- Platform gate ------------------------------------------------------------
if (-not [System.Environment]::Is64BitOperatingSystem) {
    Fail "alnair requires 64-bit Windows (x86_64)"
}
if ($env:PROCESSOR_ARCHITECTURE -ne "AMD64") {
    Fail "unsupported architecture '$($env:PROCESSOR_ARCHITECTURE)' (only x86_64/AMD64 Windows builds are produced here)"
}

# -- Resolve the archive ------------------------------------------------------
# $PSScriptRoot is <repo>/scripts, so the default dist/ is one level up.
$RepoRoot = Split-Path -Parent $PSScriptRoot

if (-not $Archive) {
    $DistDir = Join-Path $RepoRoot "dist"
    if (-not (Test-Path $DistDir)) {
        Fail "no -Archive given and $DistDir does not exist. Build first: cargo build --profile release-dist -p alnair-bin"
    }
    $candidates = @(Get-ChildItem -Path $DistDir -Filter "alnair-*-$Triple.zip" -File -ErrorAction SilentlyContinue)
    if ($candidates.Count -eq 0) {
        Fail "no alnair-*-$Triple.zip in $DistDir. Build first: cargo build --profile release-dist -p alnair-bin"
    }
    $Archive = ($candidates | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
} else {
    # Keep the user's spelling for the error message; Resolve-Path only runs on
    # a path that exists, so a typo still reports what was actually asked for.
    $Requested = $Archive
    $Resolved = Resolve-Path -Path $Archive -ErrorAction SilentlyContinue
    if (-not $Resolved) { Fail "archive not found: $Requested" }
    $Archive = [string]$Resolved
}

if (-not (Test-Path $Archive -PathType Leaf)) { Fail "archive not found: $Archive" }
$Archive = (Resolve-Path -Path $Archive).Path
$ArchiveName = Split-Path -Leaf $Archive

# -- Version from the archive name -------------------------------------------
# alnair-<version>-<triple>.zip. Greedy match so a pre-release such as
# 0.1.2-alpha.1 stays whole; the triple is anchored at the end.
if ($ArchiveName -notmatch "^alnair-(.+)-$([regex]::Escape($Triple))\.zip$") {
    Fail "unexpected archive name '$ArchiveName' (expected alnair-<version>-$Triple.zip)"
}
$Version = $Matches[1]

# -- Install root -------------------------------------------------------------
if (-not $AlnairHome) {
    $AlnairHome = if ($env:ALNAIR_SHARE_DIR) { $env:ALNAIR_SHARE_DIR } else { Join-Path $env:USERPROFILE ".alnair" }
}
$AlnairHome = [System.IO.Path]::GetFullPath($AlnairHome)
$BinDir = Join-Path $AlnairHome "bin"
$DownloadsDir = Join-Path $AlnairHome "downloads"
$Dest = Join-Path $BinDir "alnair.exe"
# Matches the self-updater's versioned name exactly: detect_platform() yields
# windows/x86_64 and download_verified_from_base() formats the file as
# "alnair-<version>-<os>-<arch>" with NO .exe suffix (the runnable copy is
# bin\alnair.exe). Keeping the name identical means cleanup_old_downloads sees
# one canonical entry per version instead of a duplicate, and a later
# `alnair update` overwrites this file rather than accumulating beside it.
$Versioned = Join-Path $DownloadsDir "alnair-$Version-windows-x86_64"

Write-Host "Archive: $Archive"
Write-Host "Version: $Version"
Write-Host "Install: $AlnairHome"

# -- Checksum -----------------------------------------------------------------
$SumsPath = Join-Path (Split-Path -Parent $Archive) "SHA256SUMS"
if ($SkipChecksum) {
    Write-Host "Checksum verification SKIPPED (-SkipChecksum)."
} elseif (-not (Test-Path $SumsPath)) {
    Fail "no SHA256SUMS next to $ArchiveName. Regenerate it, or pass -SkipChecksum if you trust the build."
} else {
    $Expected = $null
    foreach ($line in Get-Content $SumsPath) {
        $parts = $line.Trim() -split '\s+', 2
        if ($parts.Count -eq 2 -and $parts[1].TrimStart('*') -eq $ArchiveName) {
            $Expected = $parts[0].ToLowerInvariant()
        }
    }
    if (-not $Expected) { Fail "SHA256SUMS has no entry for $ArchiveName" }

    $Actual = (Get-FileHash -Algorithm SHA256 -Path $Archive).Hash.ToLowerInvariant()
    if ($Actual -ne $Expected) {
        Fail "SHA256 mismatch for ${ArchiveName}: expected $Expected, got $Actual"
    }
    Write-Host "Checksum verified."
}

# -- Extract + smoke-test -----------------------------------------------------
$TmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ("alnair-local-" + [System.IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Path $TmpDir -Force | Out-Null
try {
    Expand-Archive -Path $Archive -DestinationPath $TmpDir -Force
    $Binary = Get-ChildItem -Path $TmpDir -Recurse -Filter "alnair.exe" | Select-Object -First 1
    if (-not $Binary) { Fail "archive $ArchiveName does not contain alnair.exe" }

    # Smoke-test BEFORE touching the install, so a broken build never replaces
    # a working binary.
    $Reported = & $Binary.FullName --version 2>&1
    if ($LASTEXITCODE -ne 0) {
        Fail "the archive's binary failed to run (exit $LASTEXITCODE): $Reported"
    }
    Write-Host "Binary reports: $Reported"
    if ($Reported -notmatch [regex]::Escape($Version)) {
        Write-Warning "archive is named $Version but the binary reports a different version"
    }

    # -- Install --------------------------------------------------------------
    New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
    New-Item -ItemType Directory -Path $DownloadsDir -Force | Out-Null

    Copy-Item -Path $Binary.FullName -Destination $Versioned -Force

    # A running alnair.exe blocks an in-place overwrite but allows a rename,
    # so move the live one aside first (the self-updater's windows_replace_exe
    # strategy). A .old left locked by a dead process gets a unique name rather
    # than failing the install.
    $Aside = $null
    if (Test-Path $Dest) {
        $Aside = "$Dest.old"
        Remove-Item -Path $Aside -Force -ErrorAction SilentlyContinue
        if (Test-Path $Aside) {
            $Aside = "$Dest." + [guid]::NewGuid().ToString('N').Substring(0, 8) + ".old"
        }
        try {
            Move-Item -Path $Dest -Destination $Aside -Force
        } catch {
            Fail "cannot replace $Dest (close every running alnair session and retry): $($_.Exception.Message)"
        }
    }
    Copy-Item -Path $Binary.FullName -Destination $Dest -Force

    # Smoke-test the installed binary through its final path.
    $Installed = & $Dest --version 2>&1
    if ($LASTEXITCODE -ne 0) {
        Fail "installed binary failed to run (exit $LASTEXITCODE): $Installed"
    }

    # Drop the aside copy now that the new binary is proven good. A failed
    # remove means a session still holds it open; the self-updater sweeps such
    # leftovers (sweep_old_exe_backups), so leaving it is safe - but a local
    # install should not accumulate one .old per reinstall.
    if ($Aside -and (Test-Path $Aside)) {
        Remove-Item -Path $Aside -Force -ErrorAction SilentlyContinue
    }
} finally {
    Remove-Item -Path $TmpDir -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "alnair $Version installed to $Dest"
Write-Host "Versioned copy: $Versioned"

# -- PATH ---------------------------------------------------------------------
if ($NoPath) {
    Write-Host "Run '$Dest' to get started."
} else {
    # -contains rather than .Count: under Set-StrictMode, .Count on an empty
    # filter result throws PropertyNotFoundStrict, which is exactly the
    # not-yet-on-PATH case.
    $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $OnPath = (($UserPath -split ";") -contains $BinDir) -or (($env:Path -split ";") -contains $BinDir)
    if (-not $OnPath) {
        $NewUserPath = if ($UserPath) { "$BinDir;$UserPath" } else { $BinDir }
        [Environment]::SetEnvironmentVariable("Path", $NewUserPath, "User")
        Write-Host ""
        Write-Host "Added $BinDir to your user PATH."
        Write-Host "Open a new terminal, then run 'alnair' to get started."
    } else {
        Write-Host "Run 'alnair' to get started."
    }
}
