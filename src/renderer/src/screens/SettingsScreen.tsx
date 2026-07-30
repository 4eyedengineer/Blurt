import { useEffect, useState } from 'react'
import type { Accelerator, ModelId, PushToTalkStatus, SidecarMode } from '@shared/types'
import { MANAGED_COMMAND_BY_ACCELERATOR, PTT_KEY_OPTIONS } from '@shared/types'
import type { ModelDownloadState } from '@shared/models'
import { getCatalogEntry } from '@shared/models'
import { useSettings } from '../context/SettingsContext'
import { useModelManager } from '../hooks/useModelManager'
import { useBackendStatus } from '../hooks/useBackendStatus'
import { Toggle } from '../components/Toggle'
import { formatBytes } from '../lib/format'
import './SettingsScreen.css'

const MODEL_OPTIONS: Array<{ id: ModelId; label: string }> = [
  { id: 'gemma-4-e2b', label: 'Gemma 4 E2B — fastest' },
  { id: 'gemma-4-e4b', label: 'Gemma 4 E4B — balanced' },
  { id: 'gemma-4-12b', label: 'Gemma 4 12B — best quality, slower' }
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
}

function ModelRow({ option, selected, onSelect, models }: ModelRowProps): React.JSX.Element {
  const installed = models.installed.some((m) => m.modelId === option.id)
  const progress = models.progress[option.id]
  const approxSize = getCatalogEntry(option.id).approxSizeBytes
  const busy = progress?.state === 'downloading' || progress?.state === 'resolving'
  const pct =
    progress?.totalBytes && progress.totalBytes > 0
      ? Math.min(100, Math.round((progress.receivedBytes / progress.totalBytes) * 100))
      : null

  return (
    <label className="settings-screen__radio">
      <input type="radio" name="model" checked={selected} onChange={onSelect} />
      <div className="settings-screen__model-row">
        <div>
          <span className="settings-screen__radio-title">{option.label}</span>
          <span className="settings-screen__radio-desc">
            {modelStateLabel(progress?.state ?? 'idle')} · ~{formatBytes(approxSize)}
            {busy && pct !== null ? ` · ${pct}%` : ''}
          </span>
          {busy && (
            <div className="settings-screen__progress-track">
              <div className="settings-screen__progress-fill" style={{ width: `${pct ?? 8}%` }} />
            </div>
          )}
        </div>
        <div className="settings-screen__model-actions">
          {!installed && !busy && (
            <button
              type="button"
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
 * The Accelerator toggle's own label, per the "requested vs. actually
 * running" rule (see BackendStatus.effectiveAccelerator's doc comment):
 * reflects the requested setting, except when GPU was requested but the
 * sidecar's engine truthfully reported it fell back to CPU - that case must
 * never read as "GPU".
 */
function acceleratorLabel(requested: Accelerator, effective: Accelerator | undefined): string {
  if (requested === 'gpu' && effective === 'cpu') return 'CPU (GPU unavailable)'
  return requested === 'gpu' ? 'GPU' : 'CPU'
}

export function SettingsScreen(): React.JSX.Element {
  const { settings, update, addVocabularyWord, removeVocabularyWord, updateHotkey } = useSettings()
  const models = useModelManager()
  const backendStatus = useBackendStatus()
  const [vocabInput, setVocabInput] = useState('')
  const [hotkeyInput, setHotkeyInput] = useState(settings.hotkey)
  const [hotkeyStatus, setHotkeyStatus] = useState<HotkeyStatus>('idle')
  const [pttStatus, setPttStatus] = useState<PushToTalkStatus | null>(null)

  // Only overwrites managedCommand if it's still exactly one of the known
  // default templates (i.e. the user hasn't hand-edited it) - so flipping
  // this toggle does the right thing for the common case without silently
  // clobbering a custom command someone typed into the field below.
  const setAccelerator = (accelerator: Accelerator): void => {
    const isUnmodifiedDefault = Object.values(MANAGED_COMMAND_BY_ACCELERATOR).includes(
      settings.sidecar.managedCommand
    )
    void update({
      sidecar: {
        ...settings.sidecar,
        accelerator,
        managedCommand: isUnmodifiedDefault
          ? MANAGED_COMMAND_BY_ACCELERATOR[accelerator]
          : settings.sidecar.managedCommand
      }
    })
  }

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

  return (
    <section className="settings-screen">
      <h1>Settings</h1>

      <div className="settings-screen__group">
        <h2>Backend</h2>
        <div className="settings-screen__radio-group">
          <label className="settings-screen__radio">
            <input
              type="radio"
              name="backend"
              checked={settings.backend === 'mock'}
              onChange={() => void update({ backend: 'mock' })}
            />
            <div>
              <span className="settings-screen__radio-title">Mock</span>
              <span className="settings-screen__radio-desc">Demo data, no download.</span>
            </div>
          </label>
          <label className="settings-screen__radio">
            <input
              type="radio"
              name="backend"
              checked={settings.backend === 'litert'}
              onChange={() => void update({ backend: 'litert' })}
            />
            <div>
              <span className="settings-screen__radio-title">LiteRT-LM</span>
              <span className="settings-screen__radio-desc">Real on-device model.</span>
            </div>
          </label>
        </div>
      </div>

      <div className="settings-screen__group">
        <h2>Model</h2>
        <div className="settings-screen__radio-group">
          {MODEL_OPTIONS.map((opt) => (
            <ModelRow
              key={opt.id}
              option={opt}
              selected={settings.modelId === opt.id}
              onSelect={() => void update({ modelId: opt.id })}
              models={models}
            />
          ))}
        </div>
      </div>

      {settings.backend === 'litert' && (
        <>
          {settings.sidecar.mode === 'managed' && (
            <div className="settings-screen__group">
              <label className="settings-screen__toggle-row">
                <span>
                  <strong>
                    {acceleratorLabel(
                      settings.sidecar.accelerator,
                      backendStatus.effectiveAccelerator
                    )}
                  </strong>
                  {settings.sidecar.accelerator === 'gpu' &&
                    backendStatus.effectiveAccelerator === 'cpu' && (
                      <p className="settings-screen__hint">
                        GPU init failed on this machine - running on CPU instead.
                      </p>
                    )}
                </span>
                <Toggle
                  checked={settings.sidecar.accelerator === 'gpu'}
                  onChange={(checked) => setAccelerator(checked ? 'gpu' : 'cpu')}
                  label="Accelerator"
                />
              </label>
            </div>
          )}

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
                      {mode === 'managed'
                        ? 'Managed (app spawns it)'
                        : 'External (already running)'}
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
        </>
      )}

      <div className="settings-screen__group">
        <h2>Processing</h2>
        <label className="settings-screen__toggle-row">
          <span>
            <strong>Cloud mode</strong>
          </span>
          <Toggle
            checked={settings.mode === 'cloud'}
            onChange={(checked) => void update({ mode: checked ? 'cloud' : 'offline' })}
            label="Cloud mode"
          />
        </label>
        <label className="settings-screen__toggle-row">
          <span>
            <strong>Auto-copy on cleanup</strong>
          </span>
          <Toggle
            checked={settings.autoCopyOnCleanup}
            onChange={(checked) => void update({ autoCopyOnCleanup: checked })}
            label="Auto-copy on cleanup"
          />
        </label>
      </div>

      <div className="settings-screen__group">
        <h2>Custom vocabulary</h2>
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

        <label className="settings-screen__toggle-row">
          <span>
            <strong>Enable push to talk</strong>
          </span>
          <Toggle
            checked={settings.pushToTalk.enabled}
            onChange={(checked) =>
              void update({ pushToTalk: { ...settings.pushToTalk, enabled: checked } })
            }
            label="Enable push to talk"
          />
        </label>

        <p className="settings-screen__field-label">Key</p>
        <div className="settings-screen__radio-group">
          {PTT_KEY_OPTIONS.map((opt) => (
            <label key={opt.id} className="settings-screen__radio">
              <input
                type="radio"
                name="ptt-key"
                checked={settings.pushToTalk.key === opt.id}
                onChange={() =>
                  void update({ pushToTalk: { ...settings.pushToTalk, key: opt.id } })
                }
              />
              <div>
                <span className="settings-screen__radio-title">{opt.label}</span>
                {opt.id === 'AltRight' && (
                  <span className="settings-screen__radio-desc">
                    Also known as AltGr on some layouts.
                  </span>
                )}
              </div>
            </label>
          ))}
        </div>

        <label className="settings-screen__toggle-row">
          <span>
            <strong>Auto-paste</strong>
          </span>
          <Toggle
            checked={settings.pushToTalk.autoPaste}
            onChange={(checked) =>
              void update({ pushToTalk: { ...settings.pushToTalk, autoPaste: checked } })
            }
            label="Auto-paste"
          />
        </label>
      </div>

      <div className="settings-screen__group">
        <h2>Global hotkey</h2>
        <div className="settings-screen__inline-input">
          <input
            type="text"
            value={hotkeyInput}
            placeholder="e.g. Ctrl+Shift+Space"
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
    </section>
  )
}
