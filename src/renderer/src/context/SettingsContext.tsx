import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { DEFAULT_SETTINGS, type Settings } from '@shared/types'

interface SettingsContextValue {
  settings: Settings
  loading: boolean
  update: (patch: Partial<Settings>) => Promise<void>
  addVocabularyWord: (word: string) => Promise<void>
  removeVocabularyWord: (word: string) => Promise<void>
  updateHotkey: (accelerator: string) => Promise<{ ok: boolean }>
}

const SettingsContext = createContext<SettingsContextValue | null>(null)

export function SettingsProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    window.api.settings.get().then((loaded) => {
      if (!cancelled) {
        setSettings(loaded)
        setLoading(false)
      }
    })
    return () => {
      cancelled = true
    }
  }, [])

  const update = useCallback(async (patch: Partial<Settings>) => {
    const next = await window.api.settings.update(patch)
    setSettings(next)
  }, [])

  const addVocabularyWord = useCallback(async (word: string) => {
    const next = await window.api.settings.addVocabularyWord(word)
    setSettings(next)
  }, [])

  const removeVocabularyWord = useCallback(async (word: string) => {
    const next = await window.api.settings.removeVocabularyWord(word)
    setSettings(next)
  }, [])

  const updateHotkey = useCallback(async (accelerator: string) => {
    const result = await window.api.settings.updateHotkey(accelerator)
    if (result.ok) {
      setSettings((prev) => ({ ...prev, hotkey: accelerator }))
    }
    return result
  }, [])

  const value = useMemo<SettingsContextValue>(
    () => ({ settings, loading, update, addVocabularyWord, removeVocabularyWord, updateHotkey }),
    [settings, loading, update, addVocabularyWord, removeVocabularyWord, updateHotkey]
  )

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components -- hook is intentionally colocated with its provider
export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext)
  if (!ctx) throw new Error('useSettings must be used within a SettingsProvider')
  return ctx
}
