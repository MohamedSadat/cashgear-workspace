<#
.SYNOPSIS
  Phase 14: binds each published site's own host name on IIS to the certificate the worker got for
  it, the way every other site on the host is bound (a certificate in LocalMachine\WebHosting and an
  https binding by that name, SNI). install.ps1 -CustomDomains registers it as a scheduled task that
  runs as SYSTEM every 2 minutes; it can also be run by hand.

.DESCRIPTION
  The worker writes one <host>.pfx a name into -Store (Sites__CertificateStore) and removes it when
  the name is no longer used. For each file this script, as an administrator:
    - imports the certificate into LocalMachine\WebHosting (not exportable) once, marked by its
      friendly name ("cgw-site <host>");
    - adds an https binding for the name on port 443 to -Site (the sites' IIS site), SNI required;
    - points the name's HTTP.sys binding at the certificate, again after a renewal;
    - adds an http binding for the name on port 80 too, so a renewal's ACME check and a visit by
      plain http reach the Sites process (which sends the visit on to https). Before a name's first
      certificate its port 80 reaches the site that holds the host's catch-all http binding, whose
      ACME path install.ps1 sends to the sites' own host.
  For a name whose file is gone it removes both bindings and HTTP.sys's entry, and it removes the
  marked certificates no binding uses any more. It never touches a name another IIS site binds,
  an https binding whose certificate it did not import (the sites' own host names), an http binding
  without a host name, or anything outside -Site. It reads no database and makes no network call.

  The files' password is the worker's own (Sites__CertificatePassword), read from the worker
  service's environment in the registry (only administrators and SYSTEM can read it), or from
  CGW_SITES_CERT_PASSWORD in this session when set: no copy of it is kept anywhere else.

  What it did is appended to -Log (names and thumbprints only), cut to its last 2,000 lines.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string] $Store,
  [string] $Site = 'CashGearWorkspaceSites',
  [string] $ServiceName = 'CashGearWorkspaceWorker',
  [string] $Log = ''
)

$ErrorActionPreference = 'Stop'
Import-Module WebAdministration
$marker = 'cgw-site '
$certificates = 'Cert:\LocalMachine\WebHosting'

function Note([string] $text) {
  Write-Host $text
  if ($Log) {
    $kept = @()
    if (Test-Path $Log) { $kept = @(Get-Content $Log | Select-Object -Last 1999) }
    ($kept + "$(Get-Date -Format o) $text") | Set-Content -Path $Log -Encoding utf8
  }
}

# The thumbprint HTTP.sys gives a name on 443, or $null.
function BoundThumbprint([string] $name) {
  foreach ($line in (& netsh http show sslcert "hostnameport=${name}:443")) {
    if ($line -match '^\s*Certificate Hash\s*:\s*([0-9a-fA-F]{40})') { return $Matches[1].ToUpperInvariant() }
  }
  return $null
}

function Password {
  if ($env:CGW_SITES_CERT_PASSWORD) { return $env:CGW_SITES_CERT_PASSWORD }
  $values = (Get-ItemProperty "HKLM:\SYSTEM\CurrentControlSet\Services\$ServiceName" -Name Environment -ErrorAction SilentlyContinue).Environment
  foreach ($value in @($values)) {
    if ($value -like 'Sites__CertificatePassword=*') { return $value.Substring('Sites__CertificatePassword='.Length) }
  }
  throw "No certificate password: the service $ServiceName has no Sites__CertificatePassword and CGW_SITES_CERT_PASSWORD is not set."
}

if (-not (Test-Path "IIS:\Sites\$Site")) { throw "No IIS site named $Site." }
if (-not (Test-Path $Store)) { throw "No certificate store folder at $Store." }
if (-not (Test-Path $certificates)) { New-Item -Path $certificates | Out-Null }

# Names any other site binds, on any port: never this script's.
$others = @{}
foreach ($other in Get-Website) {
  if ($other.name -eq $Site) { continue }
  foreach ($binding in $other.bindings.Collection) {
    $named = ($binding.bindingInformation -split ':')[2]
    if ($named) { $others[$named.ToLowerInvariant()] = $other.name }
  }
}

