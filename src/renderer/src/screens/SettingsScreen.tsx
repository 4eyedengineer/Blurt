import { useState } from 'react'
import type { ModelId, SidecarMode } from '@shared/types'
import type { ModelDownloadState } from '@shared/models'
import { getCatalogEntry } from '@shared/models'
import { useSettings } from '../context/SettingsContext'
import { useModelManager } from '../hooks/useModelManager'
import { Toggle } from '../components/Toggle'
import { formatBytes } from '../lib/format'
import './SettingsScreen.css'

const MODEL_OPTIONS: Array<{ id: ModelId; label: string; desc: string }> = [
  {
    id: 'gemma-4-e2b',
    label: 'Gemma 4 E2B',
    desc: 'Fastest, smallest footprint. Best for quick notes.'
  },
  {
    id: 'gemma-4-e4b',
    label: 'Gemma 4 E4B',
    desc: 'Balanced accuracy and speed. Recommended default.'
  },
  { id: 'gemma-4-12b', label: 'Gemma 4 12B', desc: 'Highest accuracy, more resource-intensive.' }
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
      return 'Registering with litert-lm…'
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
          <span className="settings-screen__radio-desc">{option.desc}</span>
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

export function SettingsScreen(): React.JSX.Element {
  const { settings, update, addVocabularyWord, removeVocabularyWord, updateHotkey } = useSettings()
  const models = useModelManager()
  const [vocabInput, setVocabInput] = useState('')
  const [hotkeyInput, setHotkeyInput] = useState(settings.hotkey)
  const [hotkeyStatus, setHotkeyStatus] = useState<HotkeyStatus>('idle')

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
        <p className="settings-screen__hint">
          Mock replays canned demo transcripts and rule-based text ops - no download required.
          LiteRT-LM runs a real on-device Gemma model via a local sidecar process.
        </p>
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
              <span className="settings-screen__radio-desc">
                Demo mode - no model, no download, works everywhere.
              </span>
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
              <span className="settings-screen__radio-desc">
                Real on-device Gemma model. Requires downloading a model below and a working
                litert-lm sidecar.
              </span>
            </div>
          </label>
        </div>
      </div>

      <div className="settings-screen__group">
        <h2>Model</h2>
        <p className="settings-screen__hint">
          Which Gemma model to use. Downloads are ungated (no HuggingFace account/token needed) and
          stored under the app&apos;s local data folder.
        </p>
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
        <div className="settings-screen__group">
          <h2>Sidecar</h2>
          <p className="settings-screen__hint">
            How the app talks to litert-lm. &quot;Managed&quot; spawns the process itself using the
            command below (<code>{'{port}'}</code> is substituted; <code>{'{modelPath}'}</code> is
            also available for custom wrapper scripts, though the stock <code>litert-lm serve</code>{' '}
            takes no model flag - the model is selected per-request by its imported alias);
            &quot;External&quot; connects to a litert-lm server you already have running.
          </p>
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
                Managed command template
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
        </div>
      )}

      <div className="settings-screen__group">
        <h2>Processing</h2>
        <label className="settings-screen__toggle-row">
          <span>
            <strong>Offline / Cloud</strong>
            <p className="settings-screen__hint">
              Run entirely on-device, or allow cloud fallback (placeholder).
            </p>
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
            <p className="settings-screen__hint">
              Automatically copy the cleaned transcript to your clipboard.
            </p>
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
        <p className="settings-screen__hint">
          Words and names the recognizer should bias towards (product names, jargon, people).
        </p>
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
        <h2>Global hotkey</h2>
        <p className="settings-screen__hint">
          Toggles recording from anywhere in Windows and brings Eloquent to the front.
        </p>
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
          <p className="settings-screen__status settings-screen__status--ok">Hotkey registered.</p>
        )}
        {hotkeyStatus === 'error' && (
          <p className="settings-screen__status settings-screen__status--error">
            Could not register that hotkey - it may already be in use by another app.
          </p>
        )}
      </div>
    </section>
  )
}
