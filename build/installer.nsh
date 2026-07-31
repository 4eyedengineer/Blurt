; Custom uninstall step (electron-builder's NSIS `include` hook - see
; electron-builder.yml's `nsis.include`). Both of the removals below are
; deliberately prompts, not unconditional deletes: electron-builder's own
; `deleteAppDataOnUninstall` would silently wipe %APPDATA%\blurt (settings,
; history, and the downloaded model - up to several GB) with no confirmation,
; and this app also has a second, separate %LOCALAPPDATA%\Blurt runtime
; directory (the shared Python venv + litert-lm - see
; src/main/runtime/venvResolver.ts) that electron-builder has no knowledge of
; at all. Both are sized enough, and shared/reused enough (a dev build on the
; same machine), that neither should vanish without the user saying so.
!macro customUnInstall
  MessageBox MB_YESNO|MB_ICONQUESTION "Also remove Blurt's saved data (settings, dictation history, and the downloaded model - can be several GB) under$\r$\n$APPDATA\blurt ?$\r$\n$\r$\nLeave this if you plan to reinstall Blurt later and want to keep it." IDYES removeAppData IDNO skipAppData
  removeAppData:
    RMDir /r "$APPDATA\blurt"
  skipAppData:

  MessageBox MB_YESNO|MB_ICONQUESTION "Also remove the Python runtime (venv + litert-lm) that Blurt installed under$\r$\n$LOCALAPPDATA\Blurt ?$\r$\n$\r$\nLeave this if another copy of Blurt (e.g. a dev build) still uses it." IDYES removeRuntime IDNO skipRuntime
  removeRuntime:
    RMDir /r "$LOCALAPPDATA\Blurt"
  skipRuntime:
!macroend
