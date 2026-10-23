import { Box, Text } from 'ink'
import { LOGO_BIG, LOGO_MED_ROWS, LOGO_SMALL, gradientOf } from '../../utils/ascii.js'
import { THEME } from '../../constants.js'
import { TAGLINE } from '../../version.js'

/**
 * The torrential wordmark — gradient follows the ACTIVE skin (v1.3.1:
 * medium & small variants used hardcoded rain colors and ignored /theme).
 * Picks the largest variant the terminal can carry.
 */
export function Logo({ width }: { width: number }): React.ReactElement {
  if (width >= 84) {
    return (
      <Box flexDirection="column">
        {LOGO_BIG.map((line, i) => (
          <Text key={i} color={THEME.gradient[Math.min(i, THEME.gradient.length - 1)]}>
            {line}
          </Text>
        ))}
      </Box>
    )
  }
  if (width >= 45) {
    const medGradient = gradientOf(THEME.violet, THEME.cyan, 10)
    return (
      <Box flexDirection="column">
        {LOGO_MED_ROWS.map((tokens, i) => (
          <Box key={i}>
            {tokens.map((token, j) => (
              <Text key={j} color={medGradient[Math.min(j, medGradient.length - 1)]}>
                {j === 0 && i === 0 ? ' ' + token : token + ' '}
              </Text>
            ))}
          </Box>
        ))}
      </Box>
    )
  }
  const smallColors = [THEME.pink, THEME.indigo, THEME.blue]
  return (
    <Box flexDirection="column">
      {LOGO_SMALL.map((line, i) => (
        <Text key={i} color={smallColors[i % smallColors.length]}>
          {line}
        </Text>
      ))}
    </Box>
  )
}

/** Tagline with a cyan pulse between the halves. */
export function Tagline(): React.ReactElement {
  const [left, right] = TAGLINE.split('·')
  return (
    <Box>
      <Text dimColor color="#a78bfa">
        {left}
      </Text>
      <Text color={THEME.cyan}>·</Text>
      <Text dimColor color="#a78bfa">
        {right}
      </Text>
    </Box>
  )
}
