import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import type { NewDictationEntry } from '../../shared/types'
import type { HistoryStore } from '../store/historyStore'

export function registerHistoryIpc(historyStore: HistoryStore): void {
  ipcMain.handle(IPC.history.list, () => historyStore.list())
  ipcMain.handle(IPC.history.search, (_event, query: string) => historyStore.search(query))
  ipcMain.handle(IPC.history.get, (_event, id: string) => historyStore.get(id))
  ipcMain.handle(IPC.history.remove, (_event, id: string) => {
    historyStore.remove(id)
  })
  ipcMain.handle(IPC.history.save, (_event, entry: NewDictationEntry & { id?: string }) =>
    historyStore.save(entry)
  )
}
