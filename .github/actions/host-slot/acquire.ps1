# Queues for a slot of host-slot's class on a Windows host (see acquire.sh).
$ErrorActionPreference = 'Stop'

function Out-Output($line) { [IO.File]::AppendAllText($env:GITHUB_OUTPUT, "$line`n") }
function Out-None($message) { Write-Host $message; Out-Output 'acquired=false'; Out-Output 'slot='; exit 0 }
function Get-Setting($value, $default) { if ([string]::IsNullOrEmpty($value)) { $default } else { $value } }

$slots = Get-Setting $env:SLOT_COUNT '2'
if ($slots -notmatch '^\d+$') { Write-Host "::warning::Slot count '$slots' is not a number; using 2"; $slots = '2' }
if ([int]$slots -le 0) { Out-None 'Slots are off (0): no limit.' }
$base = $env:SLOT_DIR
if ([string]::IsNullOrEmpty($base) -and -not [string]::IsNullOrEmpty($env:CI_LOCAL_CACHE)) { $base = Join-Path $env:CI_LOCAL_CACHE 'slots' }
if ([string]::IsNullOrEmpty($base)) { Out-None 'No CI_LOCAL_CACHE: not a runner with a shared disk, so no limit.' }

$class = Get-Setting $env:SLOT_CLASS 'heavy'
$wait = Get-Setting $env:SLOT_WAIT '90'
$hold = Get-Setting $env:SLOT_HOLD '240'
$dir = Join-Path $base $class
$state = Join-Path (Join-Path $env:RUNNER_TEMP 'host-slot') $class
New-Item -ItemType Directory -Force -Path $dir, $state | Out-Null
foreach ($f in 'ready', 'ready.tmp', 'release') { Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $state $f) }

# The runner ends a step's child processes with the step, so the holder is started through WMI, outside
# the step's process tree, and ends with the job's Runner.Worker.exe instead (or at release or the hold limit).
$worker = 0
$walk = Get-CimInstance Win32_Process -Filter "ProcessId=$PID"
while ($walk) {
  if ($walk.Name -eq 'Runner.Worker.exe') { $worker = $walk.ProcessId; break }
  $walk = Get-CimInstance Win32_Process -Filter "ProcessId=$($walk.ParentProcessId)" -ErrorAction SilentlyContinue
}
$script = Join-Path $env:GITHUB_ACTION_PATH 'hold.ps1'
$command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$script`" -Dir `"$dir`" -Slots $slots -State `"$state`" -WaitMinutes $wait -HoldMinutes $hold -WatchPid $worker"
$created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $command }
if ($created.ReturnValue -ne 0) { Out-None "::warning::Could not start the slot holder (WMI $($created.ReturnValue)): running without a slot." }
$holder = $created.ProcessId

Write-Host "Waiting for one of $slots '$class' slots on $env:COMPUTERNAME."
$ready = Join-Path $state 'ready'
$watch = [Diagnostics.Stopwatch]::StartNew()
$last = 0
while (-not (Test-Path $ready)) {
  if (-not (Get-Process -Id $holder -ErrorAction SilentlyContinue) -and -not (Test-Path $ready)) {
    Write-Host '::warning::The slot holder died: running without a slot.'
    Get-Content (Join-Path $state 'holder.err') -ErrorAction SilentlyContinue | Write-Host
    Out-None 'No slot.'
  }
  if ($watch.Elapsed.TotalSeconds - $last -ge 60) { $last = $watch.Elapsed.TotalSeconds; Write-Host "Still waiting after $([int]($last / 60)) min." }
  Start-Sleep -Seconds 1
}

$got = (Get-Content $ready -Raw).Trim()
if ($got -eq 'timeout') {
  if ($env:SLOT_ON_TIMEOUT -eq 'fail') { Write-Host "::error::No '$class' slot after $wait min."; exit 1 }
  Write-Host "::warning::No '$class' slot after $wait min: running without one."
  Out-Output 'acquired=false'
  Out-Output 'slot='
  exit 0
}
$secs = [int]$watch.Elapsed.TotalSeconds
Write-Host "Got slot $got of $slots after $secs s."
[IO.File]::AppendAllText($env:GITHUB_STEP_SUMMARY, "Slot $got of $slots (waited $secs s).`n")
Out-Output 'acquired=true'
Out-Output "slot=$got"
