import { Box, Text } from 'ink'
import { BAR_EMPTY, BAR_FILLED, BAR_SHEEN, gradientOf } from '../../utils/ascii.js'
import { THEME } from '../../constants.js'
import { useTick } from '../hooks.js'

/**
 * The signature progress bar: a violet→cyan gradient with a bright sheen
 * sweeping through the filled region while the stream is active —
 * torlink's "progress-bar sheen", recreated.
 *
 * v1.3.1: the gradient follows the ACTIVE skin (was hardcoded rain) and is
 * recomputed per render — cheap (≈44 lerps) and always current after /theme.
 */
export function ProgressBar({
  progress,
  width = 44,
  active = true
}: {
  progress: number
  width?: number
  active?: boolean
}): React.ReactElement {
  const tick = useTick(110, active)
  const colors = gradientOf(THEME.violet, THEME.cyan, Math.max(2, width))

  const clamped = Math.max(0, Math.min(1, progress))
  const filled = Math.round(clamped * width)
  const sheen = tick % Math.max(1, width)

  const cells: React.ReactElement[] = []
  for (let i = 0; i < width; i++) {
    if (i < filled) {
      const isSheen = active && i === sheen
      cells.push(
        <Text key={i} color={isSheen ? '#f5f3ff' : colors[i]}>
          {isSheen ? BAR_SHEEN : BAR_FILLED}
        </Text>
      )
    } else {
      cells.push(
        <Text key={i} color={THEME.barEmpty}>
          {BAR_EMPTY}
        </Text>
      )
    }
  }
  return <Box>{cells}</Box>
}
