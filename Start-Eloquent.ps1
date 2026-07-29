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
#   2. Node.js >= 20.19 (or >= 22.12) - winget install if missing, winget
#      upgrade-in-place if an older Node is found (checked on every run, not
#      just the first - see the big Node comment below for why this specific
#      floor matters)
#   3. a venv under %LOCALAPPDATA%\WindowsEloquent\venv with `litert-lm` pip-installed
#   4. npm install (if node_modules is missing, or if it was last installed
#      with a different Node version - see the `.node-version-stamp` file),
#      in the local working copy
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

# Vite (a dependency of this project, via electron-vite) requires Node
# ^20.19.0 || >=22.12.0 - see node_modules/vite/package.json "engines" once
# installed. That specific floor matters, not just "recent Node": Vite's
# config loader calls the Node built-in crypto.hash(), which was added in
# Node 21.7.0 and backported to 20.12.0 - so anything from 20.12-20.18 or
# 21.0-21.6 either lacks crypto.hash entirely (a hard crash: "TypeError:
# crypto.hash is not a function") or fails Vite's own engines check. This
# project's own root package.json has no "engines" field of its own as of
# this writing, so this floor (taken from Vite's) is what we enforce.
$NodeFloorMajorMinor    = '20.19'
$NodeAltFloorMajorMinor = '22.12'

function Get-NodeVersion([string]$nodeExePath) {
    if (-not $nodeExePath) { return $null }
    try {
        $out = & $nodeExePath --version 2>$null
        if (-not $out) { return $null }
        $trimmed = ($out | Select-Object -First 1).ToString().Trim().TrimStart('v')
        return [version]$trimmed
    } catch {
        return $null
    }
}

function Test-NodeVersionOk([version]$ver) {
    if (-not $ver) { return $false }
    if ($ver.Major -gt 22) { return $true }
    if ($ver.Major -eq 22) { return $ver.Minor -ge 12 }
    if ($ver.Major -eq 20) { return $ver.Minor -ge 19 }
    return $false
}

function Resolve-NodeExe {
    # Prefer whatever's actually on PATH right now; fall back to the
    # standard per-machine install location, since a just-completed winget
    # install may not be visible on this process's PATH yet even after a
    # refresh from the registry (e.g. if winget wrote a slightly different
    # PATH entry, or the refresh raced the installer's own PATH update).
    $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $cmd) { $cmd = Get-Command node -ErrorAction SilentlyContinue }
    if ($cmd) { return $cmd.Source }
    $guess = Join-Path $env:ProgramFiles 'nodejs\node.exe'
    if (Test-Path $guess) { return $guess }
    return $null
}

function Resolve-NpmCmd([string]$nodeExePath) {
    # npm rides along with node - it should be right next to node.exe. Only
    # fall back to PATH lookup if that's somehow not the case.
    if ($nodeExePath) {
        $guess = Join-Path (Split-Path $nodeExePath -Parent) 'npm.cmd'
        if (Test-Path $guess) { return $guess }
    }
    $cmd = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $cmd) { $cmd = Get-Command npm -ErrorAction SilentlyContinue }
    if ($cmd) { return $cmd.Source }
    return $null
}

