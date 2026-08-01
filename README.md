# Blurt

Blurt is an offline, on-device dictation app for Windows: hold a key or hit record, speak, and get
back cleaned-up text - filler words stripped, punctuation and capitalization fixed - ready to paste
anywhere. Everything runs locally on your own machine against a local Gemma model. Nothing you say
leaves your computer.

Blurt is inspired by Google's AI Edge Eloquent, which has no Windows version - Blurt is an
independent project, not a Google product and not affiliated with Google.

<!-- TODO: add a screenshot or short GIF of the Dictate screen / push-to-talk overlay here -->

## Requirements

Check these *before* downloading anything - the model download alone is a couple gigabytes, and
it's better to find a missing prerequisite first:

- **Windows 10 or 11, 64-bit.**
- **Python 3.10 or newer, already installed and on `PATH`.** Blurt does not bundle Python. On
  first launch it looks for `py -3.12`, `py -3`, or `python`, in that order; if none of those
  resolve to Python 3.10+, it shows an error screen instead of guessing. Get it from
  [python.org](https://www.python.org/) if you don't have it - check "Add python.exe to PATH"
  during install.
- **About 6 GB of free disk space** for the smallest model, more for the larger ones. A model
  costs roughly twice its download size on disk: Blurt keeps the file it downloaded *and* the copy
  the model server registers, plus around a gigabyte of compiled shader cache. So E2B needs about
  6 GB, E4B about 8 GB, and 12B about 13 GB. Blurt checks this before it starts downloading and
  tells you if there isn't room, so you won't discover it halfway through.
- **A microphone.**

A discrete or integrated GPU is not required. If your machine has a usable one, Blurt uses it
automatically and dictation is noticeably faster; if not, it falls back to your CPU by itself (see
[Using Blurt](#using-blurt) below).

## Install

Grab the latest build from the Releases page. Two options:

- **Installer** (`Blurt-<version>-setup.exe`) - a normal per-user installer: Start Menu and desktop
  shortcuts, a proper entry in "Installed apps" with an uninstaller.
- **Portable** (`Blurt-<version>-portable.exe`) - a single exe, no install step. Run it from
  anywhere (Downloads, a USB stick).

Neither build is code-signed, so Windows SmartScreen will very likely show a blue "Windows
protected your PC" warning the first time you run it. This is normal for a small, independently
published app rather than a sign anything is wrong - click **More info**, then **Run anyway**.

**First launch** does a bit of one-time setup:

- If Blurt can't find a healthy Python virtual environment yet, it shows a short setup screen
  (a small step list plus a live log) while it creates one and installs the pinned `litert-lm`
  Python package into it - a roughly 45 MB download, typically well under a minute on a normal
  connection.
- Once that's done, open the **Settings** tab and download a model (Gemma 4 E2B, E4B, or 12B -
  E2B is the smallest and fastest, and a reasonable default to start with). This is a separate,
  much larger download from Hugging Face and is the one that takes real time: ~2.4 GB for E2B,
  ~3.4 GB for E4B, ~6.1 GB for 12B, so budget several minutes depending on your connection. Each
  model's row shows what it will actually cost on disk, and whether this machine can run it.

After that, Blurt is ready: go to **Dictate** and press record, or use push-to-talk from anywhere
(see below).

## Privacy

- All speech recognition and text cleanup run locally, on your machine, against the model you
  downloaded. Audio and transcripts are never sent anywhere for inference.
- The only network access Blurt makes is the one-time model download from Hugging Face described
  above (and, if you're installing dependencies or running from source, whatever `npm install`/
  `pip install` fetch from the npm and PyPI registries).
- Dictation history is stored locally on disk (see [Using Blurt](#using-blurt)) and is never
  uploaded anywhere.
- There is no telemetry, analytics, or crash reporting, and no account or sign-in of any kind.

## Using Blurt

- **Dictate tab** - press the record button, speak; a live transcript streams in as you talk. On
  stop, a cleanup pass runs automatically (removing filler words, fixing punctuation), briefly
  showing what changed before settling on the cleaned text. Key Points / Formal / Short / Long
  buttons rewrite the result in that style; a copy button and an optional "voice edit" text box
  (e.g. "replace foo with bar") round out the screen.
- **Push-to-talk** - hold a configurable key (Right Alt by default) from anywhere in Windows, not
  just while Blurt's window is focused. A small pill appears; a short tone plays the moment the
  microphone is actually live (opening the audio device takes a second or two, so the tone is your
  cue that it's really listening, not just that you pressed the key). Speak, then release the key:
  the text is cleaned up, copied to the clipboard, and - if auto-paste is enabled - pasted directly
  into whatever had focus. Every push-to-talk dictation is also saved to History, exactly like one
  done from the Dictate tab. Change the key or turn off auto-paste in Settings.
- **If you don't say anything**, nothing happens - the pill just disappears. Blurt won't paste,
  won't touch your clipboard, and won't save a row to History. A hold that picked up no speech
  leaves your machine exactly as it found it.
- **History** - every completed dictation (from either the Dictate tab or push-to-talk) is saved
  locally, searchable by text, and clickable to reopen.
- **Settings** - choose which model to use and download/delete it, see whether the engine is
  currently running on GPU or CPU (this is a read-out of what actually happened, not a toggle -
  see [Requirements](#requirements)), manage custom vocabulary words, set the global hotkey, and
  configure push-to-talk.

## Troubleshooting

- **"No Python 3.10+ installation was found."** Install Python 3.10 or newer from
  [python.org](https://www.python.org/), making sure "Add python.exe to PATH" is checked, then
  relaunch Blurt.
- **SmartScreen blocks the app.** See [Install](#install) above - click **More info**, then
  **Run anyway**.
- **"Port 9379 is already in use."** Blurt's local model server listens on port 9379 by default.
  This message means some other process (often a Blurt sidecar left over from a session that
  didn't shut down cleanly) is already using it; the error names the offending PID so you can end
  it in Task Manager, or change the port in Settings' Advanced section, then try again.
  A normal quit, and a hard crash of the app, both shut this process down on their own - you
  should only see this after something unusual.
- **Uninstalling.** If you used the installer, uninstall Blurt like any other Windows app (Settings
  > Apps, or the Start Menu shortcut's uninstaller) - this removes your settings, history, and
  downloaded model, and separately asks whether to also remove the shared Python runtime it set up
  (safe to keep if you plan to reinstall later). If you used the portable exe, just delete it; you
  can remove its userData and Python runtime folders under `%APPDATA%` and `%LOCALAPPDATA%`
  yourself if you want a completely clean slate.

## Contributing

Building from source, running the dev server, running tests, and understanding how the app fits
together all live in [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Blurt is licensed under the [GNU General Public License v3.0](LICENSE). In short: you're free to
run, study, modify, and redistribute it, but any derivative work you distribute must also be
licensed under GPL-3.0 and its source made available.
