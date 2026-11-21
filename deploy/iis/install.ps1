<#
.SYNOPSIS
  Installs or updates the Cash Gear Workspace server on a Windows host with IIS (Q6): the API as
  its own IIS site and app pool, the worker as a Windows service, (Phase 9) the Sites process as a
  third IIS site and app pool on the published sites' own host name and (Phase 10) on the plugins'
  host name too, and the database migrations.
  Run as an administrator from the unpacked deploy package. docs/OPERATIONS.md is the runbook.

.DESCRIPTION
  No secret is passed on the command line or written to a file by this script. The SQL
  connection uses Windows authentication as the app pool's and the service's identity; Blob
  Storage uses an Azure AD identity (DefaultAzureCredential); the OpenID Connect certificates are
  in LocalMachine\My, named by thumbprint. The one secret, the SMTP password, is read from the
  environment of the session that runs this script and stored as an app-pool and service
  environment variable, which only administrators can read. Phase 13: Cash Gear's own AI keys for
  its subscription are read the same way (CGW_AI_ANTHROPIC_KEY, CGW_AI_VOYAGE_KEY), and given to the
  API and the worker only.

  On a host outside a domain (no gMSA), leave out -ServiceAccount: the app pool runs as its own
  ApplicationPoolIdentity and the worker as its virtual account (NT SERVICE\<service name>), and
  the script gives both a SQL login and user, read access to the OpenID Connect certificates'
  private keys and to the Azure certificate file. Blob Storage then goes through a service
  principal: -AzureClientId, -AzureTenantId and -AzureCertificatePath (a PFX without a password,
  readable only by administrators and the two identities).

.EXAMPLE
  .\deploy\iis\install.ps1 -Root C:\CashGearWorkspace -HostName workspace-api.cashgearerp.com `
    -CertificateThumbprint <https cert> -SigningThumbprint <cert> -EncryptionThumbprint <cert> `
    -SqlServer sql01 -Database CashGearWorkspace -BlobServiceUri https://<account>.blob.core.windows.net `
    -WebOrigin https://workspace.cashgearerp.com -SmtpHost smtp.example.com -SmtpUser workspace@example.com `
    -ServiceAccount 'DOMAIN\cgw-workspace$'

