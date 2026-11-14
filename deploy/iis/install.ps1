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

.EXAMPLE
  .\deploy\iis\install.ps1 -Root C:\CashGearWorkspace -HostName workspace-api.cashgearerp.com `
    -CertificateThumbprint <https cert> -SigningThumbprint <cert> -EncryptionThumbprint <cert> `
    -SqlServer sql01 -Database CashGearWorkspace -BlobServiceUri https://<account>.blob.core.windows.net `
    -WebOrigin https://workspace.cashgearerp.com -SmtpHost smtp.example.com -SmtpUser workspace@example.com `
    -ServiceAccount 'DOMAIN\cgw-workspace$'
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
  [Parameter(Mandatory)] [string] $ServiceAccount
)

$ErrorActionPreference = 'Stop'
Import-Module WebAdministration
$package = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$manifest = Get-Content (Join-Path $package 'manifest.json') -Raw | ConvertFrom-Json
Write-Host "Installing Cash Gear Workspace server $($manifest.version) ($($manifest.commit)) to $Root"

$connection = "Server=$SqlServer;Database=$Database;Integrated Security=true;Encrypt=true;TrustServerCertificate=false"
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
}
for ($i = 0; $i -lt $SheetOrigins.Count; $i++) { $environment["Sheet__Origins__$i"] = $SheetOrigins[$i] }
# The SMTP password comes from this session's environment, never from a parameter or a file.
if ($env:CGW_SMTP_PASSWORD) { $environment['Smtp__Password'] = $env:CGW_SMTP_PASSWORD }

# 1. The migrations, before any new code runs. A failed migration stops here, with the old
#    version still serving.
Write-Host 'Migrating the database...'
& (Join-Path $package 'migrate\efbundle.exe') --connection $connection
if ($LASTEXITCODE -ne 0) { throw "The migration failed ($LASTEXITCODE); nothing else was changed." }

# 2. Stop the worker and the site, copy the new files.
if (Get-Service $ServiceName -ErrorAction SilentlyContinue) { Stop-Service $ServiceName -Force }
if (Test-Path "IIS:\Sites\$SiteName") { Stop-WebSite $SiteName }
foreach ($part in 'api', 'worker') {
  $target = Join-Path $Root $part
  New-Item -ItemType Directory -Force $target | Out-Null
  robocopy (Join-Path $package $part) $target /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "Copying $part failed ($LASTEXITCODE)" }
}

# 3. The app pool and the site: no managed code (ASP.NET Core Module), its own identity.
if (-not (Test-Path "IIS:\AppPools\$SiteName")) { New-WebAppPool $SiteName | Out-Null }
Set-ItemProperty "IIS:\AppPools\$SiteName" -Name managedRuntimeVersion -Value ''
Set-ItemProperty "IIS:\AppPools\$SiteName" -Name processModel -Value @{ identityType = 3; userName = $ServiceAccount; password = '' }
Set-ItemProperty "IIS:\AppPools\$SiteName" -Name startMode -Value AlwaysRunning
& "$env:windir\system32\inetsrv\appcmd.exe" clear config -section:system.applicationHost/applicationPools "/[name='$SiteName'].environmentVariables" | Out-Null
foreach ($name in $environment.Keys) {
  & "$env:windir\system32\inetsrv\appcmd.exe" set config -section:system.applicationHost/applicationPools "/+[name='$SiteName'].environmentVariables.[name='$name',value='$($environment[$name])']" | Out-Null
}
if (-not (Test-Path "IIS:\Sites\$SiteName")) {
  New-WebSite -Name $SiteName -PhysicalPath (Join-Path $Root 'api') -ApplicationPool $SiteName -HostHeader $HostName -Port 443 -Ssl | Out-Null
  $binding = Get-WebBinding -Name $SiteName -Protocol https
  $binding.AddSslCertificate($CertificateThumbprint, 'My')
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
& sc.exe config $ServiceName obj= $ServiceAccount | Out-Null
& sc.exe failure $ServiceName reset= 86400 actions= restart/5000/restart/30000/restart/60000 | Out-Null
$values = $environment.Keys | ForEach-Object { "$_=$($environment[$_])" }
Set-ItemProperty "HKLM:\SYSTEM\CurrentControlSet\Services\$ServiceName" -Name Environment -Type MultiString -Value $values

# 5. Start, then check.
Start-WebSite $SiteName
Start-Service $ServiceName
Start-Sleep -Seconds 5
$ready = Invoke-WebRequest "https://$HostName/health/ready" -UseBasicParsing -TimeoutSec 30
Write-Host "Health: $($ready.StatusCode) $($ready.Content)"
