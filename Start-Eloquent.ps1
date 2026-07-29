# Windows Eloquent - one-click idempotent bootstrap + launch for a Windows host.
#
# NOTE: this script was written and reviewed carefully, but has NOT been run
# end-to-end against a real Windows machine as part of this change - the
# environment that produced it is WSL2/Linux only (some pieces *were*
# exercised via WSL's cmd.exe/powershell.exe interop - see WINDOWS.md for
# exactly what was and wasn't verified that way). Treat it as a strong first
# draft: skim it before your first run, and please report back anything that
# doesn't match your machine so it can be fixed. See run.sh for the WSL/
# Linux equivalent, which *was* verified end-to-end.
#
# Source of truth for this project's code lives wherever you cloned/checked
# it out - for most people during development that's a WSL filesystem,
# reached from Windows as a UNC path like \\wsl.localhost\<distro>\...  This
# script detects that case (a UNC path, or a drive letter mapped to one) and
# mirrors the source to a Windows-local working copy under
# %LOCALAPPDATA%\WindowsEloquent\app using `robocopy /MIR` before doing any
# Windows-side work there. This matters for two reasons:
#   - Windows-native node/npm/Electron do not reliably work against a
#     Linux-installed node_modules tree (native modules, the Electron
#     binary itself - all built for Linux, not Windows) or the WSL Python
#     .runtime venv - both are excluded from the sync and rebuilt fresh
#     on the Windows side instead.
#   - npm (lots of small file I/O) is slow and occasionally flaky when its
#     working directory is a \\wsl.localhost\ (or any UNC) share.
# The venv and downloaded model live under %LOCALAPPDATA%\WindowsEloquent
# (a sibling of the mirrored `app` folder, not inside it), so re-running
# this script re-syncs any source changes (that's the point of /MIR) without
# ever re-downloading the model or recreating the venv.
#
# Alternative: skip the mirroring dance entirely by cloning this repo
# natively onto a Windows drive (e.g. `git clone ... C:\src\windows-eloquent`)
# and running this launcher from there - it detects it's already on a local
# drive and bootstraps in place, no copy step, no %LOCALAPPDATA%\...\app.
#
# Safe to re-run: every step checks whether it's already done before doing
# it. Steps:
#   0. resolve the source location; if it's on a UNC/WSL path (or a drive
#      mapped to one), mirror it to a local working copy with robocopy /MIR
#   1. Python 3.10+ (winget install if missing)
#   2. Node.js LTS (winget install if missing)
#   3. a venv under %LOCALAPPDATA%\WindowsEloquent\venv with `litert-lm` pip-installed
#   4. npm install (if node_modules is missing), in the local working copy
#   5. the Gemma E2B .litertlm file in the app's own model store
#      (reusing any already-downloaded copy instead of re-pulling ~2.4 GiB)
#   6. an initial settings.json enabling the real LiteRT-LM backend, but only
#      if the app has never been configured yet
#   7. `npm run dev`, in the local working copy
#
# Set $env:ELOQUENT_DRYRUN to any value other than "" or "0" to make this
# script print the resolved source/working-copy paths and the robocopy plan
# (if a sync applies) and then stop - no winget, no npm install, no venv, no
# model download, no settings write, no npm run dev. Useful for sanity
# checking the path/UNC-handling logic on a new machine before doing
# anything real.
#
# See WINDOWS.md for the manual step-by-step version of all of this and the
# reasoning behind it (why Managed mode, why port 9379, GPU findings, etc).

$ErrorActionPreference = 'Stop'

function Write-Step([string]$Message) {
    Write-Host ""
    Write-Host "==> $Message" -ForegroundColor Cyan
}
function Write-Ok([string]$Message) {
    Write-Host "    $Message"
}
function Write-Warn([string]$Message) {
    Write-Host "    WARNING: $Message" -ForegroundColor Yellow
}

