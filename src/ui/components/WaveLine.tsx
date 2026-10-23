import { Box, Text } from 'ink'
import { WAVE_GLYPHS } from '../../utils/ascii.js'
import { THEME } from '../../constants.js'
import { useTick } from '../hooks.js'

/**
 * A drifting water-surface line — the "loading animation" that keeps the
 * TUI alive while the swarm answers.
 * v1.3.1: wave colors follow the active skin.
 */
export function WaveLine({ width = 44 }: { width?: number }): React.ReactElement {
  const tick = useTick(130)
  const offset = tick % WAVE_GLYPHS.length
  const cells: React.ReactElement[] = []
  for (let i = 0; i < width; i++) {
    const glyph = WAVE_GLYPHS[(i + offset) % WAVE_GLYPHS.length]
    if (glyph === ' ') {
      cells.push(<Text key={i}> </Text>)
    } else if (glyph === '≈' || glyph === '~') {
      cells.push(
        <Text key={i} color={THEME.blue}>
          {glyph}
        </Text>
      )
    } else {
      cells.push(
        <Text key={i} color={THEME.subtle}>
          {glyph}
        </Text>
      )
    }
  }
  return <Box>{cells}</Box>
}
