<#
.SYNOPSIS
  Install or update the daedalus agent on this Windows machine.

.DESCRIPTION
  Downloads the newest agent-v* release of the engine repository, places it
  under Program Files, registers it as a service that starts at boot, and
  starts it. From then on the agent keeps this machine awake, answers a
  status page on TCP 7787 for the LAN, and updates itself. Run from an
  administrator PowerShell:

    Set-ExecutionPolicy -Scope Process Bypass -Force
    irm https://github.com/santiagotoscanini/daedalus/releases/latest/download/install.ps1 | iex

  (or download this file and run it). Re-running on an installed machine
  replaces the binary and keeps config.toml. `daedalus-agent uninstall`
  removes the service.

  Trust at install is HTTPS to GitHub. Every later update is verified by
  the agent itself against the release key it carries.

.PARAMETER Repo
  The GitHub repository whose agent-v* releases to install from.
.PARAMETER Version
  A specific version (e.g. 0.1.0) instead of the newest.
.PARAMETER Port
  The status page's TCP port, written to config.toml on first install.
#>
[CmdletBinding()]
param(
  [string]$Repo = "santiagotoscanini/daedalus",
  [string]$Version = "",
  [int]$Port = 7787
)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "run this from an administrator PowerShell (the service and the firewall rule need it)"
}

$asset = "daedalus-agent-x86_64-pc-windows-msvc.exe"
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
$download = ($release.assets | Where-Object { $_.name -eq $asset } | Select-Object -First 1).browser_download_url
if (-not $download) { throw "$($release.tag_name) has no $asset" }
Write-Host "installing $($release.tag_name)"

$dir = Join-Path $env:ProgramFiles "daedalus-agent"
$exe = Join-Path $dir "daedalus-agent.exe"
New-Item -ItemType Directory -Force -Path $dir | Out-Null

$service = Get-Service -Name "daedalus-agent" -ErrorAction SilentlyContinue
if ($service -and $service.Status -ne "Stopped") {
  Write-Host "stopping the running service"
  Stop-Service -Name "daedalus-agent" -Force
  $service.WaitForStatus("Stopped", [TimeSpan]::FromSeconds(30))
}

$tmp = "$exe.download"
Invoke-WebRequest -Uri $download -OutFile $tmp -Headers @{ "User-Agent" = "daedalus-agent-install" } -UseBasicParsing
Unblock-File -Path $tmp
Move-Item -Force -Path $tmp -Destination $exe

& $exe install --port $Port
if ($LASTEXITCODE -ne 0) { throw "daedalus-agent install exited $LASTEXITCODE" }

if ($service) {
  # `install` refreshes the registration but does not restart a service that
  # was already registered and stopped by us above; start it on the new binary.
  Start-Service -Name "daedalus-agent" -ErrorAction SilentlyContinue
}

Start-Sleep -Seconds 2
try {
  $status = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/status"
  Write-Host ("daedalus-agent {0} on {1}: awake hold {2}" -f $status.version, $status.hostname, $status.awake_hold)
} catch {
  Write-Warning "the service started but the status page did not answer yet: $_"
}
Write-Host "logs: $env:ProgramData\daedalus-agent\logs"