function Test-IsRemoteSource([string]$path) {
    # Any UNC path - \\wsl.localhost\<distro>\..., \\wsl$\<distro>\..., or a
    # plain network share - not just the WSL-specific forms, since
    # npm/node/Electron are slow/fragile on any network share, not only a
    # WSL one.
    if ([string]::IsNullOrWhiteSpace($path)) { return $false }
    if ($path -match '^\\\\') { return $true }

    # A drive letter can also be a `net use`/`pushd`-style mapping onto a
    # UNC path (e.g. someone ran `net use Z: \\wsl.localhost\...` ahead of
    # time, or launched this script from the temp drive letter pushd itself
    # creates). Ask WMI/CIM what's really behind the letter.
    if ($path -match '^([A-Za-z]):\\') {
        $driveLetter = "$($Matches[1]):"
        try {
            $disk = Get-CimInstance -ClassName Win32_LogicalDisk -Filter "DeviceID='$driveLetter'" -ErrorAction Stop
            # DriveType 4 = "Network Drive"
            if ($disk -and $disk.DriveType -eq 4) { return $true }
        } catch {
            # Best-effort only - if CIM/WMI isn't available, fall through
            # and treat it as an ordinary local path rather than failing.
        }
    }
    return $false
}

$DryRun = -not [string]::IsNullOrEmpty($env:ELOQUENT_DRYRUN) -and $env:ELOQUENT_DRYRUN -ne '0'

# The true source location of this script (and the rest of the repo next to
# it) - NOT necessarily the current directory: if this was launched via
# run-windows.bat, cmd.exe may have `pushd`-ed into a temporary mapped drive
# letter for its own purposes, but $PSScriptRoot always reflects where this
# .ps1 file itself actually lives, UNC or not - PowerShell (unlike cmd.exe)
# has no trouble treating a UNC path as a location.
$SourceDir = $PSScriptRoot

$RuntimeBase    = Join-Path $env:LOCALAPPDATA 'WindowsEloquent'
$VenvDir        = Join-Path $RuntimeBase 'venv'
$StagingDir     = Join-Path $RuntimeBase 'staging'
$LocalMirrorDir = Join-Path $RuntimeBase 'app'
$ModelId        = 'gemma-4-e2b'
$ModelAlias     = 'e2b'
$HfRepo         = 'litert-community/gemma-4-E2B-it-litert-lm'
$AppUserDataDir = Join-Path $env:APPDATA 'windows-eloquent'
$RobocopyExcludes = @('node_modules', '.runtime', 'out', 'dist', '.git')

Write-Step "Windows Eloquent - Windows host bootstrap"
Write-Ok "Source dir: $SourceDir"

$IsRemoteSource = Test-IsRemoteSource $SourceDir
if ($IsRemoteSource) {
    $RepoRoot = $LocalMirrorDir
    Write-Ok "Source is on a UNC/network path."
    Write-Ok "Windows-native npm/node/Electron do not reliably work against a Linux-built"
    Write-Ok "node_modules tree or a Python venv built for WSL, and are slow over a network"
    Write-Ok "share in general - this run will mirror the source to a local Windows folder"
    Write-Ok "and do all Windows-side work (npm install, npm run dev, ...) there instead."
    Write-Ok "Local working copy: $RepoRoot"
} else {
    $RepoRoot = $SourceDir
    Write-Ok "Source is already on a local drive - bootstrapping in place, no mirroring."
}

