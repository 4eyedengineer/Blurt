#!/usr/bin/env bash
#
# One-click idempotent bootstrap + launch for Windows Eloquent on WSL/Linux.
#
# Safe to re-run any time - each step checks whether it's already done and
# skips it if so. Steps:
#   1. npm install (if node_modules is missing)
#   2. find a Python 3.10+ interpreter (required by the `litert-lm` pip package)
#   3. create ./.runtime/venv and `pip install litert-lm` into it (if missing)
#   4. make sure the app's own model store has the Gemma E2B .litertlm file,
#      reusing any already-downloaded copy on this machine instead of
#      re-pulling ~2.4 GiB from HuggingFace if one can be found
#   5. seed an initial settings.json that points the app at the real
#      LiteRT-LM backend, but only if the app has never been configured yet
#   6. launch the app in dev mode, adding whatever Electron flags this
#      environment needs (WSLg has no setuid sandbox helper without root, so
#      --noSandbox is added automatically when that's detected)
#
# See WINDOWS.md and README.md ("Quick start") for the manual/Windows-host
# version of these same steps and their rationale.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"

RUNTIME_DIR="$REPO_ROOT/.runtime"
VENV_DIR="$RUNTIME_DIR/venv"
MODEL_ID="gemma-4-e2b"
MODEL_ALIAS="e2b"
HF_REPO="litert-community/gemma-4-E2B-it-litert-lm"
HF_FILE_NAME="gemma-4-E2B-it.litertlm"
APP_USER_DATA_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/windows-eloquent"

step() { printf '\n==> %s\n' "$1"; }
ok()   { printf '    %s\n' "$1"; }
warn() { printf '    WARNING: %s\n' "$1" >&2; }

step "Windows Eloquent - WSL/Linux bootstrap"
ok "Repo: $REPO_ROOT"

# --- 1. Node dependencies -----------------------------------------------
step "Checking Node dependencies"
if [ ! -d "$REPO_ROOT/node_modules" ]; then
  ok "node_modules missing - running npm install (this may take a minute)"
  npm install
else
  ok "node_modules already present - skipping npm install"
fi

# --- 2. Python 3.10+ interpreter ----------------------------------------
step "Locating a Python 3.10+ interpreter for litert-lm"
PYTHON_BIN=""
for candidate in python3.13 python3.12 python3.11 python3.10 python3; do
  if command -v "$candidate" >/dev/null 2>&1; then
    ver="$("$candidate" -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null || echo "0.0")"
    major="${ver%%.*}"
    minor="${ver##*.}"
    if [ "$major" -eq 3 ] 2>/dev/null && [ "$minor" -ge 10 ] 2>/dev/null; then
      PYTHON_BIN="$candidate"
      break
    fi
  fi
done
if [ -z "$PYTHON_BIN" ]; then
  echo "ERROR: no Python 3.10+ interpreter found on PATH (litert-lm requires >=3.10)." >&2
  echo "  Install one, e.g.: sudo apt install python3.11 python3.11-venv" >&2
  echo "  (Ubuntu's system python3 is often 3.8, which is too old - look for" >&2
  echo "  an alternate interpreter like /usr/bin/python3.11 before installing.)" >&2
  exit 1
fi
ok "Using $PYTHON_BIN ($("$PYTHON_BIN" --version 2>&1))"

# --- 3. Persistent venv + litert-lm -------------------------------------
step "Checking .runtime/venv (litert-lm CLI)"
mkdir -p "$RUNTIME_DIR"
if [ ! -x "$VENV_DIR/bin/litert-lm" ]; then
  if [ ! -d "$VENV_DIR" ]; then
    ok "Creating venv at $VENV_DIR"
    # Some Debian/Ubuntu Python builds ship `venv` without a working
    # ensurepip (python3-venv split package not installed, no root to fix
    # it) - `--without-pip` sidesteps that; get-pip.py below bootstraps pip
    # into it either way. If ensurepip *is* fine, --without-pip is harmless.
    "$PYTHON_BIN" -m venv --without-pip "$VENV_DIR"
  fi
  if [ ! -x "$VENV_DIR/bin/pip" ]; then
    ok "Bootstrapping pip into the venv"
    curl -sL https://bootstrap.pypa.io/get-pip.py -o "$RUNTIME_DIR/get-pip.py"
    "$VENV_DIR/bin/python" "$RUNTIME_DIR/get-pip.py"
    rm -f "$RUNTIME_DIR/get-pip.py"
  fi
  ok "Installing litert-lm (this downloads a ~46 MB wheel, not the model itself)"
  "$VENV_DIR/bin/pip" install --quiet --upgrade litert-lm
else
  ok "litert-lm already installed ($("$VENV_DIR/bin/litert-lm" --version 2>&1))"
fi

# Put the venv's `litert-lm` binary on PATH so the app's *default* managed
# sidecar command (bare `litert-lm serve ...`, see src/shared/types.ts) can
# find it without hardcoding this venv's path into the app's settings.
export PATH="$VENV_DIR/bin:$PATH"

