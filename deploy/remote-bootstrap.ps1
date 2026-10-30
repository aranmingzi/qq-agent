$ErrorActionPreference = 'Stop'

$nodeVersion = '24.21.0'
$nodeDir = 'C:\Program Files\nodejs'
$nodeExe = Join-Path $nodeDir 'node.exe'
$npmCmd = Join-Path $nodeDir 'npm.cmd'
$msiPath = "C:\Windows\Temp\node-v$nodeVersion-x64.msi"
$archivePath = 'C:\Windows\Temp\qqagent-cloud-deploy.tar.gz'
$appDir = 'C:\qqagent'
$launcherPath = Join-Path $appDir 'start-qqagent.cmd'

if (-not (Test-Path $nodeExe)) {
  if (-not (Test-Path $msiPath) -or (Get-Item $msiPath).Length -lt 30000000) {
    $url = "https://nodejs.org/dist/v$nodeVersion/node-v$nodeVersion-x64.msi"
    Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $msiPath
  }

  $proc = Start-Process -FilePath 'msiexec.exe' `
    -ArgumentList '/i', $msiPath, '/qn', '/norestart' `
    -Wait -PassThru

  if ($proc.ExitCode -ne 0) {
    throw "Node.js installer failed with exit code $($proc.ExitCode)"
  }
}

if (-not (Test-Path $archivePath)) {
  throw "Deployment archive not found: $archivePath"
}

New-Item -ItemType Directory -Path $appDir -Force | Out-Null
tar.exe -xzf $archivePath -C $appDir

Push-Location $appDir
try {
  & $npmCmd install --omit=dev --ignore-scripts
  if ($LASTEXITCODE -ne 0) {
    throw "npm install failed with exit code $LASTEXITCODE"
  }
} finally {
  Pop-Location
}

@"
@echo off
cd /d "$appDir"
"$nodeExe" src\server.js 1>> "$appDir\qqagent-server.out.log" 2>> "$appDir\qqagent-server.err.log"
"@ | Set-Content -Path $launcherPath -Encoding ascii

schtasks.exe /Create /TN QQAgent /TR $launcherPath /SC ONSTART /RU SYSTEM /RL HIGHEST /F | Out-Null
if ($LASTEXITCODE -ne 0) {
  throw "Failed to create QQAgent scheduled task"
}

schtasks.exe /Run /TN QQAgent | Out-Null
if ($LASTEXITCODE -ne 0) {
  throw "Failed to start QQAgent scheduled task"
}

Start-Sleep -Seconds 3

& $nodeExe -v
& $npmCmd -v
Test-Path (Join-Path $appDir 'src\server.js')