if ($IsRemoteSource) {
    Write-Step "Sync plan: mirror source -> local working copy"
    $planArgs = @("`"$SourceDir`"", "`"$RepoRoot`"", '/MIR', '/XD') + $RobocopyExcludes + @('/R:2', '/W:2', '/MT:8')
    Write-Ok "robocopy $($planArgs -join ' ')"
    Write-Ok "Excluded from the sync (left alone / rebuilt fresh on the Windows side instead):"
    Write-Ok "  $($RobocopyExcludes -join ', ')"
    Write-Ok "Robocopy exit codes 0-7 mean success (bitmask of what it did, not an error);"
    Write-Ok "only >=8 is a real failure - see 'robocopy /?' or Microsoft's docs."
}

if ($DryRun) {
    Write-Step "ELOQUENT_DRYRUN is set - stopping here"
    Write-Ok "Resolved paths:"
    Write-Ok "  Source dir        : $SourceDir"
    Write-Ok "  Repo root (used)  : $RepoRoot"
    Write-Ok "  Runtime base      : $RuntimeBase"
    Write-Ok "  Venv dir          : $VenvDir"
    Write-Ok "  App user data dir : $AppUserDataDir"
    Write-Ok "No winget/npm/pip/model/settings/dev-server actions were taken."
    exit 0
}

# --- 0. Sync to a local working copy, if the source is remote ------------
if ($IsRemoteSource) {
    Write-Step "Syncing source to local working copy"
    New-Item -ItemType Directory -Force -Path $RepoRoot | Out-Null
    & robocopy $SourceDir $RepoRoot /MIR /XD @RobocopyExcludes /R:2 /W:2 /MT:8
    $RobocopyExit = $LASTEXITCODE
    if ($RobocopyExit -ge 8) {
        Write-Host "ERROR: robocopy failed while syncing to $RepoRoot (exit code $RobocopyExit)." -ForegroundColor Red
        Write-Host "  See https://learn.microsoft.com/windows-server/administration/windows-commands/robocopy#exit-return-codes" -ForegroundColor Red
        exit 1
    }
    Write-Ok "Synced (robocopy exit code $RobocopyExit - codes 0-7 are all success)."
}

Set-Location $RepoRoot

$HaveWinget = [bool](Get-Command winget -ErrorAction SilentlyContinue)
if (-not $HaveWinget) {
    Write-Warn "winget not found - auto-install steps below will be skipped where something is missing."
    Write-Warn "Install winget (App Installer, from the Microsoft Store) or install Python/Node manually."
}

# --- 1. Python 3.10+ -----------------------------------------------------
Write-Step "Checking for Python 3.10+"

function Get-PythonVersionOk([string]$exe) {
    try {
        $out = & $exe -c "import sys; print('%d.%d' % sys.version_info[:2])" 2>$null
        if (-not $out) { return $false }
        $parts = $out.Trim().Split('.')
        return ([int]$parts[0] -eq 3 -and [int]$parts[1] -ge 10)
    } catch {
        return $false
    }
}

$PythonExe = $null
foreach ($candidate in @('python', 'python3', 'py')) {
    $cmd = Get-Command $candidate -ErrorAction SilentlyContinue
    if ($cmd -and (Get-PythonVersionOk $candidate)) {
        $PythonExe = $candidate
        break
    }
}

if (-not $PythonExe) {
    if ($HaveWinget) {
        Write-Ok "No Python 3.10+ found - installing via winget (Python 3.12)..."
        winget install -e --id Python.Python.3.12 --accept-source-agreements --accept-package-agreements
        # winget updates the machine/user PATH but this process's PATH won't
        # see it until a new shell - probe the usual per-user install
        # location directly instead of relying on that.
        $guess = Join-Path $env:LOCALAPPDATA 'Programs\Python\Python312\python.exe'
        if (Test-Path $guess) {
            $PythonExe = $guess
        } else {
            Write-Warn "Installed Python via winget, but couldn't find it at the expected path."
            Write-Warn "Close this window, open a NEW terminal, and re-run this script."
            exit 1
        }
    } else {
        Write-Host "ERROR: Python 3.10+ is required and winget isn't available to install it." -ForegroundColor Red
        Write-Host "  Install it manually from https://python.org/downloads/ (check 'Add to PATH')," -ForegroundColor Red
        Write-Host "  then re-run this script." -ForegroundColor Red
        exit 1
    }
}
$pyVer = (& $PythonExe --version)
Write-Ok "Using $PythonExe ($pyVer)"

# --- 2. Node.js ------------------------------------------------------------
Write-Step "Checking for Node.js"
$NodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $NodeCmd) {
    if ($HaveWinget) {
        Write-Ok "Node.js not found - installing via winget (LTS)..."
        winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
        $guess = Join-Path $env:ProgramFiles 'nodejs'
        if (Test-Path (Join-Path $guess 'node.exe')) {
            $env:Path = "$guess;$env:Path"
        } else {
            Write-Warn "Installed Node via winget, but couldn't find it on the expected path."
            Write-Warn "Close this window, open a NEW terminal, and re-run this script."
            exit 1
        }
    } else {
        Write-Host "ERROR: Node.js is required and winget isn't available to install it." -ForegroundColor Red
        Write-Host "  Install it manually from https://nodejs.org/ (LTS), then re-run this script." -ForegroundColor Red
        exit 1
    }
} else {
    Write-Ok "Found $($NodeCmd.Source) ($(node --version))"
}