# --- 4. Model file in the app's own model store -------------------------
step "Checking the app's model store for $MODEL_ID"
MODEL_FILE="$APP_USER_DATA_DIR/models/$MODEL_ID.litertlm"
mkdir -p "$APP_USER_DATA_DIR/models"

if [ -f "$MODEL_FILE" ]; then
  ok "Already installed at $MODEL_FILE - skipping download."
else
  # Reuse any already-downloaded copy on this machine before pulling
  # ~2.4 GiB again (e.g. a prior manual `litert-lm import`, or one left by
  # this script's own staging directory below on a previous partial run).
  FOUND=""
  for guess in \
    "$HOME/.litert-lm/models/$MODEL_ALIAS/model.litertlm" \
    "$RUNTIME_DIR/staging/models/$MODEL_ALIAS/model.litertlm"
  do
    if [ -f "$guess" ]; then FOUND="$guess"; break; fi
  done

  if [ -n "$FOUND" ]; then
    ok "Found an existing local copy at $FOUND - copying (no download needed)."
    cp "$FOUND" "$MODEL_FILE"
  else
    ok "No local copy found - downloading + importing from HuggingFace."
    ok "(~2.4 GiB, ungated, no HF token needed - this can take a while)"
    STAGING_DIR="$RUNTIME_DIR/staging"
    mkdir -p "$STAGING_DIR"
    LITERT_LM_DIR="$STAGING_DIR" "$VENV_DIR/bin/litert-lm" import \
      --from-huggingface-repo "$HF_REPO" "$HF_FILE_NAME" "$MODEL_ALIAS"
    cp "$STAGING_DIR/models/$MODEL_ALIAS/model.litertlm" "$MODEL_FILE"
  fi
  ok "Model installed at $MODEL_FILE"
fi

# --- 5. Seed initial settings (first run only) --------------------------
step "Checking app settings"
SETTINGS_FILE="$APP_USER_DATA_DIR/settings.json"
if [ -f "$SETTINGS_FILE" ]; then
  ok "settings.json already exists - leaving your configuration as-is."
else
  ok "No settings.json yet - seeding one with the real LiteRT-LM backend enabled."
  cat > "$SETTINGS_FILE" <<JSON
{
  "modelId": "$MODEL_ID",
  "mode": "offline",
  "backend": "litert",
  "sidecar": {
    "mode": "managed",
    "managedCommand": "litert-lm serve --host 127.0.0.1 --port {port}",
    "externalUrl": "http://127.0.0.1:9379",
    "port": 9379
  },
  "autoCopyOnCleanup": false,
  "customVocabulary": [],
  "hotkey": "Ctrl+Shift+Space"
}
JSON
fi

# --- 6. Display / audio sanity check ------------------------------------
step "Checking WSLg display/audio"
if [ -n "${DISPLAY:-}" ] || [ -n "${WAYLAND_DISPLAY:-}" ]; then
  ok "Display available (DISPLAY=${DISPLAY:-<unset>} WAYLAND_DISPLAY=${WAYLAND_DISPLAY:-<unset>})"
else
  warn "No DISPLAY or WAYLAND_DISPLAY set - the window will likely fail to open."
  warn "This needs WSLg (Windows 11, or WSL updated via 'wsl --update')."
fi
if command -v pactl >/dev/null 2>&1 && pactl info >/dev/null 2>&1; then
  if pactl list sources short 2>/dev/null | grep -qi "RDPSource\|source"; then
    ok "A PulseAudio mic source is present (WSLg audio bridge) - dictation may work."
    ok "See README.md 'Limitations' for how far this was actually verified."
  else
    warn "No PulseAudio source found - dictation will have no microphone to record from."
  fi
else
  warn "PulseAudio not reachable - dictation will have no microphone to record from."
fi

# --- 7. Launch -----------------------------------------------------------
step "Launching Windows Eloquent (dev mode)"
ELECTRON_FLAGS=()
SANDBOX_HELPER="$REPO_ROOT/node_modules/electron/dist/chrome-sandbox"
if [ -f "$SANDBOX_HELPER" ]; then
  # The setuid sandbox helper only works if it's owned by root with the
  # setuid bit set - which requires a one-time `sudo chown root:root
  # chrome-sandbox && sudo chmod 4755 chrome-sandbox` that most WSL setups
  # never run. Detect that instead of guessing, so real Linux desktops with
  # a properly configured sandbox keep the extra isolation.
  perms="$(stat -c '%U:%a' "$SANDBOX_HELPER" 2>/dev/null || echo '')"
  if [ "$perms" != "root:4755" ]; then
    ok "chrome-sandbox isn't setuid-root ($perms) and sudo isn't assumed available - adding --noSandbox."
    ELECTRON_FLAGS+=(--noSandbox)
  fi
fi

ok "Starting 'npm run dev' - close the app window (or Ctrl+C here) to stop."
exec npm run dev -- "${ELECTRON_FLAGS[@]}"
