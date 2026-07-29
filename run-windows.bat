@echo off
rem Windows Eloquent - double-click launcher.
rem This just hands off to the real bootstrap logic in Start-Eloquent.ps1,
rem using -ExecutionPolicy Bypass so it runs even on a machine where
rem PowerShell script execution is locked down by default (very common) -
rem that bypass is scoped to this one process, it does not change the
rem machine's global execution policy.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-Eloquent.ps1"
pause
