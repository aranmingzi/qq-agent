$ErrorActionPreference = 'Stop'

$AppDir = if ($env:QQAGENT_APP_DIR) { $env:QQAGENT_APP_DIR } else { 'C:\qqagent' }
$Archive = if ($env:QQAGENT_ARCHIVE) { $env:QQAGENT_ARCHIVE } else { 'C:\Windows\Temp\qqagent-cloud-deploy.tar.gz' }
$NodeExe = 'C:\Program Files\nodejs\node.exe'
$NpmCmd = 'C:\Program Files\nodejs\npm.cmd'
$TaskName = 'QQAgent'

if (-not (Test-Path $NodeExe)) {
  throw "Node.js not found: $NodeExe"
}
if (-not (Test-Path $Archive)) {
  throw "Deployment archive not found: $Archive"
}

New-Item -ItemType Directory -Path $AppDir -Force | Out-Null
tar.exe -xzf $Archive -C $AppDir

Push-Location $AppDir
try {
  & $NpmCmd install --omit=dev --ignore-scripts
  if ($LASTEXITCODE -ne 0) {
    throw "npm install failed with exit code $LASTEXITCODE"
  }

  & $NodeExe 'scripts\apply-feature-migration.mjs'
  if ($LASTEXITCODE -ne 0) {
    throw "Feature migration failed with exit code $LASTEXITCODE"
  }
} finally {
  Pop-Location
}

schtasks.exe /End /TN $TaskName 2>$null | Out-Null
Start-Sleep -Seconds 2
schtasks.exe /Run /TN $TaskName | Out-Null
if ($LASTEXITCODE -ne 0) {
  throw "Failed to restart scheduled task: $TaskName"
}

Start-Sleep -Seconds 5
$Status = curl.exe --silent --show-error 'http://127.0.0.1:3210/api/status'
if (-not $Status) {
  throw 'QQAgent did not respond after restart'
}

$Status
