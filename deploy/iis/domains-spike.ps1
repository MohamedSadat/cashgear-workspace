<#
.SYNOPSIS
  Phase 14's spike (decisions, 2026-11-22): whether this IIS host can serve published sites at a
  workspace's own host names, each bound by site-bindings.ps1 (a certificate in
  LocalMachine\WebHosting and an https binding by that name, SNI), leaving every other site's
  binding and certificate as it is.

.DESCRIPTION
  By default it only reads and reports, changing nothing: IIS's sites and bindings, HTTP.sys's
  certificate bindings (netsh http show sslcert), the certificates in WebHosting (issuer and expiry),
  any ACME client already on the host (scheduled tasks; Default Web Site's /.well-known folder and
  redirect), whether any site holds a catch-all binding (no host name) on 443 or 80, and whether
  port 80 is open. The report goes to the console and to -Out; it holds no secret (thumbprints and
  host names only).

  -Try then tests site-bindings.ps1 itself (beside this script, or -Bindings) on a scratch site of
  its own, and puts everything back: a self-signed certificate for a name nobody uses
  (<random>.cgw-spike.invalid) written as a password-protected <name>.pfx into a scratch store
  folder, as the worker writes one; site-bindings.ps1 run over that folder and the scratch site;
  then each host name another site binds is asked for by SNI before and after and must give the same
  certificate, and the scratch name must give the scratch certificate and the scratch site's file.
  Then the file is removed and site-bindings.ps1 run again: the bindings, HTTP.sys's entry and the
  imported certificate must be gone. Last, the redirect install.ps1 adds to the site holding the
  host's catch-all http binding (ACME's path only, to the sites' own host, -SitesHost) is added for
  a moment: a name nobody binds must be sent there on that path and nowhere else, and a name another
  site binds on port 80 must answer as before. Everything made is removed after, whatever happens.

  The first tries on the production host (2026-11-22) found that IIS refuses a Centralized
  Certificate Store binding without a host name, and that a store binding by name is not served
  until HTTP.sys has a port-wide store entry (ccs=443), which would also stand between every other
  name without an SNI binding of its own (vaultapi, www.kitchino.info) and the host's fallback
  certificate: the store was dropped. -Try also clears the store's settings those tries left, when
  they still name a scratch folder of this spike.

.EXAMPLE
  .\deploy\iis\domains-spike.ps1                      # the report only
  .\deploy\iis\domains-spike.ps1 -Try                 # Windows PowerShell 5.1, as an administrator
#>
[CmdletBinding()]
param(
  [switch] $Try,
  [string] $Bindings = '',
  [string] $SitesHost = 'pages.cashgearerp.com',
  [string] $Out = (Join-Path $env:TEMP "cgw-domains-spike-$(Get-Date -Format yyyyMMdd-HHmmss).txt")
)

$ErrorActionPreference = 'Stop'
# Windows PowerShell 5.1 run with -File has no $PSScriptRoot yet in a parameter's default.
if (-not $Bindings) { $Bindings = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'site-bindings.ps1' }
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

# A file asked for over TLS by a name (SNI) as a browser would: 'cgw-spike' or the status line.
function FileFor([string] $name) {
  $tcp = New-Object System.Net.Sockets.TcpClient
  try {
    $tcp.Connect('127.0.0.1', 443)
    $ssl = New-Object System.Net.Security.SslStream($tcp.GetStream(), $false, { $true })
    $ssl.AuthenticateAsClient($name)
    $ask = [Text.Encoding]::ASCII.GetBytes("GET /spike.txt HTTP/1.1`r`nHost: $name`r`nConnection: close`r`n`r`n")
    $ssl.Write($ask)
    $ssl.Flush()
    $answer = (New-Object System.IO.StreamReader($ssl)).ReadToEnd()
    if ($answer -match 'cgw-spike') { return 'cgw-spike' }
    return ($answer -split "`r`n")[0]
  } catch { return "error: $($_.Exception.Message)" } finally { $tcp.Dispose() }
}

