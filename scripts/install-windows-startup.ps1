<#
  Registers the Mero Restro Print Agent to start automatically when this
  Windows user logs in, by dropping a shortcut into the per-user Startup
  folder (shell:startup) — no admin rights needed, and it's exactly what
  Task Scheduler's "At log on" trigger does under the hood for a per-user
  app, just simpler to install/uninstall by hand.

  Run this from an elevated or normal PowerShell prompt, from the
  print-agent's own folder, AFTER `npm run package:win` has produced
  dist-pkg\mero-restro-print-agent-win.exe:

      powershell -ExecutionPolicy Bypass -File .\scripts\install-windows-startup.ps1
#>

$ErrorActionPreference = "Stop"

$exePath = Join-Path $PSScriptRoot "..\dist-pkg\mero-restro-print-agent-win.exe"
if (-not (Test-Path $exePath)) {
    Write-Error "Could not find $exePath — run 'npm run package:win' first."
    exit 1
}
$exePath = (Resolve-Path $exePath).Path

$startupFolder = [Environment]::GetFolderPath("Startup")
$shortcutPath = Join-Path $startupFolder "Mero Restro Print Agent.lnk"

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $exePath
$shortcut.WorkingDirectory = Split-Path $exePath
$shortcut.WindowStyle = 7   # Minimized — the agent runs headless; nothing needs to be seen.
$shortcut.Description = "Mero Restro Print Agent — local receipt/kitchen printing"
$shortcut.Save()

Write-Host "Installed. The Print Agent will now start automatically the next time you log in."
Write-Host "To start it right now without restarting: $exePath"
