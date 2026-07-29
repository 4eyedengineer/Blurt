@echo off
rem Windows Eloquent - double-click launcher.
rem
rem `pushd "%~dp0"` first: if this .bat lives on a UNC path - e.g. opened
rem from Explorer at \\wsl.localhost\<distro>\... when the repo is on a WSL
rem filesystem - cmd.exe cannot use a UNC path as its own current directory
rem ("UNC paths are not supported. Defaulting to Windows directory."), and
rem once that happens cmd.exe can fail to even locate/run this batch file by
rem name (the "'run-windows.bat' is not recognized" failure this launcher
rem used to hit on double-click). `pushd` on a UNC path instead maps it to a
rem temporary drive letter (Z:, Y:, ...) and cd's there, which cmd.exe *can*
rem use as a current directory, sidestepping the whole problem. `popd` at
rem the end releases that temporary drive letter again.
pushd "%~dp0"
if errorlevel 1 (
    echo.
    echo ERROR: could not switch to "%~dp0" - see the message above.
    pause
    exit /b 1
)

echo Windows Eloquent launcher
echo   Folder: %CD%
echo.

rem Hand off to the real bootstrap + launch logic in Start-Eloquent.ps1.
rem -ExecutionPolicy Bypass so it runs even on a machine where PowerShell
rem script execution is locked down by default (very common) - that bypass
rem is scoped to this one process, it does not change the machine's global
rem execution policy. Use %~dp0 (the script's own original folder, not
rem necessarily %CD% after pushd) so Start-Eloquent.ps1's own $PSScriptRoot
rem correctly reflects the true source location (UNC or not) for its own
rem UNC-detection/mirroring logic - PowerShell, unlike cmd.exe, has no
rem trouble treating a UNC path as a script location.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-Eloquent.ps1"
set "ELOQUENT_EXITCODE=%ERRORLEVEL%"

popd

if not "%ELOQUENT_EXITCODE%"=="0" (
    echo.
    echo Windows Eloquent exited with an error ^(code %ELOQUENT_EXITCODE%^). See messages above.
    pause
    exit /b %ELOQUENT_EXITCODE%
)

pause
exit /b 0
