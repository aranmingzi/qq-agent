$ErrorActionPreference = 'Stop'

$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Electron = (Resolve-Path (Join-Path $Root 'node_modules\electron\dist\electron.exe')).Path
$Icon = (Resolve-Path (Join-Path $Root 'assets\icon.ico')).Path
$Entry = $Root

if (-not (Test-Path $Electron)) {
  throw "Electron not installed: $Electron`nRun npm install first."
}
if (-not (Test-Path $Icon)) {
  throw "Desktop icon not found: $Icon"
}

$Shell = New-Object -ComObject WScript.Shell
$Targets = @(
  [Environment]::GetFolderPath('Desktop'),
  (Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs')
)

$Links = @()
foreach ($Dir in $Targets) {
  if (-not $Dir) { continue }
  New-Item -ItemType Directory -Path $Dir -Force | Out-Null
  $LinkPath = Join-Path $Dir 'QQ Agent.lnk'
  $Shortcut = $Shell.CreateShortcut($LinkPath)
  $Shortcut.TargetPath = $Electron
  $Shortcut.Arguments = '"' + $Entry + '"'
  $Shortcut.WorkingDirectory = $Root
  $Shortcut.IconLocation = "$Icon,0"
  $Shortcut.Description = 'QQ Agent Desktop'
  $Shortcut.WindowStyle = 1
  $Shortcut.Save()
  $Verify = $Shell.CreateShortcut($LinkPath)
  if ($Verify.TargetPath -ne $Electron) {
    throw "Shortcut target was not saved correctly: $LinkPath"
  }
  $Links += $LinkPath
}

$Links | ForEach-Object { Write-Output "Created: $_" }
