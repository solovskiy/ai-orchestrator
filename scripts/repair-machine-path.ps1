# Repairs the machine-level PATH in the registry.
# MUST be run from an ELEVATED (Administrator) PowerShell.
#
# Problem it fixes: HKLM Session Manager Environment has no "Path" value at all,
# and instead contains junk values whose NAMES are path segments -- the signature
# of a broken PATH-editing script that split on ';' and wrote each part as a value.
#
# ASCII-only on purpose: PowerShell 5.1 reads .ps1 as ANSI unless the file has a UTF-8 BOM.

$ErrorActionPreference = 'Stop'

$key = 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment'
$regPath = 'HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment'

# --- guard: require elevation -------------------------------------------------
$isAdmin = ([Security.Principal.WindowsPrincipal] `
    [Security.Principal.WindowsIdentity]::GetCurrent()
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    Write-Output 'ABORT: this script must run in an elevated PowerShell (Run as Administrator).'
    exit 1
}

# --- backup the whole key before touching anything ----------------------------
$backupDir = 'D:\work\vodovorot\.ai\backups'
if (-not (Test-Path $backupDir)) {
    New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
}
$stamp     = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupReg = Join-Path $backupDir "hklm-environment-$stamp.reg"

& reg.exe export $regPath $backupReg /y | Out-Null
Write-Output "BACKUP: $backupReg"

# --- report current state -----------------------------------------------------
$existing = Get-ItemProperty -Path $key
if ($existing.PSObject.Properties.Name -contains 'Path') {
    Write-Output "CURRENT Path: $($existing.Path)"
} else {
    Write-Output 'CURRENT Path: <missing>'
}

# --- restore the standard Windows 10 machine PATH -----------------------------
$standardPath = '%SystemRoot%\system32;%SystemRoot%;%SystemRoot%\System32\Wbem;%SystemRoot%\System32\WindowsPowerShell\v1.0\;%SystemRoot%\System32\OpenSSH\'

# REG_EXPAND_SZ so %SystemRoot% stays a variable, as Windows expects.
& reg.exe add $regPath /v Path /t REG_EXPAND_SZ /d $standardPath /f | Out-Null
Write-Output "SET Path = $standardPath"

# --- remove the junk values ---------------------------------------------------
$junkNames = @('Windows', 'C:\Windows\System32\Wbem')

foreach ($name in $junkNames) {
    if ($existing.PSObject.Properties.Name -contains $name) {
        & reg.exe delete $regPath /v $name /f | Out-Null
        Write-Output "REMOVED junk value: $name"
    } else {
        Write-Output "SKIP (not present): $name"
    }
}

# --- verify -------------------------------------------------------------------
$after = (Get-ItemProperty -Path $key).Path
if ($after) {
    Write-Output 'OK: machine Path restored.'
    Write-Output 'NOTE: log out and back in (or reboot) for services and new sessions to pick it up.'
} else {
    Write-Output 'FAIL: Path still missing after write.'
    exit 1
}
