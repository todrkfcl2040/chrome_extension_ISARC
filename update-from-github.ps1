param(
  [switch]$OpenExtensionsPage
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$remoteName = 'origin'
$branchName = 'main'

Set-Location $repoRoot

Write-Host "[update] Checking $remoteName/$branchName..."
git fetch $remoteName $branchName --quiet
if ($LASTEXITCODE -ne 0) {
  throw "git fetch failed."
}

$localHead = (git rev-parse HEAD).Trim()
$remoteHead = (git rev-parse "$remoteName/$branchName").Trim()

if ($localHead -eq $remoteHead) {
  Write-Host "[update] Already up to date at $localHead"
} else {
  Write-Host "[update] Pulling latest changes..."
  git pull --ff-only $remoteName $branchName
  if ($LASTEXITCODE -ne 0) {
    throw "git pull failed."
  }

  $updatedHead = (git rev-parse HEAD).Trim()
  Write-Host "[update] Updated to $updatedHead"
}

if ($OpenExtensionsPage) {
  Start-Process 'chrome://extensions/'
}
