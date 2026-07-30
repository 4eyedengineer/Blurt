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
    partialTranscript: 'backend:partial-transcript', // main -> renderer event
    sessionError: 'backend:session-error', // main -> renderer event
    getStatus: 'backend:get-status',
    statusChanged: 'backend:status-changed', // main -> renderer event
    /** main -> renderer event: incremental text for a cleanup/transform/voiceEdit call, keyed by the operationId the renderer passed in. */
    textStreamProgress: 'backend:text-stream-progress'
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
  },
  models: {
    list: 'models:list',
    download: 'models:download',
    cancelDownload: 'models:cancel-download',
    remove: 'models:remove',
    progress: 'models:progress' // main -> renderer event
  },
  pushToTalk: {
    getStatus: 'push-to-talk:get-status'
  },
  log: {
    /** renderer -> main: report a capture/other renderer-side failure to main.log. */
    rendererError: 'log:renderer-error',
    openFolder: 'log:open-folder'
  },
  /** Coordinates the push-to-talk overlay window - see src/main/overlayController.ts. */
  overlay: {
    pttStart: 'overlay:ptt-start', // main -> overlay renderer: key was pressed, start dictating
    pttStop: 'overlay:ptt-stop', // main -> overlay renderer: key was released, stop + clean up
    pttCancel: 'overlay:ptt-cancel', // main -> overlay renderer: accidental tap (<250ms), abort
    reset: 'overlay:reset', // main -> overlay renderer: auto-hide finished, go back to idle
    result: 'overlay:result', // overlay renderer -> main: cleaned text ready to copy/paste
    pasteStatus: 'overlay:paste-status' // main -> overlay renderer: clipboard/paste outcome
  }
} as const