.EXAMPLE
  # A workgroup host: built-in identities, the HTTPS certificate in WebHosting, a local SQL Server
  # with its self-signed certificate, Blob Storage through a service principal.
  .\deploy\iis\install.ps1 -Root C:\CashGearWorkspace -HostName workspace-api.cashgearerp.com `
    -CertificateThumbprint <https cert> -CertificateStore WebHosting `
    -SigningThumbprint <cert> -EncryptionThumbprint <cert> `
    -SqlServer '.\MSSQLSERVER01' -TrustServerCertificate -Database CashGearWorkspace `
    -BlobServiceUri https://<account>.blob.core.windows.net -WebOrigin https://workspace.cashgearerp.com `
    -SmtpHost smtp.example.com -SmtpUser workspace@example.com `
    -AzureClientId <app id> -AzureTenantId <tenant id> -AzureCertificatePath C:\CashGearWorkspace\secrets\azure-storage.pfx
#>
[CmdletBinding(SupportsShouldProcess)]
param(
  [Parameter(Mandatory)] [string] $Root,
  [Parameter(Mandatory)] [string] $HostName,
  [Parameter(Mandatory)] [string] $CertificateThumbprint,
  [Parameter(Mandatory)] [string] $SigningThumbprint,
  [Parameter(Mandatory)] [string] $EncryptionThumbprint,
  [Parameter(Mandatory)] [string] $SqlServer,
  [Parameter(Mandatory)] [string] $Database,
  [Parameter(Mandatory)] [string] $BlobServiceUri,
  [Parameter(Mandatory)] [string] $WebOrigin,
  [Parameter(Mandatory)] [string] $SmtpHost,
  [int] $SmtpPort = 587,
  [string] $SmtpUser = '',
  [string] $SmtpFrom = 'Cash Gear Workspace <no-reply@cashgearerp.com>',
  [string] $SiteName = 'CashGearWorkspaceApi',
  [string] $ServiceName = 'CashGearWorkspaceWorker',
  # Phase 5: where Cash Gear Sheet is (its launch links, and the origins allowed to redeem them and
  # to read workbooks) and the one ERP API an ERP link may name. The server refuses to start
  # without them in Production.
  [string] $SheetOrigin = 'https://sheet.cashgearerp.com',
  [string[]] $SheetOrigins = @('https://sheet.cashgearerp.com'),
  [string] $ErpApiBase = 'https://api.cashgearerp.com',
  # A group managed service account (gMSA) or a domain account; the app pool runs as the same.
  # Left out: the built-in identities (see the description).
  [string] $ServiceAccount = '',
  # The store the HTTPS certificate is in (My, or WebHosting where IIS keeps site certificates).
  # The binding is by host name (SNI), so other sites on port 443 keep their own certificates.
  [string] $CertificateStore = 'My',
  # A SQL Server on this host with its own self-signed certificate: still encrypted, not verified.
  [switch] $TrustServerCertificate,
  # A service principal for Blob Storage on a host with no managed identity (DefaultAzureCredential
  # reads these three from the environment).
  [string] $AzureClientId = '',
  [string] $AzureTenantId = '',
  [string] $AzureCertificatePath = '',
  # Phase 9: the published sites, on an origin of their own (never the API's or the web app's, so a
  # published page can read neither's session), in an IIS site and app pool of their own. The
  # certificate defaults to the API's (a *.cashgearerp.com certificate covers both names).
  [string] $SitesHostName = 'pages.cashgearerp.com',
  [string] $SitesSiteName = 'CashGearWorkspaceSites',
  [string] $SitesCertificateThumbprint = '',
  # Phase 10: third-party plugins' files, on an origin of their own (never the API's, the web app's
  # or the sites'), served by the same Sites site under a second host-name binding. The certificate
  # defaults to the sites' (a *.cashgearerp.com certificate covers it).
  [string] $PluginsHostName = 'plugins.cashgearerp.com',
  [string] $PluginsCertificateThumbprint = '',
  # Phase 11: the passkeys' relying party, the API's own host (never a wider domain: the ERP, the
  # sites and the plugins could then ask for assertions). The API refuses to start in Production
  # without it, or with any other name than -HostName.
  [string] $PasskeyDomain = 'workspace-api.cashgearerp.com',
  # Phase 13: the local embedding model's package (the zip scripts/local-model.mjs makes), unpacked
  # to <Root>\models\voyage-4-nano for the API and the worker, never the sites. Left out on an
  # update, a package unpacked before is kept. The server loads it only if its files are the ones
  # pinned in its code.
  [string] $LocalModel = '',
  # Phase 13: the processor threads one embedding by the local model takes (0: half the
  # processors, at most 8).
  [int] $LocalModelThreads = 0,
  # Phase 13: Cash Gear's subscription, a workspace's allowance a month in tokens, for AI and for
  # search by meaning (0: not offered), and a workspace's own, by its id. The keys come from this
  # session's environment only: CGW_AI_ANTHROPIC_KEY and CGW_AI_VOYAGE_KEY.
  [long] $AiMonthlyTokens = 0,
  [long] $AiEmbeddingsMonthlyTokens = 0,
  [hashtable] $AiWorkspaceMonthlyTokens = @{},
  [hashtable] $AiWorkspaceEmbeddingsMonthlyTokens = @{}
)

$ErrorActionPreference = 'Stop'
if ($PasskeyDomain -ne $HostName) {
  throw "-PasskeyDomain ($PasskeyDomain) must be the API's host name, -HostName ($HostName): passkeys are made for the API's own host."
}
Import-Module WebAdministration
$package = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$manifest = Get-Content (Join-Path $package 'manifest.json') -Raw | ConvertFrom-Json
Write-Host "Installing Cash Gear Workspace server $($manifest.version) ($($manifest.commit)) to $Root"

$trust = if ($TrustServerCertificate) { 'true' } else { 'false' }
$connection = "Server=$SqlServer;Database=$Database;Integrated Security=true;Encrypt=true;TrustServerCertificate=$trust"
$builtIn = -not $ServiceAccount
$poolIdentity = if ($builtIn) { "IIS AppPool\$SiteName" } else { $ServiceAccount }
$workerIdentity = if ($builtIn) { "NT SERVICE\$ServiceName" } else { $ServiceAccount }
$sitesIdentity = if ($builtIn) { "IIS AppPool\$SitesSiteName" } else { $ServiceAccount }
if (-not $SitesCertificateThumbprint) { $SitesCertificateThumbprint = $CertificateThumbprint }
if (-not $PluginsCertificateThumbprint) { $PluginsCertificateThumbprint = $SitesCertificateThumbprint }
$environment = [ordered]@{
  ASPNETCORE_ENVIRONMENT = 'Production'
  DOTNET_ENVIRONMENT = 'Production'
  ConnectionStrings__Sql = $connection
  Blob__ServiceUri = $BlobServiceUri
  Blob__Container = 'workspace'
  Api__PublicUrl = "https://$HostName"
  Web__AppUrl = $WebOrigin
  Web__Origins__0 = $WebOrigin
  Web__Origins__1 = 'http://tauri.localhost'
  Web__Origins__2 = 'tauri://localhost'
  Sheet__Origin = $SheetOrigin
  Erp__ApiBase = $ErpApiBase
  # Phase 9: the sites' origin, for the addresses the API gives out; required in Production.
  Sites__PublicUrl = "https://$SitesHostName"
  # Phase 10: the plugins' origin, for the frames' addresses the API gives out; required in Production.
  Plugins__PublicUrl = "https://$PluginsHostName"
  # Phase 11: the passkeys' relying party id (the API's host); required in Production.
  Identity__Passkeys__ServerDomain = $PasskeyDomain
  OpenIddict__SigningCertificateThumbprint = $SigningThumbprint
  OpenIddict__EncryptionCertificateThumbprint = $EncryptionThumbprint
  DataProtection__Dpapi = 'true'
  Smtp__Host = $SmtpHost
  Smtp__Port = "$SmtpPort"
  Smtp__User = $SmtpUser
  Smtp__From = $SmtpFrom
  Logging__Format = 'json'
  # ASP.NET Core's own request lines name the path and query string: confirmation and reset
  # links carry their token there. Warnings and errors still come through.
  'Logging__LogLevel__Microsoft.AspNetCore' = 'Warning'
  # The console goes nowhere under IIS or as a service: warnings, errors and each mail sent or not
  # also go to the Application event log (sources registered below).
  Logging__EventLog__Enabled = 'true'
}
for ($i = 0; $i -lt $SheetOrigins.Count; $i++) { $environment["Sheet__Origins__$i"] = $SheetOrigins[$i] }
if ($AzureClientId) {
  $environment['AZURE_CLIENT_ID'] = $AzureClientId
  $environment['AZURE_TENANT_ID'] = $AzureTenantId
  $environment['AZURE_CLIENT_CERTIFICATE_PATH'] = $AzureCertificatePath
}
# The SMTP password comes from this session's environment, never from a parameter or a file.
if ($env:CGW_SMTP_PASSWORD) { $environment['Smtp__Password'] = $env:CGW_SMTP_PASSWORD }
# Phase 13: Cash Gear's AI keys for its subscription, the same way; the allowances are not secrets.
if ($env:CGW_AI_ANTHROPIC_KEY) { $environment['Ai__Subscription__AnthropicKey'] = $env:CGW_AI_ANTHROPIC_KEY }
if ($env:CGW_AI_VOYAGE_KEY) { $environment['Ai__Subscription__VoyageKey'] = $env:CGW_AI_VOYAGE_KEY }
if ($AiMonthlyTokens -gt 0) { $environment['Ai__Subscription__MonthlyTokens'] = "$AiMonthlyTokens" }
if ($AiEmbeddingsMonthlyTokens -gt 0) { $environment['Ai__Subscription__EmbeddingsMonthlyTokens'] = "$AiEmbeddingsMonthlyTokens" }
foreach ($id in $AiWorkspaceMonthlyTokens.Keys) {
  $environment["Ai__Subscription__Workspaces__$([guid]$id)__MonthlyTokens"] = "$([long]$AiWorkspaceMonthlyTokens[$id])"
}
foreach ($id in $AiWorkspaceEmbeddingsMonthlyTokens.Keys) {
  $environment["Ai__Subscription__Workspaces__$([guid]$id)__EmbeddingsMonthlyTokens"] = "$([long]$AiWorkspaceEmbeddingsMonthlyTokens[$id])"
}
# Phase 13: the local model, where step 2 unpacks it (or kept from an earlier install).
$modelFolder = Join-Path $Root 'models\voyage-4-nano'
if ($LocalModel) {
  if (-not (Test-Path $LocalModel -PathType Leaf)) { throw "-LocalModel: no file at $LocalModel" }
}
if ($LocalModel -or (Test-Path (Join-Path $modelFolder 'cgw-model.json'))) {
  $environment['Ai__LocalModel__Path'] = $modelFolder
  if ($LocalModelThreads -gt 0) { $environment['Ai__LocalModel__Threads'] = "$LocalModelThreads" }
}

# Phase 9: the Sites process reads the database and Blob Storage with the same names, and is given
# nothing else: no SMTP password, no OpenID Connect certificates, no Data Protection. Phase 10: the
# plugins' origin and the Workspace origins that may frame a plugin (it finds frame tickets by their
# hash in the database: no key of any kind).
$sitesEnvironment = [ordered]@{
  ASPNETCORE_ENVIRONMENT = 'Production'
  DOTNET_ENVIRONMENT = 'Production'
  ConnectionStrings__Sql = $connection
  Blob__ServiceUri = $BlobServiceUri
  Blob__Container = 'workspace'
  Plugins__PublicUrl = "https://$PluginsHostName"
  Web__Origins__0 = $WebOrigin
  Web__Origins__1 = 'http://tauri.localhost'
  Web__Origins__2 = 'tauri://localhost'
  Logging__Format = 'json'
  'Logging__LogLevel__Microsoft.AspNetCore' = 'Warning'
  Logging__EventLog__Enabled = 'true'
}
if ($AzureClientId) {
  $sitesEnvironment['AZURE_CLIENT_ID'] = $AzureClientId
  $sitesEnvironment['AZURE_TENANT_ID'] = $AzureTenantId
  $sitesEnvironment['AZURE_CLIENT_CERTIFICATE_PATH'] = $AzureCertificatePath
}

# The event log sources the API, the worker and the sites write to; registering one needs an administrator.
foreach ($source in 'Cash Gear Workspace API', 'Cash Gear Workspace worker', 'Cash Gear Workspace sites') {
  if (-not [System.Diagnostics.EventLog]::SourceExists($source)) { New-EventLog -LogName Application -Source $source }
}

# Phase 6: the real-time hub (/api/v1/realtime) is a WebSocket in the API's own site, which IIS
# passes on only with its WebSocket Protocol feature. Turned on once, before the site starts; a
# host that has it is left as it is.
if (Get-Command Install-WindowsFeature -ErrorAction SilentlyContinue) {
  # Windows Server.
  if (-not (Get-WindowsFeature Web-WebSockets).Installed) {
    Write-Host 'Turning on IIS WebSocket Protocol...'
    Install-WindowsFeature Web-WebSockets | Out-Null
  }
} else {
  # Client Windows (a test host).
  if ((Get-WindowsOptionalFeature -Online -FeatureName IIS-WebSockets).State -ne 'Enabled') {
    Write-Host 'Turning on IIS WebSocket Protocol...'
    Enable-WindowsOptionalFeature -Online -FeatureName IIS-WebSockets -All -NoRestart | Out-Null
  }
}

# 1. The migrations, before any new code runs. A failed migration stops here, with the old
#    version still serving.
Write-Host 'Migrating the database...'
& (Join-Path $package 'migrate\efbundle.exe') --connection $connection
if ($LASTEXITCODE -ne 0) { throw "The migration failed ($LASTEXITCODE); nothing else was changed." }

# 2. Stop the worker and the sites, copy the new files.
if (Get-Service $ServiceName -ErrorAction SilentlyContinue) { Stop-Service $ServiceName -Force }
foreach ($site in $SiteName, $SitesSiteName) {
  if (Test-Path "IIS:\Sites\$site") { Stop-WebSite $site }
  # A stopped site leaves its app pool's process running with the old files loaded: stop the pool
  # too, and wait for it, or the copy meets locked files.
  if (Test-Path "IIS:\AppPools\$site") {
    if ((Get-WebAppPoolState $site).Value -ne 'Stopped') { Stop-WebAppPool $site }
    # IIS lets open requests run for the pool's shutdownTimeLimit (90 s by default) before it ends
    # them, and the real-time hub's WebSockets stay open until then: wait that long and a little
    # more. Waiting a fixed minute failed the 0.12.0 install with people connected.
    $limit = (Get-ItemProperty "IIS:\AppPools\$site" -Name processModel.shutdownTimeLimit).Value.TotalSeconds
    $wait = [Math]::Max(60, [int]$limit + 30)
    $deadline = (Get-Date).AddSeconds($wait)
    while ((Get-WebAppPoolState $site).Value -ne 'Stopped') {
      if ((Get-Date) -gt $deadline) { throw "The app pool $site did not stop within $wait seconds" }
      Start-Sleep -Seconds 1
    }
  }
}
foreach ($part in 'api', 'worker', 'sites') {
  $target = Join-Path $Root $part
  New-Item -ItemType Directory -Force $target | Out-Null
  # A few short retries, not robocopy's default of a million 30-second waits.
  robocopy (Join-Path $package $part) $target /MIR /R:5 /W:2 /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "Copying $part failed ($LASTEXITCODE)" }
}
# Phase 13: the local model's package, unpacked beside the parts while the API and the worker are
# stopped (they hold the model in memory, not the file). Unpacked whole, then put in place.
if ($LocalModel) {
  Write-Host "Unpacking the local model from $LocalModel..."
  $staging = Join-Path $Root "models\unpacking-$([guid]::NewGuid().ToString('N'))"
  Expand-Archive -Path $LocalModel -DestinationPath $staging
  if (-not (Test-Path (Join-Path $staging 'cgw-model.json'))) {
    Remove-Item -Recurse -Force $staging
    throw "-LocalModel: $LocalModel holds no cgw-model.json (make it with node scripts/local-model.mjs)"
  }
  if (Test-Path $modelFolder) { Remove-Item -Recurse -Force $modelFolder }
  Move-Item $staging $modelFolder
}

# 3. The app pool and the site: no managed code (ASP.NET Core Module), its own identity.
if (-not (Test-Path "IIS:\AppPools\$SiteName")) { New-WebAppPool $SiteName | Out-Null }
Set-ItemProperty "IIS:\AppPools\$SiteName" -Name managedRuntimeVersion -Value ''
if ($builtIn) {
  Set-ItemProperty "IIS:\AppPools\$SiteName" -Name processModel.identityType -Value ApplicationPoolIdentity
} else {
  Set-ItemProperty "IIS:\AppPools\$SiteName" -Name processModel -Value @{ identityType = 3; userName = $ServiceAccount; password = '' }
}
# The Azure certificate file is loaded with the identity's profile.
Set-ItemProperty "IIS:\AppPools\$SiteName" -Name processModel.loadUserProfile -Value $true
Set-ItemProperty "IIS:\AppPools\$SiteName" -Name startMode -Value AlwaysRunning
& "$env:windir\system32\inetsrv\appcmd.exe" clear config -section:system.applicationHost/applicationPools "/[name='$SiteName'].environmentVariables" | Out-Null
foreach ($name in $environment.Keys) {
  & "$env:windir\system32\inetsrv\appcmd.exe" set config -section:system.applicationHost/applicationPools "/+[name='$SiteName'].environmentVariables.[name='$name',value='$($environment[$name])']" | Out-Null
}
if (-not (Test-Path "IIS:\Sites\$SiteName")) {
  # SslFlags 1: Server Name Indication, so the certificate is bound to this host name only and
  # the host's other sites on 443 (and its 0.0.0.0:443 default) are left as they are.
  New-WebSite -Name $SiteName -PhysicalPath (Join-Path $Root 'api') -ApplicationPool $SiteName -HostHeader $HostName -Port 443 -Ssl -SslFlags 1 | Out-Null
  $binding = Get-WebBinding -Name $SiteName -Protocol https
  $binding.AddSslCertificate($CertificateThumbprint, $CertificateStore)
} else {
  Set-ItemProperty "IIS:\Sites\$SiteName" -Name physicalPath -Value (Join-Path $Root 'api')
}
# The site's W3C log keeps IIS's default fields except the query string (UriQuery), for the
# same reason: a token in a mailed link must not land in a log file.
Set-ItemProperty "IIS:\Sites\$SiteName" -Name logFile.logExtFileFlags `
  -Value 'Date,Time,ClientIP,UserName,ServerIP,Method,UriStem,HttpStatus,Win32Status,TimeTaken,ServerPort,UserAgent,Referer,HttpSubStatus'

