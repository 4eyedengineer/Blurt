; Custom uninstall step (electron-builder's NSIS `include` hook - see
; electron-builder.yml's `nsis.include`). electron-builder's own
; `deleteAppDataOnUninstall` only removes %APPDATA%\windows-eloquent (the
; app's Electron `userData` dir); it has no knowledge of this app's separate
; %LOCALAPPDATA%\WindowsEloquent runtime directory (the shared Python venv +
; litert-lm - see src/main/runtime/venvResolver.ts), which is sized in the
; hundreds of MB and also reused by Start-Eloquent.ps1/run.sh, so it's asked
; about explicitly rather than deleted unconditionally.
!macro customUnInstall
  MessageBox MB_YESNO|MB_ICONQUESTION "Also remove the Python runtime (venv + litert-lm) that Windows Eloquent installed under$\r$\n$LOCALAPPDATA\WindowsEloquent ?$\r$\n$\r$\nLeave this if another copy of Windows Eloquent (e.g. a dev build) still uses it." IDYES removeRuntime IDNO skipRuntime
  removeRuntime:
    RMDir /r "$LOCALAPPDATA\WindowsEloquent"
  skipRuntime:
!macroend