function Update-SessionPathFromRegistry {
    # winget updates the machine/user PATH in the registry, but this
    # process's own $env:Path won't see it until a new shell/process -
    # refresh it directly from the registry instead of relying on that, so a
    # same-session continue (no "close and reopen the window") can work.
    $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $userPath    = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = "$machinePath;$userPath;$env:Path"
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
$HfFileName     = 'gemma-4-E2B-it.litertlm'
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

# Detect Node.js (read-only - no installs/upgrades here) up front so the
# dry-run report below can show it too, not just the path-resolution logic.
$NodeExe   = Resolve-NodeExe
$NodeVer   = Get-NodeVersion $NodeExe
$NodeVerOk = Test-NodeVersionOk $NodeVer

if ($DryRun) {
    Write-Step "ELOQUENT_DRYRUN is set - stopping here"
    Write-Ok "Resolved paths:"
    Write-Ok "  Source dir        : $SourceDir"
    Write-Ok "  Repo root (used)  : $RepoRoot"
    Write-Ok "  Runtime base      : $RuntimeBase"
    Write-Ok "  Venv dir          : $VenvDir"
    Write-Ok "  App user data dir : $AppUserDataDir"
    $NodeDetected = if ($NodeExe) { "$NodeExe (v$NodeVer)" } else { "NOT FOUND" }
    $NodeVerdict = if ($NodeVerOk) {
        "OK"
    } elseif ($NodeExe) {
        "TOO OLD - would upgrade in place via 'winget install -e --id OpenJS.NodeJS.LTS'"
    } else {
        "MISSING - would install via 'winget install -e --id OpenJS.NodeJS.LTS'"
    }
    Write-Ok "  Node.js required  : >= $NodeFloorMajorMinor or >= $NodeAltFloorMajorMinor (Vite's own engines requirement)"
    Write-Ok "  Node.js detected  : $NodeDetected"
    Write-Ok "  Node version check: $NodeVerdict"
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

# --- 2. Node.js (>= $NodeFloorMajorMinor / $NodeAltFloorMajorMinor) --------
# A too-old Node here is exactly the failure mode this check exists to
# catch: `npm run dev` bootstraps fine (node/npm just need to exist), but
# Vite's config loader then dies with "TypeError: crypto.hash is not a
# function" the moment it starts - see the big comment near the top of this
# file for why 20.19/22.12 specifically. This must be re-checked on every
# run (not just when Node is first installed), since a machine can have an
# old Node sitting on PATH from before this check existed.
Write-Step "Checking for Node.js >= $NodeFloorMajorMinor (or >= $NodeAltFloorMajorMinor)"

if ($NodeExe -and $NodeVerOk) {
    Write-Ok "Found $NodeExe (v$NodeVer) - OK"
} else {
    if ($NodeExe -and $NodeVer) {
        Write-Warn "Found Node v$NodeVer at $NodeExe, but this project needs >= $NodeFloorMajorMinor (or >= $NodeAltFloorMajorMinor)."
        Write-Warn "(Vite's config loader uses crypto.hash(), added in Node 21.7 / backported to 20.12, and Vite's own"
        Write-Warn "package.json 'engines' field additionally requires >= 20.19 specifically - see WINDOWS.md.)"
    } elseif ($NodeExe -and -not $NodeVer) {
        Write-Warn "Found $NodeExe but couldn't determine its version - treating as too old to trust."
    } else {
        Write-Warn "Node.js not found."
    }

    if (-not $HaveWinget) {
        Write-Host "ERROR: Node.js >= $NodeFloorMajorMinor (or >= $NodeAltFloorMajorMinor) is required and winget isn't available to install/upgrade it." -ForegroundColor Red
        Write-Host "  Install it manually from https://nodejs.org/ (LTS), then re-run this script." -ForegroundColor Red
        exit 1
    }

    $verb = if ($NodeExe) { "Upgrading" } else { "Installing" }
    Write-Ok "$verb Node.js via winget (OpenJS.NodeJS.LTS) - this upgrades an existing too-old install in place..."
    winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements

    Update-SessionPathFromRegistry
    $NodeExe = Resolve-NodeExe
    $NodeVer = Get-NodeVersion $NodeExe
    $NodeVerOk = Test-NodeVersionOk $NodeVer

    if (-not $NodeExe) {
        Write-Host "ERROR: winget reported installing/upgrading Node.js, but node.exe still can't be found," -ForegroundColor Red
        Write-Host "  even after refreshing PATH from the registry and probing '$env:ProgramFiles\nodejs'." -ForegroundColor Red
        Write-Host "  Close this window, open a NEW terminal, and double-click run-windows.bat again." -ForegroundColor Red
        exit 1
    }
    if (-not $NodeVerOk) {
        Write-Host "ERROR: after installing/upgrading via winget, Node is still v$NodeVer at $NodeExe" -ForegroundColor Red
        Write-Host "  (needs >= $NodeFloorMajorMinor or >= $NodeAltFloorMajorMinor). This can happen if an older Node install" -ForegroundColor Red
        Write-Host "  earlier on PATH is shadowing the new one, or the winget upgrade didn't take." -ForegroundColor Red
        Write-Host "  Close this window, open a NEW terminal, and double-click run-windows.bat again; if that still fails," -ForegroundColor Red
        Write-Host "  uninstall old Node.js versions manually (Settings > Apps) and re-run." -ForegroundColor Red
        exit 1
    }
    Write-Ok "Now using $NodeExe (v$NodeVer)"
}

# npm rides with node - re-resolve it alongside whichever node.exe we ended
# up with above (same reasoning as node itself: don't trust a possibly-stale
# PATH, resolve explicitly and use full paths for every invocation below).
$NpmCmd = Resolve-NpmCmd $NodeExe
if (-not $NpmCmd) {
    Write-Host "ERROR: found node.exe at $NodeExe but couldn't find npm(.cmd) alongside it or on PATH." -ForegroundColor Red
    exit 1
}
Write-Ok "Using npm at $NpmCmd"
$NodeMajorMinor = "$($NodeVer.Major).$($NodeVer.Minor)"

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
$NodeModulesDir = Join-Path $RepoRoot 'node_modules'
# Stamps the major.minor Node version used for the last successful `npm
# install`, next to node_modules. If a stale-Node install already ran (the
# bug this whole version check exists for: npm install completing "fine" on
# an old Node, then Vite dying at dev-server startup), the deps on disk may
# have been resolved/built against the wrong engines/ABI - so a Node version
# change (including "no stamp yet", which covers exactly that prior-bug
# case) forces one re-install rather than trusting the existing node_modules.
$NodeVersionStampFile = Join-Path $RepoRoot '.node-version-stamp'
$StampedNodeVersion = $null
if (Test-Path $NodeVersionStampFile) {
    $StampedNodeVersion = (Get-Content -Path $NodeVersionStampFile -Raw -ErrorAction SilentlyContinue)
    if ($StampedNodeVersion) { $StampedNodeVersion = $StampedNodeVersion.Trim() }
}

$NeedsNpmInstall = $false
if (-not (Test-Path $NodeModulesDir)) {
    Write-Ok "node_modules missing - running npm install (this may take a minute)"
    $NeedsNpmInstall = $true
} elseif ($StampedNodeVersion -ne $NodeMajorMinor) {
    if ($StampedNodeVersion) {
        Write-Warn "node_modules was last installed with Node $StampedNodeVersion, but this run is using Node $NodeMajorMinor."
    } else {
        Write-Warn "node_modules exists but predates this script's Node-version tracking (no stamp file)."
    }
    Write-Warn "Re-running npm install to avoid stale-Node engine/ABI mismatches."
    $NeedsNpmInstall = $true
} else {
    Write-Ok "node_modules already present and matches Node $NodeMajorMinor - skipping npm install"
}

if ($NeedsNpmInstall) {
    & $NpmCmd install
    if ($LASTEXITCODE -ne 0) {
        Write-Host "ERROR: npm install failed (exit code $LASTEXITCODE)." -ForegroundColor Red
        exit 1
    }
    Set-Content -Path $NodeVersionStampFile -Value $NodeMajorMinor -Encoding UTF8 -NoNewline
    Write-Ok "Stamped $NodeVersionStampFile with Node $NodeMajorMinor"
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
        & $VenvLitertLm import --from-huggingface-repo $HfRepo $HfFileName $ModelAlias
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
& $NpmCmd run dev
