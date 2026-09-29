<#
.SYNOPSIS
  Install or update the daedalus agent on this Windows machine.

.DESCRIPTION
  Downloads the newest agent-v* release of the engine repository, places the
  service and the tray under Program Files, and runs `daedalus-agent install`
  (the service, the tray's Run key, config.toml). From then on the agent
  keeps this machine awake, keeps one connection to the controller (the
  box's agent) — it listens on nothing the LAN can reach — and updates
  itself. Run from an administrator PowerShell:

    Set-ExecutionPolicy -Scope Process Bypass -Force
    irm https://daedalus.toscanini.me/install.ps1 | iex

  (the site serves this file from agent/install.ps1 on main, so the line never
  names a version; the script finds the newest agent-v* release itself).
  Re-running on an installed machine replaces the binaries and keeps
  config.toml. `daedalus-agent uninstall` removes the service and the
  tray's Run key.

  Trust at install is HTTPS to GitHub, and each file is checked against the
  release's manifest (release.json) by SHA-256. Every later update is verified by
  the agent itself against the release key it carries.

.PARAMETER Repo
  The GitHub repository whose agent-v* releases to install from.
.PARAMETER Version
  A specific version (e.g. 0.1.0) instead of the newest.
.PARAMETER Controller
  The controller's link address, host:port (the box's agent), written to
  config.toml (also on a reinstall). Absent: the agent asks DNS for the
  controller's SRV record.
.PARAMETER Pin
  The controller key's fingerprint to trust, written to config.toml (also on
  a reinstall). Absent: the first key the controller presents is trusted,
  and the tray says so until one is pinned. With either, run the script as
  a script block so it takes parameters:

    & ([scriptblock]::Create((irm https://daedalus.toscanini.me/install.ps1))) `
      -Controller box.lan:7788 -Pin 3f2a:9c01:…
#>
[CmdletBinding()]
param(
  [string]$Repo = "santiagotoscanini/daedalus",
  [string]$Version = "",
  [string]$Controller = "",
  [string]$Pin = ""
)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "run this from an administrator PowerShell (the service needs it)"
}

# Release asset name -> file name beside the service. Both are required.
$assets = @{
  "daedalus-agent-x86_64-pc-windows-msvc.exe"      = "daedalus-agent.exe"
  "daedalus-agent-tray-x86_64-pc-windows-msvc.exe" = "daedalus-agent-tray.exe"
}
$headers = @{ "User-Agent" = "daedalus-agent-install"; "Accept" = "application/vnd.github+json" }

Write-Host "looking up releases of $Repo"
$releases = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases?per_page=30" -Headers $headers
$candidates = $releases | Where-Object { -not $_.draft -and -not $_.prerelease -and $_.tag_name -like "agent-v*" }
if ($Version) {
  $release = $candidates | Where-Object { $_.tag_name -eq "agent-v$Version" } | Select-Object -First 1
  if (-not $release) { throw "no release agent-v$Version" }
} else {
  $release = $candidates | Sort-Object { [version]($_.tag_name -replace '^agent-v', '') } -Descending | Select-Object -First 1
  if (-not $release) { throw "no agent-v* release found in $Repo" }
}
foreach ($name in $assets.Keys) {
  if (-not ($release.assets | Where-Object { $_.name -eq $name })) { throw "$($release.tag_name) has no $name" }
}
Write-Host "installing $($release.tag_name)"

# The release's manifest names every asset's SHA-256 (agent/src/update/feed.rs);
# each download is checked against it. Its ed25519 signature is the agent's to
# check on every later update: Windows PowerShell has no ed25519, so at
# install the manifest's trust is HTTPS to GitHub.
$manifestUrl = ($release.assets | Where-Object { $_.name -eq "release.json" } | Select-Object -First 1).browser_download_url
if (-not $manifestUrl) { throw "$($release.tag_name) has no signed manifest (release.json); it predates this installer" }
# Served as a download (octet-stream), so read as bytes, then as JSON.
$raw = (Invoke-WebRequest -Uri $manifestUrl -Headers @{ "User-Agent" = "daedalus-agent-install" } -UseBasicParsing).RawContentStream.ToArray()
$manifest = [Text.Encoding]::UTF8.GetString($raw) | ConvertFrom-Json
if ($manifest.product -ne "daedalus-agent" -or $manifest.tag -ne $release.tag_name -or "agent-v$($manifest.version)" -ne $release.tag_name) {
  throw "$($release.tag_name)'s manifest is not its own"
}

$dir = Join-Path $env:ProgramFiles "daedalus-agent"
$exe = Join-Path $dir "daedalus-agent.exe"
New-Item -ItemType Directory -Force -Path $dir | Out-Null

$service = Get-Service -Name "daedalus-agent" -ErrorAction SilentlyContinue
if ($service -and $service.Status -ne "Stopped") {
  Write-Host "stopping the running service"
  Stop-Service -Name "daedalus-agent" -Force
  $service.WaitForStatus("Stopped", [TimeSpan]::FromSeconds(30))
}
# The tray holds its executable open; end it so the file can be replaced.
Get-Process -Name "daedalus-agent-tray" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

foreach ($name in $assets.Keys) {
  $url = ($release.assets | Where-Object { $_.name -eq $name } | Select-Object -First 1).browser_download_url
  $target = Join-Path $dir $assets[$name]
  $tmp = "$target.download"
  Invoke-WebRequest -Uri $url -OutFile $tmp -Headers @{ "User-Agent" = "daedalus-agent-install" } -UseBasicParsing
  $want = ($manifest.assets | Where-Object { $_.name -eq $name -and $_.target -eq "x86_64-pc-windows-msvc" } | Select-Object -First 1).sha256
  $got = (Get-FileHash -Algorithm SHA256 -Path $tmp).Hash.ToLowerInvariant()
  if (-not $want -or $got -ne $want) {
    Remove-Item -Force $tmp
    throw "$name does not match the release's manifest"
  }
  Unblock-File -Path $tmp
  Move-Item -Force -Path $tmp -Destination $target
}

$installArgs = @("install")
if ($Controller) { $installArgs += @("--controller", $Controller) }
if ($Pin) { $installArgs += @("--pin", $Pin) }
& $exe @installArgs
if ($LASTEXITCODE -ne 0) { throw "daedalus-agent install exited $LASTEXITCODE" }

if ($service) {
  # `install` already starts a service it finds stopped
  # (src/os/windows/service.rs), so this is a no-op in the normal case; kept
  # as a second try on the new binary.
  Start-Service -Name "daedalus-agent" -ErrorAction SilentlyContinue
}

Start-Sleep -Seconds 2
try {
  $status = (& $exe status | Out-String) | ConvertFrom-Json
  Write-Host ("daedalus-agent {0} on {1}: awake hold {2}" -f $status.version, $status.hostname, $status.awake_hold)
} catch {
  Write-Warning "the service started but did not answer on its local pipe yet: $_"
}
Write-Host "service logs: $env:ProgramData\daedalus-agent\logs (Administrators); tray and session: %LOCALAPPDATA%\daedalus-agent\logs"