# A name with a file, read or not: a file it cannot read (a password changed, say) leaves the name
# bound as it was rather than taking its site off the web.
$present = @{}
$wanted = @{}
$files = @(Get-ChildItem -Path $Store -Filter '*.pfx' -File)
$secure = $null
if ($files.Count) { $secure = ConvertTo-SecureString (Password) -AsPlainText -Force }
foreach ($file in $files) {
  $name = $file.BaseName.ToLowerInvariant()
  if ($name -notmatch '^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$') {
    Note "skipped $($file.Name): not a host name"
    continue
  }
  if ($others.ContainsKey($name)) {
    Note "skipped ${name}: the IIS site $($others[$name]) binds it"
    continue
  }
  $present[$name] = $true
  try {
    $data = Get-PfxData -FilePath $file.FullName -Password $secure
    $leaf = @($data.EndEntityCertificates)[0]
    if (-not $leaf) { throw 'no end-entity certificate' }
  } catch {
    Note "skipped ${name}: the file cannot be read ($($_.Exception.Message))"
    continue
  }
  $thumbprint = $leaf.Thumbprint.ToUpperInvariant()
  $wanted[$name] = $thumbprint
  $path = "$certificates\$thumbprint"
  if (-not (Test-Path $path)) {
    Import-PfxCertificate -FilePath $file.FullName -CertStoreLocation $certificates -Password $secure | Out-Null
    (Get-Item $path).FriendlyName = "$marker$name"
    Note "imported $name $thumbprint (until $($leaf.NotAfter.ToString('yyyy-MM-dd')))"
  }
  $binding = Get-WebBinding -Name $Site -Protocol https -Port 443 -HostHeader $name
  if (-not $binding) {
    New-WebBinding -Name $Site -Protocol https -Port 443 -HostHeader $name -SslFlags 1
    $binding = Get-WebBinding -Name $Site -Protocol https -Port 443 -HostHeader $name
    Note "bound $name on $Site"
  }
  $bound = BoundThumbprint $name
  if ($bound -ne $thumbprint) {
    if ($bound) { $binding.RemoveSslCertificate() | Out-Null }
    $binding.AddSslCertificate($thumbprint, 'WebHosting') | Out-Null
    Note "certificate for $name is $thumbprint$(if ($bound) { " (was $bound)" })"
  }
  if (-not (Get-WebBinding -Name $Site -Protocol http -Port 80 -HostHeader $name)) {
    New-WebBinding -Name $Site -Protocol http -Port 80 -HostHeader $name
    Note "bound $name on $Site (http)"
  }
}

# Names whose file is gone: only bindings on this site whose certificate this script imported.
foreach ($binding in @(Get-WebBinding -Name $Site -Protocol https -Port 443)) {
  $name = (($binding.bindingInformation -split ':')[2]).ToLowerInvariant()
  if (-not $name -or $present.ContainsKey($name)) { continue }
  $bound = BoundThumbprint $name
  $ours = $bound -and (Test-Path "$certificates\$bound") -and (Get-Item "$certificates\$bound").FriendlyName.StartsWith($marker)
  if (-not $ours) { continue }
  $binding.RemoveSslCertificate() | Out-Null
  Remove-WebBinding -Name $Site -Protocol https -Port 443 -HostHeader $name
  Note "unbound $name"
}

# Port 80 by name on this site is only ever this script's: gone with the name's file.
foreach ($binding in @(Get-WebBinding -Name $Site -Protocol http -Port 80)) {
  $name = (($binding.bindingInformation -split ':')[2]).ToLowerInvariant()
  if (-not $name -or $present.ContainsKey($name)) { continue }
  Remove-WebBinding -Name $Site -Protocol http -Port 80 -HostHeader $name
  Note "unbound $name (http)"
}

# Certificates this script imported that no name uses any more (renewed or removed).
$inUse = @{}
foreach ($thumbprint in $wanted.Values) { $inUse[$thumbprint] = $true }
foreach ($certificate in @(Get-ChildItem $certificates)) {
  if (-not $certificate.FriendlyName.StartsWith($marker)) { continue }
  if ($inUse.ContainsKey($certificate.Thumbprint.ToUpperInvariant())) { continue }
  $named = $certificate.FriendlyName.Substring($marker.Length)
  if ($present.ContainsKey($named) -and -not $wanted.ContainsKey($named)) { continue }
  Remove-Item "$certificates\$($certificate.Thumbprint)"
  Note "removed certificate $($certificate.FriendlyName.Substring($marker.Length)) $($certificate.Thumbprint)"
}
