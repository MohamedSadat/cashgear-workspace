$ErrorActionPreference = 'Stop'
$runtimeKeys = @(
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
    'HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
    'HKCU:\Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
)
function Get-WebView2Version {
    foreach ($runtimeKey in $runtimeKeys) {
        $runtimeVersion = (Get-ItemProperty -LiteralPath $runtimeKey -Name pv -ErrorAction SilentlyContinue).pv
        if ($runtimeVersion -and $runtimeVersion -ne '0.0.0.0') { return $runtimeVersion }
    }
    return $null
}
$installedVersion = Get-WebView2Version
if ($installedVersion) {
    Write-Output "WebView2 Runtime $installedVersion is installed."
    exit 0
}
# Microsoft's Evergreen bootstrapper and installation/detection contract:
# https://learn.microsoft.com/microsoft-edge/webview2/concepts/distribution
$runtimeInstaller = Join-Path $env:TEMP 'CashGearWorkspace-WebView2Setup.exe'
Invoke-WebRequest -UseBasicParsing -Uri 'https://go.microsoft.com/fwlink/p/?LinkId=2124703' -OutFile $runtimeInstaller
$signature = Get-AuthenticodeSignature -LiteralPath $runtimeInstaller
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Microsoft Corporation') {
    throw 'The WebView2 installer does not have a valid Microsoft signature.'
}
$installProcess = Start-Process -FilePath $runtimeInstaller -ArgumentList @('/silent', '/install') -WindowStyle Hidden -Wait -PassThru
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    $installedVersion = Get-WebView2Version
    if ($installedVersion) { break }
    Start-Sleep -Seconds 1
}
if (-not $installedVersion) { throw "WebView2 installation failed (exit $($installProcess.ExitCode))." }
Write-Output "WebView2 Runtime $installedVersion is installed."
