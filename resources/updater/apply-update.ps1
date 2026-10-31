# Applies a staged AIDE update. AIDE starts this detached while quitting; a running
# AIDE holds its own files, so the swap can only happen after every process from the
# install folder has exited. See docs/self-update.md.
#
# Protocol with AIDE (src/main/updater/installer.ts, settleUpdateFolder):
#   <update>\result.json  written before this script ends, and before the old version
#                         is started again after a failure
#   <update>\started      written by the new version as soon as it runs
param([Parameter(Mandatory = $true)][string]$ConfigPath)

$ErrorActionPreference = 'Stop'

$config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
$updateDir = Split-Path -Parent $ConfigPath
$installDir = $config.installDir.TrimEnd('\')
$newDir = $config.newDir
$exePath = Join-Path $installDir $config.exeName
$oldDir = Join-Path $updateDir 'old'
$logPath = Join-Path $updateDir 'helper.log'
$startedPath = Join-Path $updateDir 'started'
$resultPath = Join-Path $updateDir 'result.json'

function Log([string]$message) {
  Add-Content -LiteralPath $logPath -Value "$([DateTime]::Now.ToString('o')) $message" -Encoding UTF8
}

function Write-Result([bool]$ok, [string]$errorText) {
  # WriteAllText: no BOM, unlike Set-Content -Encoding UTF8 in Windows PowerShell.
  [IO.File]::WriteAllText($resultPath, (@{ ok = $ok; error = $errorText } | ConvertTo-Json -Compress))
}

function Start-Aide {
  $workingDir = if ($config.workingDir -and (Test-Path -LiteralPath $config.workingDir)) { $config.workingDir } else { $installDir }
  $options = @{ FilePath = $exePath; WorkingDirectory = $workingDir; PassThru = $true }
  $quoted = @($config.args | Where-Object { $null -ne $_ } | ForEach-Object {
    $arg = [string]$_
    if ($arg -match '[\s"]' -or $arg -eq '') { '"' + $arg.Replace('"', '\"') + '"' } else { $arg }
  })
  if ($quoted.Count -gt 0) { $options.ArgumentList = $quoted -join ' ' }
  return Start-Process @options
}

function Get-InstallProcesses {
  $prefix = $installDir + '\'
  return @(Get-CimInstance Win32_Process | Where-Object {
    $_.ExecutablePath -and $_.ProcessId -ne $PID -and
    $_.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
  })
}

# An MCP shim is AIDE.exe in Node mode serving an agent; one started by an agent outside
# AIDE outlives AIDE. It is of no use without AIDE and only holds the files.
function Test-Shim($process) { return "$($process.CommandLine)" -like '*aide-mcp.cjs*' }

# Bounded wait on process exit; returns false when something is still running at the limit.
function Wait-AppExit([int]$limitSeconds) {
  $deadline = [DateTime]::UtcNow.AddSeconds($limitSeconds)
  while ($true) {
    $running = @(Get-InstallProcesses | Where-Object { -not (Test-Shim $_) })
    if ($running.Count -eq 0) { return $true }
    $left = [int][Math]::Ceiling(($deadline - [DateTime]::UtcNow).TotalSeconds)
    if ($left -le 0) {
      Log "still running: $(($running | ForEach-Object { $_.ProcessId }) -join ', ')"
      return $false
    }
    Wait-Process -Id ($running | ForEach-Object { $_.ProcessId }) -Timeout $left -ErrorAction SilentlyContinue
  }
}

function Stop-Shims {
  foreach ($process in @(Get-InstallProcesses | Where-Object { Test-Shim $_ })) {
    Log "stopping MCP shim $($process.ProcessId)"
    Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
    Wait-Process -Id $process.ProcessId -Timeout 10 -ErrorAction SilentlyContinue
  }
}

# Nothing signals that an antivirus or the indexer let go of a file, so this one retries.
function Move-Retrying([string]$from, [string]$to) {
  for ($attempt = 1; ; $attempt++) {
    try {
      Move-Item -LiteralPath $from -Destination $to
      return
    } catch {
      if ($attempt -ge 20) { throw }
      Start-Sleep -Milliseconds 500
    }
  }
}

$moves = New-Object System.Collections.ArrayList

function Move-Tracked([string]$from, [string]$to) {
  Move-Retrying $from $to
  [void]$moves.Add(@{ from = $from; to = $to })
}

# Only names the new build has are replaced: anything the user keeps in the folder stays.
function Install-NewBuild {
  New-Item -ItemType Directory -Path $oldDir -Force | Out-Null
  foreach ($entry in @(Get-ChildItem -LiteralPath $newDir -Force)) {
    $target = Join-Path $installDir $entry.Name
    if (Test-Path -LiteralPath $target) { Move-Tracked $target (Join-Path $oldDir $entry.Name) }
    Move-Tracked $entry.FullName $target
  }
}

function Undo-Moves {
  for ($i = $moves.Count - 1; $i -ge 0; $i--) {
    Move-Retrying $moves[$i].to $moves[$i].from
  }
  $moves.Clear()
}

function Restore-AndReport([string]$errorText) {
  Log "failed: $errorText"
  try {
    Undo-Moves
  } catch {
    $errorText = "$errorText; restoring the previous version also failed: $($_.Exception.Message)"
    Log $errorText
  }
  Write-Result $false $errorText
  [void](Start-Aide)
}

# False only when the new version exited without reporting in; a slow start is not a failure.
function Wait-NewVersion($process, [int]$limitSeconds) {
  $deadline = [DateTime]::UtcNow.AddSeconds($limitSeconds)
  while ([DateTime]::UtcNow -lt $deadline) {
    if (Test-Path -LiteralPath $startedPath) { return $true }
    if ($process.WaitForExit(500)) { return (Test-Path -LiteralPath $startedPath) }
  }
  Log 'the new version did not report in time; keeping it'
  return $true
}

try {
  Log "applying update from $newDir to $installDir"
  if (-not (Wait-AppExit ([int]$config.exitLimitSeconds))) {
    Restore-AndReport 'AIDE was still running, so the update was not applied.'
    exit 0
  }
  Stop-Shims
  Install-NewBuild
  Log 'files swapped; starting the new version'
  $process = Start-Aide
  if (Wait-NewVersion $process ([int]$config.startLimitSeconds)) {
    Remove-Item -LiteralPath $oldDir -Recurse -Force -ErrorAction SilentlyContinue
    Write-Result $true ''
    Log 'done'
  } else {
    Restore-AndReport 'The new version exited during startup, so the previous version was restored.'
  }
} catch {
  Restore-AndReport $_.Exception.Message
}
