import { useCallback, useState } from 'react'
import type { SearchMode } from '../../types.js'
import { setTheme, normalizeThemeName, themeId, themeList } from '../../themes.js'
import { loadConfig, saveConfig, normalizeModeName } from '../../config.js'
import { MODE_IDS } from '../../constants.js'
import { log } from '../../utils/log.js'

export type NoteKind = 'ok' | 'err' | 'info'

export interface Note {
  kind: NoteKind
  text: string
}

export interface UsePreferencesResult {
  /** Session content mode, live so /mode applies without a restart. */
  mode: SearchMode
  /** Feedback line under the search prompt (/theme, /mode, errors). */
  note: Note | null
  setNote: (note: Note | null) => void
  showThemeList: boolean
  themeCursor: number
  setThemeCursor: (index: number) => void
  applyThemeById: (id: string) => void
  applyThemeCommand: (arg: string | undefined) => void
  closeThemeList: () => void
  applyModeById: (id: SearchMode) => void
  applyModeCommand: (arg: string | undefined) => void
}

/**
 * User-facing preferences that live on top of config.json: the skin picker,
 * the /theme and /mode slash commands, and the session content mode.
 *
 * Both commands reload the config from disk before writing, so a session-only
 * CLI override (--theme / --mode) is never accidentally persisted.
 */
export function usePreferences(initialMode: SearchMode, configFile?: string): UsePreferencesResult {
  const [mode, setMode] = useState<SearchMode>(initialMode)
  const [note, setNote] = useState<Note | null>(null)
  const [showThemeList, setShowThemeList] = useState(false)
  const [themeCursor, setThemeCursor] = useState(() => {
    const idx = themeList().findIndex(t => t.id === themeId())
    return idx >= 0 ? idx : 0
  })

  const closeThemeList = useCallback((): void => {
    setShowThemeList(false)
    setNote(null)
  }, [])

  const applyThemeById = useCallback(
    (id: string): void => {
      if (id === themeId()) {
        setShowThemeList(false)
        setNote({ kind: 'info', text: `skin "${id}" is already active` })
        return
      }
      setTheme(id)
      let savedNote = ''
      try {
        const fresh = loadConfig(configFile)
        saveConfig({ ...fresh.config, theme: id }, configFile)
        savedNote = ' · saved to config'
      } catch (err) {
        savedNote = ` · could not save: ${(err as Error).message}`
      }
      log('prefs:theme', { id, saved: savedNote.length === 0 })
      setShowThemeList(false)
      setNote({ kind: 'ok', text: `skin applied: ${id}${savedNote}` })
    },
    [configFile]
  )

  const applyThemeCommand = useCallback(
    (arg: string | undefined): void => {
      if (!arg) {
        // /theme with no argument → open the live picker on the active skin.
        setShowThemeList(true)
        setNote(null)
        const idx = themeList().findIndex(t => t.id === themeId())
        setThemeCursor(idx >= 0 ? idx : 0)
        return
      }
      const id = normalizeThemeName(arg)
      if (!id) {
        setShowThemeList(false)
        setNote({
          kind: 'err',
          text: `unknown skin "${arg}" — available: ${themeList().map(t => t.id).join(', ')}`
        })
        return
      }
      applyThemeById(id)
    },
    [applyThemeById]
  )

  const applyModeById = useCallback(
    (id: SearchMode): void => {
      if (id === mode) {
        setNote({ kind: 'info', text: `mode "${id}" is already active` })
        return
      }
      setMode(id)
      let savedNote = ''
      try {
        const fresh = loadConfig(configFile)
        saveConfig({ ...fresh.config, mode: id }, configFile)
        savedNote = ' · saved to config'
      } catch (err) {
        savedNote = ` · could not save: ${(err as Error).message}`
      }
      log('prefs:mode', { id, saved: savedNote.length === 0 })
      setNote({ kind: 'ok', text: `mode applied: ${id}${savedNote} (applies to the next search)` })
    },
    [configFile, mode]
  )

  const applyModeCommand = useCallback(
    (arg: string | undefined): void => {
      if (!arg) {
        setNote({
          kind: 'info',
          text: `mode: ${mode} — choices: ${MODE_IDS.join(' · ')} (usage: /mode <${MODE_IDS.join('|')}>)`
        })
        return
      }
      const id = normalizeModeName(arg)
      if (!id) {
        setNote({ kind: 'err', text: `unknown mode "${arg}" — choices: ${MODE_IDS.join(' · ')}` })
        return
      }
      applyModeById(id)
    },
    [applyModeById, mode]
  )

  return {
    mode,
    note,
    setNote,
    showThemeList,
    themeCursor,
    setThemeCursor,
    applyThemeById,
    applyThemeCommand,
    closeThemeList,
    applyModeById,
    applyModeCommand
  }
}
