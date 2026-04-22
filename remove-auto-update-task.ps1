param(
  [string]$TaskName = 'ChromeExtensionStarterAutoUpdate'
)

$ErrorActionPreference = 'Stop'

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $task) {
  Write-Host "[task] '$TaskName' is not installed."
  exit 0
}

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
Write-Host "[task] Removed scheduled task '$TaskName'"
