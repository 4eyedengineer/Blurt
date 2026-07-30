@echo off
rem Windows Eloquent uninstaller - deletes everything run-windows.bat /
rem Start-Eloquent.ps1 create on this machine, for a clean-slate test. Does
rem not touch this source checkout.
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
