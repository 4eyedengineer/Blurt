# Blurt

Blurt is an offline dictation app for Windows. Hold a key or press record, speak, and get back
clean text with filler words removed and punctuation and capitalization fixed, ready to paste
anywhere. Everything runs on your own machine against a local Gemma model, so nothing you say
leaves your computer.

macOS support (Apple Silicon) is written and in the repository, but nothing has been run on a Mac
yet and there is no macOS release. See [MACOS.md](MACOS.md) for the current state.

## Credit

Blurt exists because of Google's [AI Edge Eloquent](https://github.com/google-ai-edge/eloquent).
Eloquent showed that a small on-device model can do dictation cleanup well enough to use every
day, and it is the direct inspiration for this project's design, from the hold-to-talk flow to the
cleanup pass that runs after transcription. Blurt is an independent reimplementation for Windows,
which Eloquent does not currently target. It is not a Google product and is not affiliated with or
endorsed by Google.

<!-- TODO: add a screenshot or short GIF of the Dictate screen and the push-to-talk overlay here -->

## Requirements

Check these before downloading anything. The model download alone is a couple of gigabytes, so it
is better to find a missing prerequisite first.

- **Windows 10 or 11, 64-bit, or macOS 12.0 (Monterey) or later on Apple Silicon.** Intel Macs are
  not supported: the engine's Python dependency (`litert-lm-api`) only ships an Apple Silicon
  build, so an Intel Mac cannot run the local model at all. **macOS support is implemented but has
  not yet been run on real Apple Silicon hardware** - see [MACOS.md](MACOS.md) for exactly what
  that means and what to watch for.
