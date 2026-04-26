param(
  [int]$StartPid = 0,
  [string]$ThreadId = "",
  [string]$ConsolePid = ""
)

$ErrorActionPreference = "SilentlyContinue"

function Get-ThreadIdFromCommandLine {
  param([string]$CommandLine)
  if ($CommandLine -match 'resume\s+([0-9a-fA-F-]{36})') {
    return $Matches[1]
  }
  return ""
}

function Write-Target {
  param(
    [object]$Process,
    [string]$Source
  )
  if (-not $Process) {
    return
  }
  [pscustomobject]@{
    ProcessId       = [int]$Process.ProcessId
    ParentProcessId = [int]$Process.ParentProcessId
    Name            = [string]$Process.Name
    ThreadId        = Get-ThreadIdFromCommandLine -CommandLine ([string]$Process.CommandLine)
    Source          = $Source
    CommandLine     = [string]$Process.CommandLine
  } | ConvertTo-Json -Compress
  exit 0
}

if ($ConsolePid) {
  $explicit = Get-CimInstance Win32_Process -Filter "ProcessId=$ConsolePid"
  Write-Target -Process $explicit -Source "explicit_pid"
}

if ($StartPid -gt 0) {
  $current = Get-CimInstance Win32_Process -Filter "ProcessId=$StartPid"
  while ($current) {
    $parentPid = [int]$current.ParentProcessId
    if ($parentPid -le 0) {
      break
    }

    $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$parentPid"
    if (-not $parent) {
      break
    }

    if ([string]::Equals([string]$parent.Name, "codex.exe", [System.StringComparison]::OrdinalIgnoreCase)) {
      Write-Target -Process $parent -Source "ancestor"
    }

    $current = $parent
  }
}

if ($ThreadId) {
  $escapedThread = $ThreadId.Replace("[", "[[]").Replace("]", "[]]")
  $match = Get-CimInstance Win32_Process |
    Where-Object {
      [string]::Equals([string]$_.Name, "codex.exe", [System.StringComparison]::OrdinalIgnoreCase) -and
      ([string]$_.CommandLine) -like "*$escapedThread*"
    } |
    Sort-Object CreationDate -Descending |
    Select-Object -First 1
  Write-Target -Process $match -Source "thread_id"
}

exit 1