# 3b. Phase 9: the sites' app pool and site, on their own host name, as the API's are made.
if (-not (Test-Path "IIS:\AppPools\$SitesSiteName")) { New-WebAppPool $SitesSiteName | Out-Null }
Set-ItemProperty "IIS:\AppPools\$SitesSiteName" -Name managedRuntimeVersion -Value ''
if ($builtIn) {
  Set-ItemProperty "IIS:\AppPools\$SitesSiteName" -Name processModel.identityType -Value ApplicationPoolIdentity
} else {
  Set-ItemProperty "IIS:\AppPools\$SitesSiteName" -Name processModel -Value @{ identityType = 3; userName = $ServiceAccount; password = '' }
}
Set-ItemProperty "IIS:\AppPools\$SitesSiteName" -Name processModel.loadUserProfile -Value $true
Set-ItemProperty "IIS:\AppPools\$SitesSiteName" -Name startMode -Value AlwaysRunning
& "$env:windir\system32\inetsrv\appcmd.exe" clear config -section:system.applicationHost/applicationPools "/[name='$SitesSiteName'].environmentVariables" | Out-Null
foreach ($name in $sitesEnvironment.Keys) {
  & "$env:windir\system32\inetsrv\appcmd.exe" set config -section:system.applicationHost/applicationPools "/+[name='$SitesSiteName'].environmentVariables.[name='$name',value='$($sitesEnvironment[$name])']" | Out-Null
}
if (-not (Test-Path "IIS:\Sites\$SitesSiteName")) {
  New-WebSite -Name $SitesSiteName -PhysicalPath (Join-Path $Root 'sites') -ApplicationPool $SitesSiteName -HostHeader $SitesHostName -Port 443 -Ssl -SslFlags 1 | Out-Null
  $binding = Get-WebBinding -Name $SitesSiteName -Protocol https -HostHeader $SitesHostName
  $binding.AddSslCertificate($SitesCertificateThumbprint, $CertificateStore)
} else {
  Set-ItemProperty "IIS:\Sites\$SitesSiteName" -Name physicalPath -Value (Join-Path $Root 'sites')
}
# Phase 10: the plugins' host name, a second binding of the same site (by SNI, as the first).
if (-not (Get-WebBinding -Name $SitesSiteName -Protocol https -HostHeader $PluginsHostName)) {
  New-WebBinding -Name $SitesSiteName -Protocol https -Port 443 -HostHeader $PluginsHostName -SslFlags 1 | Out-Null
  $binding = Get-WebBinding -Name $SitesSiteName -Protocol https -HostHeader $PluginsHostName
  $binding.AddSslCertificate($PluginsCertificateThumbprint, $CertificateStore)
}
# A site's page addresses carry no secret, but its log keeps the same fields as the API's.
Set-ItemProperty "IIS:\Sites\$SitesSiteName" -Name logFile.logExtFileFlags `
  -Value 'Date,Time,ClientIP,UserName,ServerIP,Method,UriStem,HttpStatus,Win32Status,TimeTaken,ServerPort,UserAgent,Referer,HttpSubStatus'

# 4. The worker as a service, with its environment in the service's own registry key.
$exe = Join-Path $Root 'worker\Cgw.Worker.exe'
if (-not (Get-Service $ServiceName -ErrorAction SilentlyContinue)) {
  New-Service -Name $ServiceName -BinaryPathName "`"$exe`"" -DisplayName 'Cash Gear Workspace worker' -StartupType Automatic | Out-Null
}
& sc.exe config $ServiceName obj= $workerIdentity | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Setting the worker's account failed ($LASTEXITCODE)" }
& sc.exe failure $ServiceName reset= 86400 actions= restart/5000/restart/30000/restart/60000 | Out-Null
$values = $environment.Keys | ForEach-Object { "$_=$($environment[$_])" }
Set-ItemProperty "HKLM:\SYSTEM\CurrentControlSet\Services\$ServiceName" -Name Environment -Type MultiString -Value $values

