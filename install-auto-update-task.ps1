param(
  [string]$TaskName = 'ChromeExtensionStarterAutoUpdate',
  [switch]$RunNow
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$updateScriptPath = Join-Path $repoRoot 'update-from-github.ps1'

if (-not (Test-Path $updateScriptPath)) {
  throw "update-from-github.ps1 not found at $updateScriptPath"
}

$powershellExe = (Get-Command powershell.exe).Source
$currentUser = if ($env:USERDOMAIN) {
  "$($env:USERDOMAIN)\$($env:USERNAME)"
} else {
  $env:USERNAME
}

$action = New-ScheduledTaskAction `
  -Execute $powershellExe `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$updateScriptPath`""

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable

$principal = New-ScheduledTaskPrincipal `
  -UserId $currentUser `
  -LogonType Interactive `
  -RunLevel Limited

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Principal $principal `
  -Description 'Auto-runs update-from-github.ps1 at logon to fast-forward the local repo before Chrome extension use.' `
  -Force | Out-Null

Write-Host "[task] Installed scheduled task '$TaskName' for $currentUser"
Write-Host "[task] It will run update-from-github.ps1 each time you sign in."

if ($RunNow) {
  Start-ScheduledTask -TaskName $TaskName
  Write-Host "[task] Started '$TaskName'"
}