- **Python 3.10 or newer, already installed and on `PATH`.** Blurt does not bundle Python.
  - On Windows, first launch looks for `py -3.12`, `py -3`, and then `python`. Get Python from
    [python.org](https://www.python.org/) and check "Add python.exe to PATH" during install.
  - On macOS, first launch looks for a Homebrew or python.org install, then a bare `python3`.
    Install one with `brew install python@3.12` or a python.org installer. macOS's built-in
    `/usr/bin/python3` does not count - see [MACOS.md](MACOS.md) for why.
  - If no Python 3.10+ is found, Blurt shows an error instead of guessing.
- **About 6 GB of free disk space** for the smallest model, and more for the larger ones. A model
  costs roughly twice its download size on disk, because Blurt keeps both the file it downloaded
  and the copy the model server registers, plus about a gigabyte of compiled shader cache. E2B
  needs about 6 GB, E4B about 8 GB, and 12B about 13 GB. Blurt checks for space before it starts
  downloading and tells you if there is not enough room.
- **A microphone.**

A GPU is optional. On Windows, if your machine has a usable one, Blurt uses it automatically and
dictation is noticeably faster; if not, Blurt falls back to your CPU on its own - this is verified
behavior. On Apple Silicon, the same automatic GPU/CPU selection is implemented via Metal, and
unified memory means there is no separate VRAM requirement - but this has not been run on real
hardware yet, so treat it as expected behavior, not a confirmed one; see [MACOS.md](MACOS.md).

## Install

Download `blurt-<version>-setup.exe` from the
[Releases page](https://github.com/4eyedengineer/Blurt/releases) and run it. It is a per-user
installer, so it needs no administrator rights. It creates Start Menu and desktop shortcuts and an
entry in "Installed apps" with an uninstaller.

The installer is not code-signed, so Windows SmartScreen will probably show a blue "Windows
protected your PC" warning the first time you run it. This is normal for a small independently
published app. Click **More info**, then **Run anyway**.

From 1.4.2 onward the Windows build keeps itself up to date. It checks this repository's Releases
at startup and every six hours, downloads anything newer in the background, and installs it the
next time you quit. Settings shows what it is doing, and offers a **Restart now** if you would
rather not wait. Because each release ships a block map, a typical update transfers a few MB rather
than the whole installer. Nothing is sent anywhere: the check is a plain read of this repo's public
release feed, and the download is verified against the SHA-512 published alongside it. Your models
and history live outside the install directory and are untouched by an update.

**macOS** (Apple Silicon, macOS 12.0 or later) is implemented but there is no macOS release yet,
and none of it has run on real hardware - see [MACOS.md](MACOS.md) for the honest current state,
and for building and running Blurt from source on a Mac in the meantime. Once a build is published,
install is the usual drag-to-Applications `.dmg`; without a paid Apple Developer ID signing it,
Gatekeeper will block the first launch rather than offering a Windows-SmartScreen-style
click-through, so MACOS.md also covers the workaround.

First launch does some one-time setup, the same on both platforms.

1. If Blurt cannot find a healthy Python virtual environment, it shows a short setup screen with a
   step list and a live log while it creates one and installs the pinned `litert-lm` package into
   it. That download is around 45 MB and usually takes well under a minute.
2. Once that finishes, open the **Settings** tab and download a model. The choices are Gemma 4
   E2B, E4B, and 12B. E2B is the smallest and fastest and is a good place to start. This is a much
   larger download from Hugging Face and is the step that takes real time, roughly 2.4 GB for E2B,
   3.4 GB for E4B, and 6.1 GB for 12B. Each model's row shows what it will cost on disk and
   whether your machine can run it.

Blurt is ready after that. Open **Dictate** and press record, or use push-to-talk from anywhere.

## Privacy

- Speech recognition and text cleanup both run locally against the model you downloaded. Audio and
  transcripts are never sent anywhere for inference.
- The only network access Blurt makes is the one-time model download from Hugging Face described
  above. If you install dependencies or run from source, npm and PyPI are also contacted.
- Dictation history is stored locally on disk and is never uploaded.
- There is no telemetry, no analytics, no crash reporting, and no account or sign-in.

## Using Blurt

- **Dictate tab.** Press the record button and speak. A live transcript streams in as you talk.
  When you stop, a cleanup pass runs automatically and briefly shows what changed before settling
  on the cleaned text. The Key Points, Formal, Short, and Long buttons rewrite the result in that
  style. There is also a copy button and a voice edit box, where you can type an instruction such
  as "replace foo with bar".
- **Push-to-talk.** Hold a configurable key, Right Ctrl by default, from anywhere in Windows. A
  small pill appears, and a short tone plays once the microphone is actually live. Opening the
  audio device takes a second or two, so the tone is your cue that Blurt is really listening
  rather than just that you pressed the key. Speak, then release the key. The text is cleaned up,
  copied to the clipboard, and pasted into whatever had focus if auto-paste is on. Push-to-talk
  dictations are saved to History like any other. You can change the key or turn off auto-paste in
  Settings. Right Alt is available there but not recommended, because Windows moves focus to the
  menu bar whenever Alt is pressed and released on its own, which takes focus away from the field
  you were typing in.
- **If you do not say anything**, nothing happens and the pill disappears. Blurt does not paste,
  does not touch your clipboard, and does not save a row to History.
- **Closing the window** leaves Blurt running in the system tray so push-to-talk keeps working
  with nothing on screen. Click the tray icon to bring the window back, or right-click it to quit.
  You can turn this off in Settings if you would rather the close button quit outright.
- **History** keeps every completed dictation from both the Dictate tab and push-to-talk. It is
  searchable by text, and clicking an entry reopens it.
- **Settings** is where you choose and download a model, pick a microphone, see whether the engine
  is running on GPU or CPU, manage custom vocabulary, set the global hotkey, and configure
  push-to-talk. The GPU or CPU line reports what actually happened rather than offering a choice.
- **Microphone** defaults to whatever Windows calls the default input. Picking a specific one is
  worth doing if you have several, because when a microphone disconnects Windows promotes another
  without asking, and some virtual devices record silence.

## Troubleshooting

- **"No Python 3.10+ installation was found."** On Windows, install Python 3.10 or newer from
  [python.org](https://www.python.org/) with "Add python.exe to PATH" checked, then relaunch
  Blurt. On macOS, install one with Homebrew (`brew install python@3.12`) or a python.org
  installer, then relaunch; macOS's built-in `/usr/bin/python3` is an Xcode Command Line Tools
  stub, not a full interpreter, so it does not count and Blurt does not look for it.
- **SmartScreen blocks the app.** Click **More info**, then **Run anyway**. See
  [Install](#install) above.
- **Push-to-talk or auto-paste does nothing on macOS.** Grant Blurt Accessibility access: System
  Settings > Privacy & Security > Accessibility. Without it, push-to-talk refuses to arm at all
  (attempting the key hook without permission is a known way to crash the whole app, so Blurt
  declines instead), and auto-paste's synthesized Cmd+V fails outright - the text still lands on
  your clipboard either way. Settings has an "Open System Settings" button next to push to talk
  that raises the permission prompt directly and re-arms push-to-talk as soon as it is granted.
  Rebuilding an unsigned copy of Blurt loses this permission every time, since macOS ties it to the
  app's code signature; see [MACOS.md](MACOS.md).
- **"Port 9379 is already in use."** Blurt's local model server listens on port 9379 by default.
  Something else is using it, often a sidecar left over from a session that did not shut down
  cleanly. The error names the process ID so you can end it in Task Manager (Windows) or Activity
  Monitor (macOS), or you can change the port in Settings under Advanced. Both a normal quit and a
  hard crash shut this process down on their own, so you should only see this after something
  unusual.
- **Uninstalling.** Uninstall Blurt like any other Windows app through Settings > Apps or the
  Start Menu shortcut. It asks separately whether to also remove your saved data, which includes
  settings, history, and the downloaded model, and whether to remove the shared Python runtime it
  set up. Keeping the runtime is safe if you plan to reinstall later. On macOS, quit Blurt and drag
  it from Applications to the Trash; there is no separate uninstall step for its data or runtime,
  since settings, history, the downloaded model, and the Python virtual environment all live
  together under `~/Library/Application Support/Blurt`, which you can delete by hand if you want
  everything gone.

## Contributing

Building from source, running the dev server, running the tests, and understanding how the pieces
fit together are all covered in [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Blurt is licensed under the [GNU General Public License v3.0](LICENSE). You are free to run,
study, modify, and redistribute it. Any derivative work you distribute must also be licensed under
GPL-3.0 with its source made available.
