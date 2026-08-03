import { useEffect, useState } from 'react'
import type { ModelId, PushToTalkStatus, SidecarMode } from '@shared/types'
import { DEFAULT_MANAGED_COMMAND, PTT_KEY_OPTIONS, pttKeyLabel } from '@shared/types'
import type { ModelDownloadState } from '@shared/models'
import { getCatalogEntry } from '@shared/models'
import type { HardwareProbeResult } from '@shared/hardware'
import { checkModelRequirements, requiredDiskBytes } from '@shared/modelRequirements'
import { useSettings } from '../context/SettingsContext'
import { useModelManager } from '../hooks/useModelManager'
import { useBackendStatus } from '../hooks/useBackendStatus'
import { useHardwareInfo } from '../hooks/useHardwareInfo'
import { useAudioInputDevices } from '../hooks/useAudioInputDevices'
import { Toggle } from '../components/Toggle'
import { formatBytes } from '../lib/format'
import './SettingsScreen.css'

const MODEL_OPTIONS: Array<{ id: ModelId; label: string }> = [
  { id: 'gemma-4-e2b', label: 'Gemma 4 E2B, fastest' },
  { id: 'gemma-4-e4b', label: 'Gemma 4 E4B, balanced' },
  { id: 'gemma-4-12b', label: 'Gemma 4 12B, best quality and slowest' }
]

type HotkeyStatus = 'idle' | 'saved' | 'error'

function modelStateLabel(state: ModelDownloadState): string {
  switch (state) {
    case 'idle':
      return 'Not downloaded'
    case 'resolving':
      return 'Looking up download…'
    case 'downloading':
      return 'Downloading…'
    case 'importing':
      return 'Registering…'
    case 'done':
      return 'Installed'
    case 'error':
      return 'Download failed'
    case 'cancelled':
      return 'Cancelled'
    default:
      return state
  }
}

interface ModelRowProps {
  option: (typeof MODEL_OPTIONS)[number]
  selected: boolean
  onSelect: () => void
  models: ReturnType<typeof useModelManager>
  hardware: HardwareProbeResult | null
}

function ModelRow({
  option,
  selected,
  onSelect,
  models,
  hardware
}: ModelRowProps): React.JSX.Element {
  const installed = models.installed.some((m) => m.modelId === option.id)
  const progress = models.progress[option.id]
  const entry = getCatalogEntry(option.id)
  const busy = progress?.state === 'downloading' || progress?.state === 'resolving'
  const pct =
    progress?.totalBytes && progress.totalBytes > 0
      ? Math.min(100, Math.round((progress.receivedBytes / progress.totalBytes) * 100))
      : null
  // Real disk cost once installed is ~2x the download plus caches (see
  // modelRequirements.ts) - not just the download size, which is all the UI
  // used to show.
  const totalDiskNeeded = requiredDiskBytes(entry.approxSizeBytes)
  // hardware === null means "still probing" (the GPU probe alone can take a
  // few seconds on Windows) - show nothing blocker/note-wise until it
  // resolves rather than flashing a false all-clear.
  const requirements = hardware ? checkModelRequirements(entry, hardware) : null
  const blocked = !installed && !busy && (requirements?.blockers.length ?? 0) > 0

  return (
    <label className="settings-screen__radio">
      <input type="radio" name="model" checked={selected} onChange={onSelect} />
      <div className="settings-screen__model-row">
        <div>
          <span className="settings-screen__radio-title">{option.label}</span>
          <span className="settings-screen__radio-desc">
            {modelStateLabel(progress?.state ?? 'idle')} · ~{formatBytes(totalDiskNeeded)} on disk
            {busy && pct !== null ? ` · ${pct}%` : ''}
          </span>
          {busy && (
            <div className="settings-screen__progress-track">
              <div className="settings-screen__progress-fill" style={{ width: `${pct ?? 8}%` }} />
            </div>
          )}
          {progress?.state === 'error' && progress.error && (
            <span className="settings-screen__status settings-screen__status--error">
              {progress.error}
            </span>
          )}
          {requirements?.blockers.map((blocker) => (
            <span key={blocker} className="settings-screen__status settings-screen__status--error">
              {blocker}
            </span>
          ))}
          {requirements?.notes.map((note) => (
            <span key={note} className="settings-screen__hint">
              {note}
            </span>
          ))}
        </div>
        <div className="settings-screen__model-actions">
          {!installed && !busy && (
            <button
              type="button"
              disabled={blocked}
              title={blocked ? requirements?.blockers.join(' ') : undefined}
              onClick={(e) => {
                e.preventDefault()
                models.download(option.id)
              }}
            >
              Download
            </button>
          )}
          {busy && (
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault()
                models.cancelDownload(option.id)
              }}
            >
              Cancel
            </button>
          )}
          {installed && !busy && (
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault()
                models.remove(option.id)
              }}
            >
              Delete
            </button>
          )}
        </div>
      </div>
    </label>
  )
}

