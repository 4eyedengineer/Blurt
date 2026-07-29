import { useState } from 'react'
import type { ModelId } from '@shared/types'
import { useSettings } from '../context/SettingsContext'
import { Toggle } from '../components/Toggle'
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

export function SettingsScreen(): React.JSX.Element {
  const { settings, update, addVocabularyWord, removeVocabularyWord, updateHotkey } = useSettings()
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
        <h2>Model</h2>
        <p className="settings-screen__hint">
          Placeholder selection - the on-device LiteRT-LM/Gemma backend reads this value once wired
          in.
        </p>
        <div className="settings-screen__radio-group">
          {MODEL_OPTIONS.map((opt) => (
            <label key={opt.id} className="settings-screen__radio">
              <input
                type="radio"
                name="model"
                checked={settings.modelId === opt.id}
                onChange={() => void update({ modelId: opt.id })}
              />
              <div>
                <span className="settings-screen__radio-title">{opt.label}</span>
                <span className="settings-screen__radio-desc">{opt.desc}</span>
              </div>
            </label>
          ))}
        </div>
      </div>

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
