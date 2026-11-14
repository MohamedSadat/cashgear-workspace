<#
.SYNOPSIS
  Installs or updates the Cash Gear Workspace server on a Windows host with IIS (Q6): the API as
  its own IIS site and app pool, the worker as a Windows service, and the database migrations.
  Run as an administrator from the unpacked deploy package. docs/OPERATIONS.md is the runbook.

.DESCRIPTION
  No secret is passed on the command line or written to a file by this script. The SQL
  connection uses Windows authentication as the app pool's and the service's identity; Blob
  Storage uses an Azure AD identity (DefaultAzureCredential); the OpenID Connect certificates are
  in LocalMachine\My, named by thumbprint. The one secret, the SMTP password, is read from the
  environment of the session that runs this script and stored as an app-pool and service
  environment variable, which only administrators can read.

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
  [string] $AzureCertificatePath = ''
)

$ErrorActionPreference = 'Stop'
Import-Module WebAdministration
$package = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$manifest = Get-Content (Join-Path $package 'manifest.json') -Raw | ConvertFrom-Json
Write-Host "Installing Cash Gear Workspace server $($manifest.version) ($($manifest.commit)) to $Root"

$trust = if ($TrustServerCertificate) { 'true' } else { 'false' }
$connection = "Server=$SqlServer;Database=$Database;Integrated Security=true;Encrypt=true;TrustServerCertificate=$trust"
$builtIn = -not $ServiceAccount
$poolIdentity = if ($builtIn) { "IIS AppPool\$SiteName" } else { $ServiceAccount }
$workerIdentity = if ($builtIn) { "NT SERVICE\$ServiceName" } else { $ServiceAccount }
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

# The event log sources the API and the worker write to; registering one needs an administrator.
foreach ($source in 'Cash Gear Workspace API', 'Cash Gear Workspace worker') {
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

# 2. Stop the worker and the site, copy the new files.
if (Get-Service $ServiceName -ErrorAction SilentlyContinue) { Stop-Service $ServiceName -Force }
if (Test-Path "IIS:\Sites\$SiteName") { Stop-WebSite $SiteName }
# A stopped site leaves its app pool's process running with the old files loaded: stop the pool
# too, and wait for it, or the copy meets locked files.
if (Test-Path "IIS:\AppPools\$SiteName") {
  if ((Get-WebAppPoolState $SiteName).Value -ne 'Stopped') { Stop-WebAppPool $SiteName }
  $deadline = (Get-Date).AddSeconds(60)
  while ((Get-WebAppPoolState $SiteName).Value -ne 'Stopped') {
    if ((Get-Date) -gt $deadline) { throw "The app pool $SiteName did not stop within a minute" }
    Start-Sleep -Seconds 1
  }
}
foreach ($part in 'api', 'worker') {
  $target = Join-Path $Root $part
  New-Item -ItemType Directory -Force $target | Out-Null
  # A few short retries, not robocopy's default of a million 30-second waits.
  robocopy (Join-Path $package $part) $target /MIR /R:5 /W:2 /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "Copying $part failed ($LASTEXITCODE)" }
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
}

# 6. Start, then check.
if ((Get-WebAppPoolState $SiteName).Value -ne 'Started') { Start-WebAppPool $SiteName }
Start-WebSite $SiteName
Start-Service $ServiceName
Start-Sleep -Seconds 5
$ready = Invoke-WebRequest "https://$HostName/health/ready" -UseBasicParsing -TimeoutSec 30
Write-Host "Health: $($ready.StatusCode) $($ready.Content)"
