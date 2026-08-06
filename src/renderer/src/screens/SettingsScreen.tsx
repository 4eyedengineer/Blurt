import { useEffect, useRef, useState } from 'react'
import type { ModelId, PushToTalkStatus, SidecarMode } from '@shared/types'
import { DEFAULT_MANAGED_COMMAND, PTT_KEY_OPTIONS, pttKeyLabel } from '@shared/types'
import type { ModelCatalogEntry, ModelDownloadState } from '@shared/models'
import { MODEL_CATALOG } from '@shared/models'
import type { HardwareProbeResult } from '@shared/hardware'
import { checkModelRequirements, requiredDiskBytes } from '@shared/modelRequirements'
import { describeUpdateStatus } from '@shared/updater'
import { useSettings } from '../context/SettingsContext'
import { useModelManager } from '../hooks/useModelManager'
import { useBackendStatus } from '../hooks/useBackendStatus'
import { useHardwareInfo } from '../hooks/useHardwareInfo'
import { useAudioInputDevices } from '../hooks/useAudioInputDevices'
import { useUpdateStatus } from '../hooks/useUpdateStatus'
import { buildVocabularyEntries, findMisrecognitions } from '@shared/vocabulary'
import { isDictationInProgress, type DictationPhase } from '../hooks/useDictationSession'
import { Toggle } from '../components/Toggle'
import { formatBytes } from '../lib/format'
import './SettingsScreen.css'

/**
 * The one thing the model catalog does not carry: which model to pick, as
 * opposed to what each one is. That is UI guidance rather than a fact about
 * the model, so it lives here and the names themselves come from
 * `MODEL_CATALOG`.
 *
 * This screen used to hand-write the whole option list, labels included,
 * which meant two sources of truth that nothing kept in agreement. Typing
 * this as a total `Record<ModelId, string>` puts the link back: rows are
 * generated from the catalog, so adding a model there makes it appear in
 * Settings, and omitting its tagline is a compile error rather than a row
 * that silently renders without one.
 */
const MODEL_TAGLINES: Record<ModelId, string> = {
  'gemma-4-e2b': 'fastest',
  'gemma-4-e4b': 'balanced',
  'gemma-4-12b': 'best quality and slowest'
}

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
  entry: ModelCatalogEntry
  selected: boolean
  onSelect: () => void
  models: ReturnType<typeof useModelManager>
  hardware: HardwareProbeResult | null
}

