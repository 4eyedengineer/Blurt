import type { DictationEntry } from '@shared/types'

/**
 * Whether this entry has a saved cleaned original that differs from what is
 * currently shown, i.e. there is actually something for a revert button to
 * restore. False for a plain dictation that was never transformed or voice-
 * edited (displayText already equals cleanedText), and false for a legacy/
 * malformed entry with no cleaned text at all - reverting to an empty string
 * would blank the row rather than restore anything.
 *
 * Kept in its own module rather than HistoryScreen.tsx - same reasoning as
 * `canStartGlobalHook` in main/pushToTalk/pushToTalkController.ts and
 * `pttKeyLabel` in shared/types.ts: a standalone pure function is
 * unit-testable with no rendering involved (see historyEntry.test.ts). It
 * also keeps HistoryScreen.tsx a component-only module for react-refresh,
 * and - unlike HistoryScreen.tsx - has no runtime import chain that reaches
 * outside this test runner's configured aliases (only a type-only import
 * of DictationEntry, which is erased entirely).
 */
export function canRevertToCleaned(
  entry: Pick<DictationEntry, 'displayText' | 'cleanedText'>
): boolean {
  return entry.cleanedText !== '' && entry.displayText !== entry.cleanedText
}