/**
 * One labelled on/off row - the shape every toggle in Settings uses.
 *
 * The wrapping <label> is deliberate and load-bearing: <button> is a
 * labelable element, so wrapping it means clicking the row's text activates
 * the toggle, not just the switch itself. Swapping this for a <div> would
 * silently shrink the hit target to the switch.
 *
 * `label` is passed to Toggle as well so the switch keeps an accessible name
 * of its own, rather than depending on how a given screen reader resolves a
 * wrapping label.
 */
function SettingRow({
  label,
  checked,
  onChange
}: {
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
}): React.JSX.Element {
  return (
    <label className="settings-screen__toggle-row">
      <strong>{label}</strong>
      <Toggle checked={checked} onChange={onChange} label={label} />
    </label>
  )
}

/**
 * Engine plumbing: which sidecar to talk to, and how to reach it. Lives
 * in its own component both to keep SettingsScreen readable and because
 * it is the one section a normal user never needs to open - it renders
 * last, collapsed, after every everyday setting.
 */
function AdvancedSection(): React.JSX.Element {
  const { settings, update } = useSettings()
  return (
    <details className="settings-screen__group settings-screen__advanced">
      <summary>Advanced</summary>

      <div className="settings-screen__radio-group">
        {(['managed', 'external'] as SidecarMode[]).map((mode) => (
          <label key={mode} className="settings-screen__radio">
            <input
              type="radio"
              name="sidecar-mode"
              checked={settings.sidecar.mode === mode}
              onChange={() => void update({ sidecar: { ...settings.sidecar, mode } })}
            />
            <div>
              <span className="settings-screen__radio-title">
                {mode === 'managed' ? 'Managed (app spawns it)' : 'External (already running)'}
              </span>
            </div>
          </label>
        ))}
      </div>

      {settings.sidecar.mode === 'managed' ? (
        <>
          <label className="settings-screen__field-label" htmlFor="sidecar-command">
            Command template
          </label>
          <div className="settings-screen__inline-input">
            <input
              id="sidecar-command"
              type="text"
              value={settings.sidecar.managedCommand}
              onChange={(e) =>
                void update({
                  sidecar: { ...settings.sidecar, managedCommand: e.target.value }
                })
              }
            />
            {/* Escape hatch for a stale/hand-edited command pointing at a
                path that no longer exists (e.g. after a rename/upgrade
                moved the venv) - see sidecar.ts's isMissingManagedBinary. */}
            <button
              type="button"
              onClick={() =>
                void update({
                  sidecar: { ...settings.sidecar, managedCommand: DEFAULT_MANAGED_COMMAND }
                })
              }
            >
              Reset to default
            </button>
          </div>
          <label className="settings-screen__field-label" htmlFor="sidecar-port">
            Port
          </label>
          <div className="settings-screen__inline-input">
            <input
              id="sidecar-port"
              type="number"
              min={1}
              max={65535}
              value={settings.sidecar.port}
              onChange={(e) =>
                void update({
                  sidecar: { ...settings.sidecar, port: Number(e.target.value) || 9379 }
                })
              }
            />
          </div>
        </>
      ) : (
        <>
          <label className="settings-screen__field-label" htmlFor="sidecar-url">
            Server URL
          </label>
          <div className="settings-screen__inline-input">
            <input
              id="sidecar-url"
              type="text"
              placeholder="http://127.0.0.1:9379"
              value={settings.sidecar.externalUrl}
              onChange={(e) =>
                void update({
                  sidecar: { ...settings.sidecar, externalUrl: e.target.value }
                })
              }
            />
          </div>
        </>
      )}

      <button
        type="button"
        className="settings-screen__logs-link"
        onClick={() => void window.api.log.openFolder()}
      >
        Open logs folder
      </button>
    </details>
  )
}

