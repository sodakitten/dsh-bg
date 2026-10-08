# Window-only policy. No global registry settings, console window or app restart.
param([ValidateRange(1,2147483647)][int]$HostPid)
$ErrorActionPreference = 'Stop'
try {
  if ([Environment]::OSVersion.Version.Build -lt 22000) {
    '{"supported":false,"hidden":false,"windows":0,"reason":"requires-windows-11"}'
    exit 0
  }
  $taskHost = Get-Process -Id $HostPid
  $null = $taskHost.Handle
  $taskOwner = $null
  $taskAncestorPid = $HostPid
  $taskSeen = @{}
  for ($taskDepth = 0; $taskDepth -lt 12 -and $taskAncestorPid -gt 0; $taskDepth++) {
    if ($taskSeen.ContainsKey($taskAncestorPid)) { break }
    $taskSeen[$taskAncestorPid] = $true
    $taskProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$taskAncestorPid"
    if (-not $taskProcess) { break }
    if ($taskProcess.Name -ieq 'DeepSeek Harness.exe' -and
        [IO.Path]::GetFileName($taskProcess.ExecutablePath) -ieq 'DeepSeek Harness.exe') {
      $taskCandidate = Get-Process -Id $taskAncestorPid
      $null = $taskCandidate.Handle
      if ($taskCandidate.Path -ieq $taskProcess.ExecutablePath) { $taskOwner = $taskCandidate }
    }
    $taskAncestorPid = [int]$taskProcess.ParentProcessId
  }
  if (-not $taskOwner -or $taskOwner.SessionId -ne $taskHost.SessionId) {
    '{"supported":false,"hidden":false,"windows":0,"reason":"not-desktop-host"}'
    exit 0
  }
  # Keep process handles open: a reused PID must never become a new owner.
  $null = $taskOwner.Handle
  Add-Type -Path (Join-Path $PSScriptRoot 'window-border.cs')
  $taskBorder = New-Object DshBackground.WindowBorder($taskOwner.Id)
  $taskDesired = $false
  $taskLastReport = ''
  $taskCommands = New-Object DshBackground.BorderCommands
  [string]$taskCommand = ''
  try {
    while (-not $taskHost.HasExited -and -not $taskOwner.HasExited) {
      while ($taskCommands.TryRead([ref]$taskCommand)) {
        if ($taskCommand -eq 'hide') { $taskDesired = $true }
        elseif ($taskCommand -eq 'show') { $taskDesired = $false }
        else { throw 'Invalid border command' }
      }
      if ($taskCommands.Ended) { break }
      $taskBorder.Update($taskDesired)
      $taskReport = @{supported=$true;hidden=($taskBorder.Count -gt 0);windows=$taskBorder.Count} | ConvertTo-Json -Compress
      if ($taskReport -ne $taskLastReport) { [Console]::Out.WriteLine($taskReport); $taskLastReport = $taskReport }
      Start-Sleep -Milliseconds 1000
    }
  } finally { $taskBorder.Dispose() }
} catch {
  [Console]::Error.WriteLine('DSH window border helper failed.')
  exit 1
}
