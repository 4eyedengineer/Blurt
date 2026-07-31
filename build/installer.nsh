; Custom uninstall step (electron-builder's NSIS `include` hook - see
; electron-builder.yml's `nsis.include`).
;
; Two things can be removed here, both only ever with the user's explicit
; consent: %APPDATA%\blurt (settings, dictation history, and the downloaded
; model - several GB) and %LOCALAPPDATA%\Blurt (the Python venv + litert-lm
; this app sets up for itself, which electron-builder knows nothing about).
;
; The guards below are not optional. The incident that motivates them:
; installing 1.0.0 over an existing 1.0.0 destroyed a 2.4 GB downloaded model
; and an entire dictation history. NSIS runs the OLD version's uninstaller as
; part of an upgrade, and runs it SILENTLY - and a MessageBox in a silent
; uninstaller never displays. It returns its default button immediately,
; which for MB_YESNO is IDYES. So an unguarded prompt here is not a prompt at
; all: it is an unconditional `RMDir /r` over the user's data on every
; upgrade.
;
; electron-builder's own `deleteAppDataOnUninstall` avoids exactly this by
; checking `${isUpdated}` (see app-builder-lib/templates/nsis/uninstaller.nsh)
; and never deleting app data during an upgrade. This macro has to do the
; same for itself, and additionally refuse to act when running
; non-interactively at all - "the user said yes" only means something if the
; user was actually asked.
!macro customUnInstall
  ; An upgrade, not a real uninstall: the user is keeping the app, so their
  ; model, history and settings must survive untouched.
  ${if} ${isUpdated}
    Goto blurtSkipUserData
  ${endif}

  ; Silent/automated uninstall - nothing can be asked, so nothing is removed.
  ; Data left behind is recoverable; data deleted is not.
  IfSilent blurtSkipUserData

  MessageBox MB_YESNO|MB_ICONQUESTION "Also remove Blurt's saved data (settings, dictation history, and the downloaded model - can be several GB) under$\r$\n$APPDATA\blurt ?$\r$\n$\r$\nLeave this if you plan to reinstall Blurt later and want to keep it." IDYES blurtRemoveAppData IDNO blurtSkipAppData
  blurtRemoveAppData:
    RMDir /r "$APPDATA\blurt"
  blurtSkipAppData:

  MessageBox MB_YESNO|MB_ICONQUESTION "Also remove the Python runtime (venv + litert-lm) that Blurt installed under$\r$\n$LOCALAPPDATA\Blurt ?$\r$\n$\r$\nLeave this if another copy of Blurt (e.g. a dev build) still uses it." IDYES blurtRemoveRuntime IDNO blurtSkipRuntime
  blurtRemoveRuntime:
    RMDir /r "$LOCALAPPDATA\Blurt"
  blurtSkipRuntime:

  blurtSkipUserData:
!macroend