export function SettingsScreen(): React.JSX.Element {
  const { settings, update, addVocabularyWord, removeVocabularyWord, updateHotkey } = useSettings()
  const models = useModelManager()
  const backendStatus = useBackendStatus()
  const hardware = useHardwareInfo()
  const inputDevices = useAudioInputDevices()
  const [vocabInput, setVocabInput] = useState('')
  const [hotkeyInput, setHotkeyInput] = useState(settings.hotkey)
  const [hotkeyStatus, setHotkeyStatus] = useState<HotkeyStatus>('idle')
  const [pttStatus, setPttStatus] = useState<PushToTalkStatus | null>(null)
  // Synchronous and always available (unlike pttStatus, which is loaded
  // asynchronously and is null on first render) - used for platform-specific
  // copy that must already be correct on the very first paint.
  const platform = window.electron.process.platform

  useEffect(() => {
    let cancelled = false
    window.api.pushToTalk.getStatus().then((status) => {
      if (!cancelled) setPttStatus(status)
    })
    return () => {
      cancelled = true
    }
  }, [])

  // Keep the hotkey field in sync with settings loaded/changed elsewhere,
  // without a setState-in-effect: adjust during render (React's recommended
  // pattern for "reset state when a prop changes"), tracked via this ref.
  const [syncedHotkey, setSyncedHotkey] = useState(settings.hotkey)
  if (settings.hotkey !== syncedHotkey) {
    setSyncedHotkey(settings.hotkey)
    setHotkeyInput(settings.hotkey)
  }

  const addWord = (): void => {
    const word = vocabInput.trim()
    if (!word) return
    void addVocabularyWord(word)
    setVocabInput('')
  }

  const saveHotkey = async (): Promise<void> => {
    const result = await updateHotkey(hotkeyInput.trim())
    setHotkeyStatus(result.ok ? 'saved' : 'error')
    setTimeout(() => setHotkeyStatus('idle'), 2500)
  }

  /**
   * Raises the macOS Accessibility system prompt and re-arms push-to-talk
   * if the user grants it - see window.api.pushToTalk.requestAccessibility
   * and PushToTalkController.recheckAccessibility. Refreshes the whole
   * status object (not just the one field) since granting the permission
   * can also start the hook in the same round trip.
   */
  const requestAccessibility = async (): Promise<void> => {
    const status = await window.api.pushToTalk.requestAccessibility()
    setPttStatus(status)
  }

  return (
    <section className="settings-screen">
      <h1>Settings</h1>

      <div className="settings-screen__group">
        <h2>Model</h2>
        {/*
          First run. Setup finishes, the app opens, and nothing has told the
          user that a model download is still required - they are left to
          infer it from a backend error and find their own way here. Blurt
          cannot transcribe a word until this is done, so it is worth saying
          plainly, once, and only while it is actually true.
        */}
        {models.installed.length === 0 && (
          <p className="settings-screen__hint settings-screen__hint--callout">
            Blurt needs a model before it can transcribe anything. Pick one below and press
            Download. E2B is the smallest and fastest, and a good place to start.
          </p>
        )}
        <div className="settings-screen__radio-group">
          {MODEL_OPTIONS.map((opt) => (
            <ModelRow
              key={opt.id}
              option={opt}
              selected={settings.modelId === opt.id}
              onSelect={() => void update({ modelId: opt.id })}
              models={models}
              hardware={hardware}
            />
          ))}
        </div>
      </div>

      {/*
        Read-only on purpose: there is nothing to choose (see Accelerator in
        shared/types.ts). This shows only what the running engine reported,
        and shows nothing at all while it isn't running - never a guess from
        a setting.
      */}
      {backendStatus.effectiveAccelerator && (
        <div className="settings-screen__group">
          {/*
            Plain markup, not a toggle-row: there is no control here to
            label. This used to be a <label> wrapping nothing, with a <p>
            nested inside a <span> - which is invalid (a <span> holds
            phrasing content, a <p> is flow content).
          */}
          <div className="settings-screen__engine">
            <strong>
              Running on {backendStatus.effectiveAccelerator === 'gpu' ? 'GPU' : 'CPU'}
            </strong>
            {/*
              Says what was observed, not why. "No usable GPU on this
              machine" was a stronger claim than anything here can support:
              a CPU result also happens when a GPU sidecar starts and then
              dies, and Sidecar retries once with LITERT_LM_SERVE_BACKEND=cpu
              (see canRetryGpuFallbackOnCpu). On a machine with a perfectly
              good GPU that failed once, the old wording told the user their
              hardware was the problem.
            */}
            {backendStatus.effectiveAccelerator === 'cpu' && (
              <p className="settings-screen__hint">
                The GPU was not used for this session. Restarting Blurt will try it again.
              </p>
            )}
          </div>
        </div>
      )}

      <div className="settings-screen__group">
        <h2>Microphone</h2>
        <select
          className="settings-screen__select"
          value={settings.inputDeviceId}
          onChange={(e) => void update({ inputDeviceId: e.target.value })}
        >
          <option value="">System default</option>
          {inputDevices.map((device) => (
            <option key={device.deviceId} value={device.deviceId}>
              {device.label}
            </option>
          ))}
          {/* A pinned microphone that is not plugged in right now has no
              entry to match, and a select with no matching option renders
              blank - which reads as "nothing chosen" rather than "your
              choice is unavailable". */}
          {settings.inputDeviceId &&
            !inputDevices.some((d) => d.deviceId === settings.inputDeviceId) && (
              <option value={settings.inputDeviceId}>Selected microphone (not connected)</option>
            )}
        </select>
      </div>

      {/*
        One group rather than two: "Processing" was a whole section wrapping
        a single toggle, and "cleanup" is this codebase's internal name for
        the post-transcription rewrite - not a word the UI uses anywhere the
        user can see.
      */}
      <div className="settings-screen__group">
        <h2>Dictation</h2>
        <SettingRow
          label="Copy result automatically"
          checked={settings.autoCopyOnCleanup}
          onChange={(checked) => void update({ autoCopyOnCleanup: checked })}
        />

        <p className="settings-screen__field-label">Custom vocabulary</p>
        <p className="settings-screen__hint">Names and jargon to bias the recognizer towards.</p>
        <div className="settings-screen__inline-input">
          <input
            type="text"
            value={vocabInput}
            placeholder="Add a word…"
            onChange={(e) => setVocabInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') addWord()
            }}
          />
          <button type="button" onClick={addWord}>
            Add
          </button>
        </div>
        <ul className="settings-screen__vocab-list">
          {settings.customVocabulary.map((word) => (
            <li key={word}>
              <span>{word}</span>
              <button
                type="button"
                onClick={() => void removeVocabularyWord(word)}
                aria-label={`Remove ${word}`}
              >
                ×
              </button>
            </li>
          ))}
          {settings.customVocabulary.length === 0 && (
            <li className="settings-screen__vocab-empty">No custom words yet.</li>
          )}
        </ul>
      </div>

      <div className="settings-screen__group">
        <h2>Push to talk</h2>
        <p className="settings-screen__hint">Hold a key anywhere to dictate.</p>

        {pttStatus && !pttStatus.available && (
          <p className="settings-screen__status settings-screen__status--error">
            Not available on this machine: {pttStatus.reason ?? 'unknown error'}.
          </p>
        )}
        {pttStatus?.isWSL && (
          <p className="settings-screen__hint">
            Under WSL, push-to-talk only sees WSLg-focused windows, not native Windows apps.
          </p>
        )}
        {pttStatus?.platform === 'linux' && pttStatus.xdotoolAvailable === false && (
          <p className="settings-screen__hint">
            <code>xdotool</code> not found - auto-paste will fail (text still lands on your
            clipboard).
          </p>
        )}
        {pttStatus?.platform === 'darwin' && pttStatus.accessibilityGranted === false && (
          <p className="settings-screen__hint">
            macOS blocks push-to-talk until Accessibility access is granted.{' '}
            <button type="button" onClick={() => void requestAccessibility()}>
              Open System Settings
            </button>
          </p>
        )}

        <SettingRow
          label="Enable push to talk"
          checked={settings.pushToTalk.enabled}
          onChange={(checked) =>
            void update({ pushToTalk: { ...settings.pushToTalk, enabled: checked } })
          }
        />

        <p className="settings-screen__field-label">Key</p>
        <div className="settings-screen__radio-group">
          {PTT_KEY_OPTIONS.map((keyId) => (
            <label key={keyId} className="settings-screen__radio">
              <input
                type="radio"
                name="ptt-key"
                checked={settings.pushToTalk.key === keyId}
                onChange={() => void update({ pushToTalk: { ...settings.pushToTalk, key: keyId } })}
              />
              <div>
                <span className="settings-screen__radio-title">{pttKeyLabel(keyId, platform)}</span>
                {/* The consequence, not the mechanism - someone picking a
                    hotkey needs to know this key can cost them focus, not
                    why Windows does it. */}
                {keyId === 'AltRight' && pttStatus?.platform === 'win32' && (
                  <span className="settings-screen__radio-desc">
                    Windows may move focus away when Alt is tapped on its own.
                  </span>
                )}
              </div>
            </label>
          ))}
        </div>

        <SettingRow
          label="Auto-paste"
          checked={settings.pushToTalk.autoPaste}
          onChange={(checked) =>
            void update({ pushToTalk: { ...settings.pushToTalk, autoPaste: checked } })
          }
        />

        <SettingRow
          label="End with a space"
          checked={settings.pushToTalk.trailingSpace}
          onChange={(checked) =>
            void update({ pushToTalk: { ...settings.pushToTalk, trailingSpace: checked } })
          }
        />
      </div>

      <div className="settings-screen__group">
        <h2>Background</h2>
        {/* The toggle below already says it keeps running - this only needs
            to add what that buys you, and how to actually quit. */}
        <p className="settings-screen__hint">
          {platform === 'darwin'
            ? 'Push to talk keeps working. Quit from the menu bar icon.'
            : 'Push to talk keeps working. Quit from the tray icon.'}
        </p>
        <SettingRow
          label="Keep running when closed"
          checked={settings.runInBackground}
          onChange={(checked) => void update({ runInBackground: checked })}
        />
      </div>

      <div className="settings-screen__group">
        <h2>Global hotkey</h2>
        <div className="settings-screen__inline-input">
          <input
            type="text"
            value={hotkeyInput}
            placeholder={platform === 'darwin' ? 'e.g. Cmd+Shift+Space' : 'e.g. Ctrl+Shift+Space'}
            onChange={(e) => setHotkeyInput(e.target.value)}
          />
          <button type="button" onClick={() => void saveHotkey()}>
            Save
          </button>
        </div>
        {hotkeyStatus === 'saved' && (
          <p className="settings-screen__status settings-screen__status--ok">Saved.</p>
        )}
        {hotkeyStatus === 'error' && (
          <p className="settings-screen__status settings-screen__status--error">
            Could not register - it may already be in use.
          </p>
        )}
      </div>
      <AdvancedSection />
    </section>
  )
}
