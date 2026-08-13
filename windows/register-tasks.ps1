<#
.SYNOPSIS
  Installs (or removes) the per-user Scheduled Task that auto-starts the
  floating panel at logon, for the manual/dev setup (SETUP.md "Option B" —
  running from source, not the installed app).

.DESCRIPTION
  NOTE: if you used the Windows installer (Claude Usage Setup.exe), you do
  NOT need this script — the installed app auto-starts at login on its own
  (via a "Start with Windows" registry entry it manages itself, toggleable
  from its tray menu) and polls usage internally every 2 minutes. This
  script is only for people running the app from source without installing
  it, where Electron's own login-item API isn't reliable for an unpacked
  app.

  The task is registered for the CURRENT user with LogonType Interactive
  and trigger "At log on of <user>" — this does NOT require Administrator
  rights and does NOT store a password, unlike "run whether user is logged
  on or not" tasks.

  There used to be a second task here that ran the poller separately every
  2 minutes. It's gone: the panel now polls itself on an interval (see
  panel/poller.js), so a standalone poll task would just be redundant.
  claude-usage-poll.js (the standalone CLI poller) still exists and still
  works if you want to trigger a one-off poll by hand or from your own
  scheduler.

.PARAMETER Uninstall
  Removes the scheduled task instead of creating it.

.EXAMPLE
  .\register-tasks.ps1
  .\register-tasks.ps1 -Uninstall
#>
param(
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

$RootDir  = $PSScriptRoot
$PanelTask = 'ClaudeUsagePanel'

if ($Uninstall) {
  if (Get-ScheduledTask -TaskName $PanelTask -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $PanelTask -Confirm:$false
    Write-Host "Removed task: $PanelTask"
  } else {
    Write-Host "Task not found (already removed): $PanelTask"
  }
  return
}

$PanelDir = Join-Path $RootDir 'panel'
$ElectronExe = Join-Path $PanelDir 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path $ElectronExe)) {
  throw "Electron binary not found at $ElectronExe -- run 'npm install' inside windows\panel first."
}

$panelAction  = New-ScheduledTaskAction -Execute $ElectronExe -Argument '.' -WorkingDirectory $PanelDir
$panelTrigger = New-ScheduledTaskTrigger -AtLogOn
$panelSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$panelPrincipal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive

Register-ScheduledTask -TaskName $PanelTask -Action $panelAction -Trigger $panelTrigger `
  -Settings $panelSettings -Principal $panelPrincipal -Force | Out-Null
Write-Host "Registered task: $PanelTask (at logon)"

Write-Host ""
Write-Host "Done. The panel will start automatically at your next logon."
Write-Host "To start it right now without logging out:"
Write-Host "  Start-ScheduledTask -TaskName $PanelTask"