# 5. The built-in identities exist only now: give them the database and the keys they read.
if ($builtIn) {
  Write-Host "Granting $poolIdentity and $workerIdentity..."
  $sql = New-Object System.Data.SqlClient.SqlConnection "Server=$SqlServer;Database=$Database;Integrated Security=true"
  $sql.Open()
  try {
    foreach ($identity in $poolIdentity, $workerIdentity) {
      $command = $sql.CreateCommand()
      # The roles OPERATIONS.md names for the app's identity. Names are bracketed; they come from
      # this script's own parameters.
      $command.CommandText = @"
IF SUSER_ID(N'$identity') IS NULL CREATE LOGIN [$identity] FROM WINDOWS;
IF USER_ID(N'$identity') IS NULL CREATE USER [$identity] FOR LOGIN [$identity];
ALTER ROLE db_datareader ADD MEMBER [$identity];
ALTER ROLE db_datawriter ADD MEMBER [$identity];
ALTER ROLE db_ddladmin ADD MEMBER [$identity];
"@
      $command.ExecuteNonQuery() | Out-Null
    }
    # Phase 9: the Sites process only reads. Phase 10: and never the Data Protection key ring: a
    # process that serves the public must not be able to open a workspace's AI key's cipher.
    $command = $sql.CreateCommand()
    $command.CommandText = @"
IF SUSER_ID(N'$sitesIdentity') IS NULL CREATE LOGIN [$sitesIdentity] FROM WINDOWS;
IF USER_ID(N'$sitesIdentity') IS NULL CREATE USER [$sitesIdentity] FOR LOGIN [$sitesIdentity];
ALTER ROLE db_datareader ADD MEMBER [$sitesIdentity];
DENY SELECT ON [dbo].[DataProtectionKeys] TO [$sitesIdentity];
"@
    $command.ExecuteNonQuery() | Out-Null
  } finally { $sql.Close() }

  $keyFiles = foreach ($thumbprint in $SigningThumbprint, $EncryptionThumbprint) {
    $certificate = Get-Item "Cert:\LocalMachine\My\$thumbprint"
    $key = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($certificate)
    $name = if ($key -is [System.Security.Cryptography.RSACng]) { $key.Key.UniqueName } else { $key.CspKeyContainerInfo.UniqueKeyContainerName }
    @("$env:ProgramData\Microsoft\Crypto\Keys\$name", "$env:ProgramData\Microsoft\Crypto\RSA\MachineKeys\$name") |
      Where-Object { Test-Path $_ } | Select-Object -First 1
  }
  if ($AzureCertificatePath) { $keyFiles += $AzureCertificatePath }
  foreach ($file in $keyFiles) {
    foreach ($identity in $poolIdentity, $workerIdentity) {
      & icacls.exe $file /grant "${identity}:R" | Out-Null
      if ($LASTEXITCODE -ne 0) { throw "Granting $identity read on $file failed ($LASTEXITCODE)" }
    }
  }
  # The sites read Blob Storage through the same service principal: its certificate file only,
  # never the OpenID Connect keys.
  if ($AzureCertificatePath) {
    & icacls.exe $AzureCertificatePath /grant "${sitesIdentity}:R" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Granting $sitesIdentity read on $AzureCertificatePath failed ($LASTEXITCODE)" }
  }
}

