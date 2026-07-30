@echo off
rem Windows Eloquent uninstaller - deletes everything run-windows.bat /
rem Start-Eloquent.ps1 create on this machine, for a clean-slate test. Does
rem not touch this source checkout.
rem
rem NOTE: if you installed via windows-eloquent-<version>-setup.exe (the
rem packaged NSIS installer - see WINDOWS.md's "Standalone app" section)
rem instead of the dev launcher, use its own uninstaller from "Installed
rem apps" (or Control Panel) instead of this script - it already removes
rem %APPDATA%\windows-eloquent automatically and separately prompts about
rem %LOCALAPPDATA%\WindowsEloquent. This script remains for the dev-launcher
rem path (run-windows.bat/Start-Eloquent.ps1) and portable-exe leftovers,
rem neither of which has a real installer/uninstaller to hook into.
rem
rem pushd "%~dp0" first: same reason as run-windows.bat - lets this be
rem double-clicked from a UNC path (e.g. \\wsl.localhost\...) without
rem cmd.exe choking on it.
pushd "%~dp0"
if errorlevel 1 (
    echo.
    echo ERROR: could not switch to "%~dp0" - see the message above.
    pause
    exit /b 1
)

rem Guard: if either env var were undefined, the targets below would resolve
rem to root-relative paths - refuse to run rather than delete the wrong thing.
if not defined LOCALAPPDATA (
    echo ERROR: LOCALAPPDATA is not defined - aborting without deleting anything.
    pause
    exit /b 1
)
if not defined APPDATA (
    echo ERROR: APPDATA is not defined - aborting without deleting anything.
    pause
    exit /b 1
)

set "RUNTIME_DIR=%LOCALAPPDATA%\WindowsEloquent"
set "USERDATA_DIR=%APPDATA%\windows-eloquent"

echo Windows Eloquent uninstall
echo This will delete:
echo   %RUNTIME_DIR%   (mirrored app copy, Python venv, staging/models)
echo   %USERDATA_DIR%   (settings, history, downloaded models, logs)
echo.
set /p "CONFIRM=Press Enter to continue, or close this window to abort: "

if exist "%RUNTIME_DIR%" (
    rmdir /s /q "%RUNTIME_DIR%"
    echo Removed %RUNTIME_DIR%
) else (
    echo %RUNTIME_DIR% not found - skipping.
)

if exist "%USERDATA_DIR%" (
    rmdir /s /q "%USERDATA_DIR%"
    echo Removed %USERDATA_DIR%
) else (
    echo %USERDATA_DIR% not found - skipping.
)

popd
echo.
echo Done. Run run-windows.bat for a fresh bootstrap.
pause
exit /b 0
