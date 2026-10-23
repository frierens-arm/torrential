import { Box, Text } from 'ink'
import { THEME } from '../../constants.js'
import { themeList, themeId } from '../../themes.js'

/**
 * Skin picker rendered under the search bar when the user types /theme or
 * /skin. Every row previews with ITS OWN palette (not the active one), so
 * the list doubles as a color chart — hermes-agent style.
 *
 * v1.3.1: the list is fully interactive — ↑/↓ or j/k move the cursor,
 * ⏎ applies + saves the highlighted skin, esc/q closes it.
 */
export function ThemeList({ cursor = 0 }: { cursor?: number }): React.ReactElement {
  const active = themeId()
  const rows = themeList()
  const safeCursor = Math.max(0, Math.min(cursor, rows.length - 1))

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={THEME.border}
      paddingX={2}
      paddingY={1}
      marginTop={1}
    >
      <Box marginBottom={1}>
        <Text bold color={THEME.violet}>
          skins{' '}
          <Text dimColor>— </Text>
          <Text color={THEME.cyan}>↑↓</Text>
          <Text dimColor> or </Text>
          <Text color={THEME.cyan}>j/k</Text>
          <Text dimColor> move · </Text>
          <Text color={THEME.cyan}>⏎</Text>
          <Text dimColor> apply + save · </Text>
          <Text color={THEME.cyan}>esc</Text>
          <Text dimColor> close · or </Text>
          <Text color={THEME.cyan}>/theme &lt;name&gt;</Text>
        </Text>
      </Box>

      {rows.map((t, i) => {
        const isActive = t.id === active
        const isCursor = i === safeCursor
        const rowBg = isCursor ? THEME.selBg : undefined
        return (
          <Box key={t.id} gap={2}>
            <Box width={12}>
              <Text
                bold={isActive || isCursor}
                color={isCursor ? THEME.cyan : isActive ? THEME.violet : undefined}
                backgroundColor={rowBg}
              >
                {isCursor ? '▸ ' : '  '}
                {t.id}
              </Text>
            </Box>
            <Box>
              {t.spec.gradient.map((color, gi) => (
                <Text key={gi} backgroundColor={color}>
                  {'  '}
                </Text>
              ))}
              <Text backgroundColor={t.spec.selBg}>{'  '}</Text>
              <Text backgroundColor={t.spec.green}>{'  '}</Text>
              <Text backgroundColor={t.spec.yellow}>{'  '}</Text>
              <Text backgroundColor={t.spec.red}>{'  '}</Text>
            </Box>
            <Box>
              <Text dimColor>{t.description}</Text>
              {isActive && (
                <Text color={THEME.green} bold>
                  {' '}
                  ● active
                </Text>
              )}
            </Box>
          </Box>
        )
      })}
    </Box>
  )
}
