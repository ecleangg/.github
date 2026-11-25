# Background holder for acquire.ps1 (see hold.sh): an exclusive handle on the slot file is the lock,
# and Windows closes it when this process ends, however it ends.
param([string]$Dir, [int]$Slots, [string]$State, [int]$WaitMinutes, [int]$HoldMinutes)
$ErrorActionPreference = 'Stop'
$start = Get-Date
while ($true) {
  for ($i = 1; $i -le $Slots; $i++) {
    try {
      $lock = [IO.File]::Open((Join-Path $Dir "$i.lock"), 'OpenOrCreate', 'ReadWrite', 'None')
    } catch [IO.IOException] {
      continue
    }
    [IO.File]::WriteAllText((Join-Path $State 'ready.tmp'), "$i")
    Move-Item -Force (Join-Path $State 'ready.tmp') (Join-Path $State 'ready')
    $end = (Get-Date).AddMinutes($HoldMinutes)
    while (-not (Test-Path (Join-Path $State 'release')) -and (Get-Date) -lt $end) { Start-Sleep -Seconds 1 }
    # `release` waits for `ready` to go, so the slot is free when it returns.
    Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $State 'ready'), (Join-Path $State 'release')
    $lock.Dispose()
    exit 0
  }
  if (((Get-Date) - $start).TotalSeconds -ge $WaitMinutes * 60) {
    [IO.File]::WriteAllText((Join-Path $State 'ready'), 'timeout')
    exit 0
  }
  Start-Sleep -Seconds (Get-Random -Minimum 2 -Maximum 5)
}
