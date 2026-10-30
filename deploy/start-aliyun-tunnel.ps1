$ErrorActionPreference = 'Continue'

$root = Split-Path -Parent $PSScriptRoot
$key = Join-Path $root '.deploy\aliyun_ed25519'
$log = Join-Path $root 'aliyun-tunnel.log'
$server = 'Administrator@101.37.17.128'
$ssh = (Get-Command ssh.exe).Source

$arguments = @(
  '-N',
  '-i', $key,
  '-o', 'BatchMode=yes',
  '-o', 'ExitOnForwardFailure=yes',
  '-o', 'ServerAliveInterval=30',
  '-o', 'ServerAliveCountMax=3',
  '-R', '127.0.0.1:3000:127.0.0.1:3000',
  '-R', '127.0.0.1:3001:127.0.0.1:3001',
  '-L', '13210:127.0.0.1:3210',
  $server
)

while ($true) {
  "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] starting tunnel" |
    Out-File -FilePath $log -Encoding utf8 -Append

  & $ssh @arguments *>> $log

  "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] tunnel exited" |
    Out-File -FilePath $log -Encoding utf8 -Append
  Start-Sleep -Seconds 5
}