# Phase 10: with one service account for all three, the sites' identity is the API's and cannot be
# denied the key ring's table. Say so: run the sites' app pool as an account of its own, and deny it.
if (-not $builtIn) {
  Write-Warning "The sites' app pool runs as $ServiceAccount, as the API does: it can read the Data Protection key ring (DataProtectionKeys). Give it an account of its own with db_datareader and DENY SELECT ON dbo.DataProtectionKeys (docs/OPERATIONS.md)."
}

# 6. Start, then check.
foreach ($site in $SiteName, $SitesSiteName) {
  if ((Get-WebAppPoolState $site).Value -ne 'Started') { Start-WebAppPool $site }
  Start-WebSite $site
}
Start-Service $ServiceName
Start-Sleep -Seconds 5
$ready = Invoke-WebRequest "https://$HostName/health/ready" -UseBasicParsing -TimeoutSec 30
Write-Host "Health: $($ready.StatusCode) $($ready.Content)"
$sites = Invoke-WebRequest "https://$SitesHostName/health/live" -UseBasicParsing -TimeoutSec 30
Write-Host "Sites: $($sites.StatusCode) $($sites.Content)"
# Phase 10: the plugins' host answers nothing but a plugin's file under a ticket: its 404 page says
# the binding and the certificate work.
try {
  Invoke-WebRequest "https://$PluginsHostName/" -UseBasicParsing -TimeoutSec 30 | Out-Null
  Write-Host 'Plugins: answered (expected 404)'
} catch [System.Net.WebException] {
  $status = [int]$_.Exception.Response.StatusCode
  if ($status -ne 404) { throw "The plugins host answered $status, not its 404 page" }
  Write-Host 'Plugins: 404 page (as it should be)'
}
