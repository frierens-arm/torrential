import { useState } from 'react'
import { Box, Text } from 'ink'
import { useInput } from 'ink'
import { Logo, Tagline } from '../components/Logo.js'
import { TextInput } from '../components/TextInput.js'
import { ThemeList } from '../components/ThemeList.js'
import { THEME } from '../../constants.js'
import { parseSlashCommand } from '../../utils/commands.js'
import { themeList, themeId } from '../../themes.js'
import { useTerminalSize } from '../hooks.js'

export interface SearchScreenProps {
  initialQuery: string
  onSubmit: (text: string) => void
  warnings: string[]
  /** "saved → …" line shown after a --keep teardown. */
  keepNote?: string | null
  /** Feedback from a slash command (/theme, /mode, or unknown). */
  themeNote?: { kind: 'ok' | 'err' | 'info'; text: string } | null
  /** /theme with no argument → show the skin picker under the prompt. */
  showThemeList?: boolean
  /** v1.3.1: highlighted row in the skin picker (index into themeList()). */
  themeCursor?: number
  /** v1.3.1: cursor moved while the picker is open. */
  onThemeCursor?: (index: number) => void
  /** v1.3.1: ⏎ in the picker — apply + save the highlighted skin. */
  onThemePick?: (id: string) => void
  /** v1.3.1: esc/q while the picker is open — close it. */
  onThemeClose?: () => void
}

/**
 * The dive-in screen: wordmark, tagline, one prompt.
 * Accepts a plain query, a pasted magnet, a bare info-hash, or a
 * slash command (/theme · /theme <name> · /skin list · /mode <auto|tv|movies>).
 *
 * v1.3.1: while the skin picker is open it owns the keyboard — ↑/↓ or j/k
 * move the highlight, ⏎ applies + saves, esc/q dismisses.
 */
export function SearchScreen({
  initialQuery,
  onSubmit,
  warnings,
  keepNote,
  themeNote,
  showThemeList,
  themeCursor = 0,
  onThemeCursor,
  onThemePick,
  onThemeClose
}: SearchScreenProps): React.ReactElement {
  const { width, height } = useTerminalSize()
  const [value, setValue] = useState(initialQuery)
  const rows = themeList()
  const last = rows.length - 1

  useInput((input, key) => {
    if (!showThemeList) return
    const move = (next: number): void => {
      const clamped = Math.max(0, Math.min(last, next))
      if (clamped !== themeCursor) onThemeCursor?.(clamped)
    }
    if (key.upArrow || input === 'k') {
      move(themeCursor - 1)
      return
    }
    if (key.downArrow || input === 'j') {
      move(themeCursor + 1)
      return
    }
    if (input === 'g') {
      move(0)
      return
    }
    if (input === 'G') {
      move(last)
      return
    }
    if (key.return) {
      const entry = rows[Math.max(0, Math.min(last, themeCursor))]
      if (entry) onThemePick?.(entry.id)
      return
    }
    if (key.escape || input === 'q') {
      onThemeClose?.()
      return
    }
  })

  const handleSubmit = (text: string): void => {
    const trimmed = text.trim()
    // A handled slash command (/theme, /mode — with or without arg) resets
    // the bar so the picker or the confirmation note starts from a clean
    // slate; unknown commands keep the text so the typo stays editable.
    const cmd = trimmed.length > 0 ? parseSlashCommand(trimmed) : null
    if (cmd?.kind === 'theme' || cmd?.kind === 'mode') setValue('')
    onSubmit(text)
  }

  const verticalPad = Math.max(1, Math.floor((height - 18) / 3))

  return (
    <Box flexDirection="column" alignItems="center" width={width} paddingTop={verticalPad}>
      <Logo width={width} />
      <Box marginTop={1}>
        <Tagline />
      </Box>

      <Box marginTop={2}>
        <TextInput
          value={value}
          onChange={setValue}
          onSubmit={handleSubmit}
          placeholder="what show are we watching?"
          prompt="❯ "
          inputEnabled={!showThemeList}
        />
      </Box>

      <Box marginTop={2} flexDirection="row">
        <Text dimColor>type a </Text>
        <Text color={THEME.violet}>show</Text>
        <Text dimColor> · paste a </Text>
        <Text color={THEME.violet}>magnet</Text>
        <Text dimColor> · </Text>
        <Text color={THEME.violet}>/theme</Text>
        <Text dimColor> skins · </Text>
        <Text color={THEME.violet}>/mode</Text>
        <Text dimColor> tv/movies · ⏎ dive · ctrl+c surface</Text>
      </Box>

      <Box marginTop={1}>
        <Text dimColor color={THEME.subtle}>
          series → seasons → episodes · sources: apibay.org · 1337x.to · nyaa.si
        </Text>
      </Box>

      {themeNote && (
        <Box marginTop={2}>
          <Text
            color={themeNote.kind === 'ok' ? THEME.green : themeNote.kind === 'err' ? THEME.red : THEME.cyan}
          >
            {themeNote.kind === 'err' ? '✗' : '✓'} {themeNote.text}
          </Text>
        </Box>
      )}

      {showThemeList && (
        <Box width={Math.min(width - 2, 88)} justifyContent="center">
          <ThemeList cursor={themeCursor} />
        </Box>
      )}

      {warnings.length > 0 && (
        <Box marginTop={2} flexDirection="column" width={Math.min(width - 4, 64)}>
          {warnings.slice(0, 3).map((warning, i) => (
            <Text key={i} color={THEME.yellow}>
              ⚠ {warning}
            </Text>
          ))}
        </Box>
      )}

      {keepNote && (
        <Box marginTop={2}>
          <Text color={THEME.green}>✓ {keepNote}</Text>
        </Box>
      )}
    </Box>
  )
}
