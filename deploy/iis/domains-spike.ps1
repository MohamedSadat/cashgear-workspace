<#
.SYNOPSIS
  Phase 14's spike (decisions, 2026-11-22): whether this IIS host can serve published sites at a
  workspace's own host names through one catch-all binding over IIS's Centralized Certificate Store
  (CCS), leaving every other site's binding and certificate as it is.

.DESCRIPTION
  By default it only reads and reports, changing nothing: IIS's sites and bindings, HTTP.sys's
  certificate bindings (netsh http show sslcert), whether Centralized SSL Certificate Support is
  installed and on, whether any site already holds a catch-all binding (no host name) on 443 or 80,
  and whether port 80 is open. The report goes to the console and to -Out; it holds no secret
  (thumbprints and host names only).

  -Try then tests it, on a scratch site of its own, and puts everything back: a self-signed
  certificate for a name nobody uses (<random>.cgw-spike.invalid) in a scratch store folder, the
  store pointed at that folder as -StoreUser (its password from CGW_CCS_PASSWORD in this session),
  a scratch site with the catch-all https binding by the store (SslFlags 2) and a file to read; then
  each host name another site binds is asked for by SNI before and after, and must give the same
  certificate, and the scratch name must give the scratch certificate and the file. Everything made
  is removed after, whatever happens, and the store's settings are put back as they were. It refuses
  if another site holds the catch-all binding, if the store is already in use, or if the store's
  feature is not installed (-InstallFeature installs it: a change kept after the spike).

.EXAMPLE
  .\deploy\iis\domains-spike.ps1                      # the report only
  $env:CGW_CCS_PASSWORD = Read-Host -AsSecureString | ConvertFrom-SecureString -AsPlainText
  .\deploy\iis\domains-spike.ps1 -Try -StoreUser '.\cgw-ccs'
  Remove-Item Env:\CGW_CCS_PASSWORD
#>
[CmdletBinding()]
param(
  [switch] $Try,
  [string] $StoreUser = '',
  [switch] $InstallFeature,
  [string] $Out = (Join-Path $env:TEMP "cgw-domains-spike-$(Get-Date -Format yyyyMMdd-HHmmss).txt")
)

$ErrorActionPreference = 'Stop'
Import-Module WebAdministration
$lines = New-Object System.Collections.Generic.List[string]
function Say([string] $text) { $lines.Add($text); Write-Host $text }

# The certificate a TLS client is given for a name (by SNI) at 127.0.0.1:443, or the error.
function CertificateFor([string] $name) {
  $tcp = New-Object System.Net.Sockets.TcpClient
  try {
    $tcp.Connect('127.0.0.1', 443)
    $ssl = New-Object System.Net.Security.SslStream($tcp.GetStream(), $false, { $true })
    $ssl.AuthenticateAsClient($name)
    $certificate = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($ssl.RemoteCertificate)
    $ssl.Dispose()
    return "$($certificate.Thumbprint) $($certificate.Subject)"
  } catch {
    $inner = $_.Exception.InnerException
    return "error: $(if ($inner) { $inner.Message } else { $_.Exception.Message })"
  } finally { $tcp.Dispose() }
}

Say "Cash Gear Workspace: the custom domains spike, $(Get-Date -Format o) on $env:COMPUTERNAME"
Say "Windows $([Environment]::OSVersion.Version), IIS $((Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\InetStp').VersionString)"
Say ''
Say '== IIS sites and bindings'
$names = New-Object System.Collections.Generic.List[string]
foreach ($site in Get-Website) {
  Say "$($site.name) [$($site.state)]"
  foreach ($binding in $site.bindings.Collection) {
    Say "  $($binding.protocol) $($binding.bindingInformation) sslFlags=$($binding.sslFlags)"
    $named = ($binding.bindingInformation -split ':')[2]
    if ($binding.protocol -eq 'https' -and $named) { $names.Add($named) }
  }
}
Say ''
Say '== Catch-all bindings (no host name) held now'
$catchAll = Get-WebBinding | Where-Object { $_.bindingInformation -in '*:443:', '*:80:' }
if ($catchAll) { foreach ($b in $catchAll) { Say "  $($b.protocol) $($b.bindingInformation) on $($b.ItemXPath)" } } else { Say '  none' }
Say ''
Say '== HTTP.sys certificate bindings (netsh http show sslcert)'
foreach ($line in (& netsh http show sslcert)) {
  if ($line -match '^\s*(IP:port|Hostname:port|Central Certificate Store|Certificate Hash|Certificate Store Name)\s*:') { Say "  $($line.Trim())" }
}
Say ''
Say '== Centralized SSL Certificate Support'
$feature = if (Get-Command Get-WindowsFeature -ErrorAction SilentlyContinue) { (Get-WindowsFeature Web-CertProvider).Installed } else { $null }
Say "  installed: $feature"
$ccsOn = $false
if ($feature) {
  $ccs = Get-WebCentralCertProvider -Enabled
  $ccsOn = [bool]$ccs.Value
  Say "  enabled: $ccsOn"
  if ($ccsOn) { Say "  location: $((Get-WebCentralCertProvider -CertStoreLocation).Value)" }
}
Say ''
Say '== Port 80'
$listening = Get-NetTCPConnection -LocalPort 80 -State Listen -ErrorAction SilentlyContinue
Say "  listening: $([bool]$listening)"
$rules = Get-NetFirewallRule -Direction Inbound -Enabled True -Action Allow -ErrorAction SilentlyContinue |
  Where-Object { ($_ | Get-NetFirewallPortFilter).LocalPort -contains '80' }
