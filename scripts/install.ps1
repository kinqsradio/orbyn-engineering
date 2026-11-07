# Installs the `orbyn` command on Windows from a GitHub release, without the desktop app.
#
#   irm https://raw.githubusercontent.com/orbyn-dev/orbyn-engineering/main/scripts/install.ps1 | iex
#
# $env:ORBYN_VERSION = "1.2.3" pins an exact release; $env:ORBYN_CHANNEL = "nightly"
# takes the nightly release instead of the latest stable one. The command and its
# service go to ~\.local\share\orbyn\cli and a small launcher to ~\.local\bin\orbyn.cmd
# (ORBYN_INSTALL_DIR and ORBYN_HOME move them). The archive must match its .sha256.
# On macOS, use install.sh.
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

# Throws rather than exits, so `irm | iex` leaves the caller's PowerShell open.
function Fail($message) {
  throw "orbyn install: $message"
}

function Setting($name, $default) {
  $value = [Environment]::GetEnvironmentVariable($name)
  if ([string]::IsNullOrEmpty($value)) { $default } else { $value }
}

$repo = "orbyn-dev/orbyn-engineering"
$base = Setting "ORBYN_INSTALL_BASE" "https://github.com/$repo/releases"
$bin = Setting "ORBYN_INSTALL_DIR" (Join-Path $HOME ".local\bin")
$home_ = Setting "ORBYN_HOME" (Join-Path $HOME ".local\share\orbyn")
$channel = Setting "ORBYN_CHANNEL" "stable"
$version = Setting "ORBYN_VERSION" ""

if ($version) {
  $url = "$base/download/v$($version.TrimStart('v'))"
} elseif ($channel -eq "stable") {
  $url = "$base/latest/download"
} elseif ($channel -eq "nightly") {
  $url = "$base/download/nightly"
} else {
  Fail "ORBYN_CHANNEL must be stable or nightly, not '$channel'."
}

$arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
switch ("$arch") {
  "X64" { $target = "x86_64-pc-windows-msvc" }
  "Arm64" { $target = "aarch64-pc-windows-msvc" }
  default { Fail "this processor ($arch) has no build." }
}
if ([Environment]::OSVersion.Platform -ne "Win32NT") {
  Fail "this script installs on Windows; on macOS run install.sh."
}

$asset = "orbyn-cli-$target.tar.gz"
$work = Join-Path ([IO.Path]::GetTempPath()) ("orbyn-install-" + [Guid]::NewGuid())
New-Item -ItemType Directory -Path $work | Out-Null
try {
  Write-Host "Downloading $url/$asset"
  try {
    Invoke-WebRequest -UseBasicParsing -Uri "$url/$asset" -OutFile (Join-Path $work $asset)
    Invoke-WebRequest -UseBasicParsing -Uri "$url/$asset.sha256" -OutFile (Join-Path $work "$asset.sha256")
  } catch {
    Fail "could not download $asset. Is there a release for this channel or version?"
  }

  $expected = ((Get-Content -Raw (Join-Path $work "$asset.sha256")) -split '\s+')[0]
  $actual = (Get-FileHash -Algorithm SHA256 (Join-Path $work $asset)).Hash
  if (-not $expected -or $expected.ToLowerInvariant() -ne $actual.ToLowerInvariant()) {
    Fail "$asset does not match its checksum; nothing was installed."
  }

  $cli = Join-Path $work "cli"
  New-Item -ItemType Directory -Path $cli | Out-Null
  # Windows 10 and later ship tar.exe; the system copy avoids a Git or MSYS tar on PATH.
  $tar = Join-Path $env:SystemRoot "System32\tar.exe"
  if (-not (Test-Path $tar)) { $tar = "tar" }
  & $tar -xzf (Join-Path $work $asset) -C $cli
  if ($LASTEXITCODE -ne 0) { Fail "could not unpack $asset; nothing was installed." }
  if (-not (Test-Path (Join-Path $cli "orbyn.exe")) -or -not (Test-Path (Join-Path $cli "orbynd.exe"))) {
    Fail "$asset does not hold orbyn.exe and orbynd.exe; nothing was installed."
  }

  New-Item -ItemType Directory -Force -Path $home_, $bin | Out-Null
  $installed = Join-Path $home_ "cli"
  $old = Join-Path $home_ "cli.old"
  if (Test-Path $old) { Remove-Item -Recurse -Force $old }
  if (Test-Path $installed) { Move-Item $installed $old }
  Move-Item $cli $installed
  if (Test-Path $old) { Remove-Item -Recurse -Force $old }

  # A launcher rather than a copy, so `orbyn` finds `orbynd` and the UI beside itself.
  $launcher = Join-Path $bin "orbyn.cmd"
  Set-Content -Encoding ASCII -Path $launcher -Value "@echo off`r`n`"$installed\orbyn.exe`" %*`r`n"
  Write-Host "Installed orbyn to $launcher"

  $path = [Environment]::GetEnvironmentVariable("Path", "User")
  if (-not (($path -split ';') -contains $bin)) {
    Write-Host "Add $bin to your PATH to run orbyn from any folder."
  }
} finally {
  Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}
