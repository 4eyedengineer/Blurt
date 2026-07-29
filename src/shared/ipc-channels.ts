/**
 * Centralized IPC channel names shared between the preload script (which
 * exposes them via contextBridge) and the main process handlers. Keeping
 * these in one place avoids channel-name typos across the process boundary.
 */
export const IPC = {
  backend: {
    startSession: 'backend:start-session',
    pushAudio: 'backend:push-audio',
    endSession: 'backend:end-session',
    cleanup: 'backend:cleanup',
    transform: 'backend:transform',
    voiceEdit: 'backend:voice-edit',
    partialTranscript: 'backend:partial-transcript' // main -> renderer event
  },
  history: {
    list: 'history:list',
    search: 'history:search',
    save: 'history:save',
    remove: 'history:remove',
    get: 'history:get'
  },
  settings: {
    get: 'settings:get',
    update: 'settings:update',
    addVocabularyWord: 'settings:vocabulary-add',
    removeVocabularyWord: 'settings:vocabulary-remove',
    updateHotkey: 'settings:hotkey-update'
  },
  hotkey: {
    toggleRecording: 'hotkey:toggle-recording' // main -> renderer event
  }
} as const