Say "  inbound rules allowing 80: $(@($rules).Count) $(($rules | ForEach-Object { $_.DisplayName }) -join '; ')"
Say ''
Say '== The certificate each bound name gives now (by SNI at 127.0.0.1:443)'
$before = @{}
foreach ($name in $names | Sort-Object -Unique) {
  $before[$name] = CertificateFor $name
  Say "  $name -> $($before[$name])"
}

if (-not $Try) {
  Say ''
  Say "Report only: nothing was changed. Written to $Out"
  $lines | Set-Content -Path $Out -Encoding utf8
  return
}

Say ''
Say '== The try (a scratch site, removed after)'
if ($catchAll | Where-Object { $_.protocol -eq 'https' }) { throw 'Another site holds the catch-all https binding: the catch-all cannot be added (an administrator''s step per domain instead).' }
if (-not $feature) {
  if (-not $InstallFeature) { throw 'Centralized SSL Certificate Support is not installed: pass -InstallFeature to install it (it stays installed after the spike).' }
  Install-WindowsFeature Web-CertProvider | Out-Null
  Say '  installed Web-CertProvider (kept)'
}
if ($ccsOn) { throw 'The Centralized Certificate Store is already in use on this host: the try would change it. Stop here.' }
if (-not $StoreUser -or -not $env:CGW_CCS_PASSWORD) { throw '-Try needs -StoreUser and its password in CGW_CCS_PASSWORD.' }

$scratchName = "$([guid]::NewGuid().ToString('N').Substring(0, 12)).cgw-spike.invalid"
$folder = Join-Path $env:SystemDrive "cgw-domains-spike-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
$site = 'CgwDomainsSpike'
$pfxPassword = [guid]::NewGuid().ToString('N')
$made = $null
try {
  New-Item -ItemType Directory -Force (Join-Path $folder 'site'), (Join-Path $folder 'store') | Out-Null
  'cgw-spike' | Set-Content -Path (Join-Path $folder 'site\spike.txt') -Encoding ascii
  & icacls.exe (Join-Path $folder 'store') /grant "${StoreUser}:(OI)(CI)R" | Out-Null
  $made = New-SelfSignedCertificate -DnsName $scratchName -CertStoreLocation Cert:\LocalMachine\My -NotAfter (Get-Date).AddDays(1)
  $secure = ConvertTo-SecureString $pfxPassword -AsPlainText -Force
  Export-PfxCertificate -Cert $made -FilePath (Join-Path $folder "store\$scratchName.pfx") -Password $secure | Out-Null
  Enable-WebCentralCertProvider -CertStoreLocation (Join-Path $folder 'store') -UserName $StoreUser -Password $env:CGW_CCS_PASSWORD -PrivateKeyPassword $pfxPassword
  New-WebSite -Name $site -PhysicalPath (Join-Path $folder 'site') -Port 443 -Ssl -HostHeader '' -SslFlags 2 | Out-Null
  Start-Sleep -Seconds 2
  $scratch = CertificateFor $scratchName
  Say "  $scratchName -> $scratch (expected $($made.Thumbprint))"
  $same = $true
  foreach ($name in $before.Keys) {
    $now = CertificateFor $name
    $kept = $now -eq $before[$name]
    if (-not $kept) { $same = $false }
    Say "  $name -> $now $(if ($kept) { '(as before)' } else { '(CHANGED)' })"
  }
  $file = $null
  try {
    $handler = New-Object System.Net.Http.HttpClientHandler
    $handler.ServerCertificateCustomValidationCallback = { $true }
    $client = New-Object System.Net.Http.HttpClient($handler)
    $request = New-Object System.Net.Http.HttpRequestMessage('GET', "https://${scratchName}/spike.txt")
    $client.DefaultRequestHeaders.Host = $scratchName
    $request.RequestUri = [Uri]"https://127.0.0.1/spike.txt"
    $file = $client.SendAsync($request).Result.Content.ReadAsStringAsync().Result.Trim()
  } catch { $file = "error: $($_.Exception.Message)" }
  Say "  the scratch site's file: $file"
  $served = $scratch.StartsWith($made.Thumbprint)
  Say ''
  Say "Result: the store serves the scratch name: $served; every other name kept its certificate: $same."
} finally {
  if (Test-Path "IIS:\Sites\$site") { Remove-WebSite -Name $site }
  Disable-WebCentralCertProvider -ErrorAction SilentlyContinue
  if ($made) { Remove-Item "Cert:\LocalMachine\My\$($made.Thumbprint)" -ErrorAction SilentlyContinue }
  if (Test-Path $folder) { Remove-Item -Recurse -Force $folder }
  Say '  removed: the scratch site, its folder and certificate; the store turned off again'
  $lines | Set-Content -Path $Out -Encoding utf8
  Write-Host "Written to $Out"
}