# --- 3. Persistent venv + litert-lm --------------------------------------
Write-Step "Checking litert-lm venv ($VenvDir)"
$VenvLitertLm = Join-Path $VenvDir 'Scripts\litert-lm.exe'
if (-not (Test-Path $VenvLitertLm)) {
    New-Item -ItemType Directory -Force -Path $RuntimeBase | Out-Null
    if (-not (Test-Path (Join-Path $VenvDir 'Scripts\python.exe'))) {
        Write-Ok "Creating venv at $VenvDir"
        & $PythonExe -m venv $VenvDir
    }
    Write-Ok "Installing litert-lm (pulls a prebuilt wheel, no compiler needed)..."
    & (Join-Path $VenvDir 'Scripts\python.exe') -m pip install --quiet --upgrade pip
    & (Join-Path $VenvDir 'Scripts\pip.exe') install --quiet --upgrade litert-lm
} else {
    $v = & $VenvLitertLm --version
    Write-Ok "litert-lm already installed ($v)"
}

# Put the venv's Scripts dir on PATH for this process so the app's default
# managed sidecar command (bare `litert-lm serve ...`, see
# src/shared/types.ts) can find it without hardcoding this venv's path into
# the app's own settings.
$env:Path = "$(Join-Path $VenvDir 'Scripts');$env:Path"

# --- 4. npm install --------------------------------------------------------
Write-Step "Checking Node dependencies (in $RepoRoot)"
if (-not (Test-Path (Join-Path $RepoRoot 'node_modules'))) {
    Write-Ok "node_modules missing - running npm install (this may take a minute)"
    npm install
} else {
    Write-Ok "node_modules already present - skipping npm install"
}

# --- 5. Model file in the app's own model store --------------------------
Write-Step "Checking the app's model store for $ModelId"
$ModelsDir = Join-Path $AppUserDataDir 'models'
$ModelFile = Join-Path $ModelsDir "$ModelId.litertlm"
New-Item -ItemType Directory -Force -Path $ModelsDir | Out-Null

if (Test-Path $ModelFile) {
    Write-Ok "Already installed at $ModelFile - skipping download."
} else {
    $existingCandidates = @(
        (Join-Path $env:USERPROFILE ".litert-lm\models\$ModelAlias\model.litertlm"),
        (Join-Path $StagingDir "models\$ModelAlias\model.litertlm")
    )
    $found = $existingCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1

    if ($found) {
        Write-Ok "Found an existing local copy at $found - copying (no download needed)."
        Copy-Item $found $ModelFile
    } else {
        Write-Ok "No local copy found - downloading + importing from HuggingFace."
        Write-Ok "(~2.4 GiB, ungated, no HF token needed - this can take a while)"
        New-Item -ItemType Directory -Force -Path $StagingDir | Out-Null
        $env:LITERT_LM_DIR = $StagingDir
        & $VenvLitertLm import --from-huggingface-repo $HfRepo "$ModelId.litertlm" $ModelAlias
        Remove-Item Env:\LITERT_LM_DIR
        Copy-Item (Join-Path $StagingDir "models\$ModelAlias\model.litertlm") $ModelFile
    }
    Write-Ok "Model installed at $ModelFile"
}

# --- 6. Seed initial settings (first run only) ----------------------------
Write-Step "Checking app settings"
$SettingsFile = Join-Path $AppUserDataDir 'settings.json'
if (Test-Path $SettingsFile) {
    Write-Ok "settings.json already exists - leaving your configuration as-is."
} else {
    Write-Ok "No settings.json yet - seeding one with the real LiteRT-LM backend enabled."
    $settings = @{
        modelId = $ModelId
        mode = 'offline'
        backend = 'litert'
        sidecar = @{
            mode = 'managed'
            managedCommand = 'litert-lm serve --host 127.0.0.1 --port {port}'
            externalUrl = 'http://127.0.0.1:9379'
            port = 9379
        }
        autoCopyOnCleanup = $false
        customVocabulary = @()
        hotkey = 'Ctrl+Shift+Space'
    }
    New-Item -ItemType Directory -Force -Path $AppUserDataDir | Out-Null
    $settings | ConvertTo-Json -Depth 5 | Set-Content -Path $SettingsFile -Encoding UTF8
}

# --- 7. Launch -------------------------------------------------------------
Write-Step "Launching Windows Eloquent (dev mode)"
Write-Ok "Run this on the Windows host (not WSL) for real microphone + GPU access - see WINDOWS.md."
Write-Ok "Once you've run 'npm run build' + 'npm run build:win', you can instead launch the built"
Write-Ok "installer/portable exe from .\dist\ directly - see electron-builder.yml / package.json."
Write-Ok "Working directory: $RepoRoot"
Write-Ok "Starting 'npm run dev' - close the app window (or Ctrl+C here) to stop."
npm run dev