# Status and Location of a plain-http GET at 127.0.0.1:80 by a host name, redirects not followed.
function HttpAt([string] $name, [string] $path) {
  $request = [System.Net.HttpWebRequest]::Create("http://127.0.0.1$path")
  $request.Host = $name
  $request.AllowAutoRedirect = $false
  $request.Timeout = 10000
  try { $response = $request.GetResponse() } catch [System.Net.WebException] { $response = $_.Exception.Response }
  if (-not $response) { return 'no answer' }
  try { return "$([int]$response.StatusCode) $($response.Headers['Location'])".Trim() } finally { $response.Close() }
}

function SniEntry([string] $name) {
  foreach ($line in (& netsh http show sslcert "hostnameport=${name}:443")) {
    if ($line -match '^\s*Certificate Hash\s*:\s*([0-9a-fA-F]{40})') { return $Matches[1].ToUpperInvariant() }
  }
  return $null
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
Say '== Certificates in LocalMachine\WebHosting'
foreach ($c in @(Get-ChildItem Cert:\LocalMachine\WebHosting -ErrorAction SilentlyContinue)) {
  Say "  $($c.Thumbprint) $($c.Subject) by $($c.Issuer) until $($c.NotAfter.ToString('yyyy-MM-dd'))$(if ($c.FriendlyName) { " '$($c.FriendlyName)'" })"
}
Say ''
Say '== ACME clients already on this host'
$tasks = @(Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { "$($_.TaskPath)$($_.TaskName)" -match 'acme|letsencrypt|certif|wacs|certify|posh' })
if ($tasks) { foreach ($t in $tasks) { Say "  task $($t.TaskPath)$($t.TaskName) [$($t.State)]: $(($t.Actions | ForEach-Object { "$($_.Execute) $($_.Arguments)" }) -join '; ')" } } else { Say '  no scheduled task named for ACME or certificates' }
$wwwroot = [Environment]::ExpandEnvironmentVariables((Get-Item 'IIS:\Sites\Default Web Site').physicalPath)
$wellKnown = Join-Path $wwwroot '.well-known'
Say "  Default Web Site's folder: $wwwroot; .well-known there: $(Test-Path $wellKnown)"
if (Test-Path $wellKnown) { foreach ($f in @(Get-ChildItem $wellKnown -Recurse | Select-Object -First 20)) { Say "    $($f.FullName.Substring($wwwroot.Length)) $($f.LastWriteTime.ToString('yyyy-MM-dd'))" } }
try {
  $redirect = Get-WebConfiguration -Filter system.webServer/httpRedirect -PSPath 'IIS:\Sites\Default Web Site'
  Say "  Default Web Site's redirect: enabled $($redirect.enabled) to '$($redirect.destination)'; HTTP Redirection installed: $((Get-WindowsFeature Web-Http-Redirect).Installed)"
} catch { Say "  Default Web Site's redirect: unknown ($($_.Exception.Message))" }
try {
  $config = [xml](Get-Content "$env:windir\System32\inetsrv\config\applicationHost.config" -Raw)
  foreach ($l in @($config.configuration.location | Where-Object { $_.path -like 'Default Web Site/*' })) { Say "  location: $($l.path)" }
} catch { Say "  locations: unknown ($($_.Exception.Message))" }
Say ''
Say '== Centralized SSL Certificate Support'
$feature = if (Get-Command Get-WindowsFeature -ErrorAction SilentlyContinue) { (Get-WindowsFeature Web-CertProvider).Installed } else { $null }
Say "  installed: $feature"
$ccsKey = 'HKLM:\SOFTWARE\Microsoft\IIS\CentralCertProvider'
$ccs = Get-ItemProperty $ccsKey -ErrorAction SilentlyContinue
Say "  settings: $(if ($ccs) { "enabled $($ccs.Enabled), location '$($ccs.CertStoreLocation)', account '$($ccs.UserName)'" } else { 'none' })"
foreach ($line in (& netsh http show sslcert ccs=443)) { if ($line -match '^\s*(Central Certificate Store|Certificate Hash)\s*:') { Say "  netsh ccs=443: $($line.Trim())" } }
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
if (-not (Test-Path $Bindings)) { throw "No site-bindings.ps1 at $Bindings (-Bindings)." }
$scratchName = "$([guid]::NewGuid().ToString('N').Substring(0, 12)).cgw-spike.invalid"
$folder = Join-Path $env:SystemDrive "cgw-domains-spike-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
$store = Join-Path $folder 'store'
$site = 'CgwDomainsSpike'
$made = $null
$redirectAdded = $false
$env:CGW_SITES_CERT_PASSWORD = [guid]::NewGuid().ToString('N')
try {
  New-Item -ItemType Directory -Force (Join-Path $folder 'site'), $store | Out-Null
  'cgw-spike' | Set-Content -Path (Join-Path $folder 'site\spike.txt') -Encoding ascii
  # The scratch site starts with an http binding for its own unused name only.
  New-WebSite -Name $site -PhysicalPath (Join-Path $folder 'site') -Port 80 -HostHeader $scratchName | Out-Null
  $made = New-SelfSignedCertificate -DnsName $scratchName -CertStoreLocation Cert:\LocalMachine\My -NotAfter (Get-Date).AddDays(1)
  $secure = ConvertTo-SecureString $env:CGW_SITES_CERT_PASSWORD -AsPlainText -Force
  # AES-256 with SHA-256, as the worker writes them (Pkcs12ExportPbeParameters.Pbes2Aes256Sha256).
  Export-PfxCertificate -Cert $made -FilePath (Join-Path $store "$scratchName.pfx") -Password $secure -CryptoAlgorithmOption AES256_SHA256 | Out-Null
  Remove-Item "Cert:\LocalMachine\My\$($made.Thumbprint)"

  Say "  site-bindings.ps1 with the scratch file:"
  foreach ($line in (& $Bindings -Store $store -Site $site -ServiceName 'none' 6>&1)) { Say "    $line" }
  $scratch = $null
  for ($i = 0; $i -lt 5; $i++) {
    $scratch = CertificateFor $scratchName
    if ($scratch.StartsWith($made.Thumbprint)) { break }
    Start-Sleep -Seconds 1
  }
  Say "  $scratchName -> $scratch (expected $($made.Thumbprint))"
  $file = FileFor $scratchName
  Say "  the scratch site's file: $file"
  $imported = Get-Item "Cert:\LocalMachine\WebHosting\$($made.Thumbprint)" -ErrorAction SilentlyContinue
  Say "  in WebHosting: $([bool]$imported) '$($imported.FriendlyName)'; exportable key: $(try { $imported.PrivateKey.CspKeyContainerInfo.Exportable } catch { 'n/a' })"
  Say "  the scratch site's bindings: $((Get-WebBinding -Name $site | ForEach-Object { "$($_.protocol) $($_.bindingInformation) sslFlags=$($_.sslFlags)" }) -join ', ')"
  $same = $true
  foreach ($name in $before.Keys) {
    $now = CertificateFor $name
    $kept = $now -eq $before[$name]
    if (-not $kept) { $same = $false }
    Say "  $name -> $now $(if ($kept) { '(as before)' } else { '(CHANGED)' })"
  }
  Say "  site-bindings.ps1 again, nothing changed: $(@(& $Bindings -Store $store -Site $site -ServiceName 'none' 6>&1).Count) lines"

  Remove-Item (Join-Path $store "$scratchName.pfx")
  Say "  site-bindings.ps1 with the file removed:"
  foreach ($line in (& $Bindings -Store $store -Site $site -ServiceName 'none' 6>&1)) { Say "    $line" }
  $left = @(Get-WebBinding -Name $site -Protocol https).Count
  $entry = SniEntry $scratchName
  $certificateLeft = Test-Path "Cert:\LocalMachine\WebHosting\$($made.Thumbprint)"
  Say "  after: https bindings $left, HTTP.sys entry $(if ($entry) { $entry } else { 'none' }), certificate in WebHosting $certificateLeft"
  $served = $scratch.StartsWith($made.Thumbprint) -and $file -eq 'cgw-spike'
  $gone = $left -eq 0 -and -not $entry -and -not $certificateLeft

  Say '  ACME''s path on port 80:'
  $holder = @(Get-Website | Where-Object { $_.bindings.Collection | Where-Object { $_.protocol -eq 'http' -and $_.bindingInformation -eq '*:80:' } })
  if ($holder.Count -ne 1) { throw "Expected one site holding the catch-all http binding, found $($holder.Count)." }
  $redirectAt = "$($holder[0].name)/.well-known/acme-challenge"
  if (Get-WebConfigurationLocation -Name $redirectAt -ErrorAction SilentlyContinue) { throw "A configuration for $redirectAt is there already: stop here." }
  $probe = "/.well-known/acme-challenge/cgw-spike-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
  $portalName = @(Get-WebBinding -Protocol http | Where-Object { ($_.bindingInformation -split ':')[2] } | ForEach-Object { ($_.bindingInformation -split ':')[2] } | Where-Object { $_ -ne $scratchName })[0]
  $beforeProbe = HttpAt $scratchName $probe
  $beforeRoot = HttpAt $scratchName '/'
  $beforeOther = if ($portalName) { HttpAt $portalName $probe } else { 'none' }
  Set-WebConfiguration -PSPath 'MACHINE/WEBROOT/APPHOST' -Location $redirectAt -Filter system.webServer/httpRedirect -Value @{ enabled = $true; destination = "https://$SitesHost`$V"; exactDestination = $true; httpResponseStatus = 'Found' }
  $redirectAdded = $true
  Start-Sleep -Seconds 1
  $afterProbe = HttpAt $scratchName $probe
  $afterRoot = HttpAt $scratchName '/'
  $afterOther = if ($portalName) { HttpAt $portalName $probe } else { 'none' }
  Say "    on $($holder[0].name), a name nobody binds: $probe was '$beforeProbe', now '$afterProbe'; / was '$beforeRoot', now '$afterRoot'"
  Say "    $portalName (bound on 80 by another site): was '$beforeOther', now '$afterOther'"
  Remove-WebConfigurationLocation -Name $redirectAt
  $redirectAdded = $false
  $redirected = $afterProbe -eq "302 https://$SitesHost$probe" -and $afterRoot -eq $beforeRoot -and $afterOther -eq $beforeOther
  Say "    removed again: $(-not (Get-WebConfigurationLocation -Name $redirectAt -ErrorAction SilentlyContinue))"
  Say ''
  Say "Result: the scratch name served by its own certificate: $served; every other name kept its certificate: $same; all of it gone again: $gone; ACME's path alone sent to $SitesHost`: $redirected."
} finally {
  Remove-Item Env:\CGW_SITES_CERT_PASSWORD -ErrorAction SilentlyContinue
  if ($redirectAdded) { Remove-WebConfigurationLocation -Name $redirectAt -ErrorAction SilentlyContinue }
  if ($scratchName -and (SniEntry $scratchName)) { & netsh http delete sslcert "hostnameport=${scratchName}:443" | Out-Null }
  if (Test-Path "IIS:\Sites\$site") { Remove-WebSite -Name $site }
  if ($made) {
    Remove-Item "Cert:\LocalMachine\My\$($made.Thumbprint)" -ErrorAction SilentlyContinue
    Remove-Item "Cert:\LocalMachine\WebHosting\$($made.Thumbprint)" -ErrorAction SilentlyContinue
  }
  if (Test-Path $folder) { Remove-Item -Recurse -Force $folder }
  # The store's settings an earlier try left, naming one of this spike's scratch folders.
  $ccs = Get-ItemProperty $ccsKey -ErrorAction SilentlyContinue
  if ($ccs -and -not $ccs.Enabled -and "$($ccs.CertStoreLocation)" -like "*\cgw-domains-spike-*") {
    foreach ($value in 'CertStoreLocation', 'UserName', 'Password', 'PrivateKeyPassword') {
      Remove-ItemProperty $ccsKey -Name $value -ErrorAction SilentlyContinue
    }
    Say '  cleared the store settings an earlier try left'
  }
  Say '  removed: the scratch site, its folder and certificate'
  $lines | Set-Content -Path $Out -Encoding utf8
  Write-Host "Written to $Out"
}