function ModelRow({
  entry,
  selected,
  onSelect,
  models,
  hardware
}: ModelRowProps): React.JSX.Element {
  const installed = models.installed.some((m) => m.modelId === entry.id)
  const progress = models.progress[entry.id]
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
          <span className="settings-screen__radio-title">
            {entry.label}, {MODEL_TAGLINES[entry.id]}
          </span>
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
                models.download(entry.id)
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
                models.cancelDownload(entry.id)
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
                models.remove(entry.id)
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

export function SettingsScreen({
  dictationPhase
}: {
  dictationPhase: DictationPhase
}): React.JSX.Element {
  const { settings, update, addVocabularyWord, removeVocabularyWord, updateHotkey } = useSettings()
  const updateStatus = useUpdateStatus()
  const models = useModelManager()
  const backendStatus = useBackendStatus()
  const hardware = useHardwareInfo()
  const inputDevices = useAudioInputDevices()
  const [vocabInput, setVocabInput] = useState('')
  /** Misrecognitions the last Add pulled in from history - shown once, so the user sees what was inferred on their behalf. */
  const [vocabFound, setVocabFound] = useState<string[]>([])
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

  /**
   * Adds the spelling the user typed, plus a correction for every way the
   * recogniser has actually written it before.
   *
   * The user never types a misspelling, because they cannot know one. The
   * first version of this feature asked them to, and it failed immediately:
   * an entry of `Quin -> Qwen` did nothing for a dictation that came back
   * "quinn". History is the authority on what the recogniser writes, and the
   * app has all of it - so it looks the answer up instead of asking.
   *
   * Falls back to the plain spelling when history has nothing to offer (a
   * fresh install, or a word never dictated yet), which is the old behaviour
   * and still correct - there is simply nothing to correct yet.
   */
  const addWord = async (): Promise<void> => {
    const word = vocabInput.trim()
    if (!word) return
    setVocabInput('')

    let found: string[] = []
    try {
      const history = await window.api.history.list()
      found = findMisrecognitions(
        word,
        // Raw, not cleaned: cleanup capitalizes and reflows, and what has to
        // be matched is exactly what the recogniser emitted.
        history.map((entry) => entry.rawTranscript).filter(Boolean)
      )
    } catch {
      // A history read that fails costs the corrections, not the word - add
      // the spelling anyway rather than losing what the user typed.
    }

    for (const entry of buildVocabularyEntries(word, found)) {
      await addVocabularyWord(entry)
    }
    setVocabFound(found)
  }

  // Tracked and cleared rather than fired and forgotten: pressing Save twice
  // inside the window left two timers running, and the first one to fire
  // cleared the status belonging to the second - so the reply to the save
  // that mattered vanished early, or never appeared at all.
  const hotkeyStatusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (hotkeyStatusTimerRef.current) clearTimeout(hotkeyStatusTimerRef.current)
    },
    []
  )

  const saveHotkey = async (): Promise<void> => {
    const result = await updateHotkey(hotkeyInput.trim())
    setHotkeyStatus(result.ok ? 'saved' : 'error')
    if (hotkeyStatusTimerRef.current) clearTimeout(hotkeyStatusTimerRef.current)
    hotkeyStatusTimerRef.current = setTimeout(() => {
      setHotkeyStatus('idle')
      hotkeyStatusTimerRef.current = null
    }, 2500)
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
          {MODEL_CATALOG.map((entry) => (
            <ModelRow
              key={entry.id}
              entry={entry}
              selected={settings.modelId === entry.id}
              onSelect={() => void update({ modelId: entry.id })}
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
        {/*
          Says what these words actually do now. The old line, "Names and
          jargon to bias the recognizer towards", described the design from
          when Gemma did the transcribing and could be told what to listen
          for. The recogniser that replaced it is handed a WAV and nothing
          else, so these words never reach recognition at all.

          One field, and it takes the word you WANT - never a misspelling. A
          previous version taught the `heard -> wanted` syntax here, which
          made the user responsible for predicting a speech recogniser; the
          first real attempt at it missed, because the entry said "Quin" and
          the recogniser wrote "quinn". The syntax still works and generated
          entries are stored in it, but nothing asks anyone to type it.
        */}
        <p className="settings-screen__hint">
          Names and jargon to spell correctly. Blurt checks your history for the ways it has
          misheard each one, and fixes those too.
        </p>
        <div className="settings-screen__inline-input">
          <input
            type="text"
            value={vocabInput}
            placeholder="Add a word…"
            onChange={(e) => setVocabInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void addWord()
            }}
          />
          <button type="button" onClick={() => void addWord()}>
            Add
          </button>
        </div>
        {/*
          Shown because the app just made a decision on the user's behalf.
          Silently inventing entries would be the same "thoughtless" mistake
          in the other direction - they are all listed below and individually
          removable, and this says where they came from.
        */}
        {vocabFound.length > 0 && (
          <p className="settings-screen__hint">
            Also correcting what Blurt had written instead: {vocabFound.join(', ')}.
          </p>
        )}
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
                {/* `platform`, not `pttStatus?.platform` - see its
                    declaration. pttStatus arrives asynchronously and is null
                    on first paint, so keying this off it made the note fade
                    in a beat after the option it belongs to. */}
                {keyId === 'AltRight' && platform === 'win32' && (
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
        <h2>Updates</h2>
        {/*
          Reports only what the updater has actually observed - see
          describeUpdateStatus. There is no "check now" button: a check runs
          at startup and every few hours regardless, so the button would
          mostly be a way to re-ask a question already answered on screen.
        */}
        <p className="settings-screen__hint">{describeUpdateStatus(updateStatus)}</p>
        {updateStatus.state === 'downloading' && (
          <div className="settings-screen__progress-track">
            <div
              className="settings-screen__progress-fill"
              style={{ width: `${updateStatus.percent ?? 0}%` }}
            />
          </div>
        )}
        {updateStatus.state === 'ready' && (
          <>
            {/*
              Offered, never forced. Quitting is what applies the update
              anyway, so this is a shortcut for someone who would rather not
              wait - and it is held back mid-dictation, which is reachable
              from this screen because the global hotkey starts a dictation
              from whatever tab is open.
            */}
            <button
              type="button"
              className="settings-screen__update-action"
              disabled={isDictationInProgress(dictationPhase)}
              onClick={() => void window.api.update.restartToInstall()}
            >
              Restart now
            </button>
            {/* A visible line rather than a `title` tooltip: a disabled
                button does not fire the mouse events a tooltip needs, so the
                explanation for why it is dead has to be on the page. */}
            {isDictationInProgress(dictationPhase) && (
              <p className="settings-screen__hint">Finish the current dictation first.</p>
            )}
          </>
        )}
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
