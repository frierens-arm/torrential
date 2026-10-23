import { Text } from 'ink'
import type { ProviderStatus } from '../../types.js'
import { PROVIDER_COLORS, THEME, DIVE_PHRASES } from '../../constants.js'
import { shortProviderError } from '../../utils/format.js'
import { useTick } from '../hooks.js'

/** Rotating "diving" copy while sources are still answering. */
export function DivePhrase(): React.ReactElement {
  const tick = useTick(1600)
  const phrase = DIVE_PHRASES[tick % DIVE_PHRASES.length]
  return (
    <Text dimColor color={THEME.subtle}>
      {phrase}…
    </Text>
  )
}

/**
 * Per-source status chips with live spinners — shared by every screen
 * that can trigger a swarm search (series list, season, episode views).
 */
export function ProviderChips({ statuses }: { statuses: ProviderStatus[] }): React.ReactElement {
  const running = statuses.some(s => s.state === 'running')
  const tick = useTick(80, running)
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
  return (
    <Text>
      {statuses.map((s, i) => (
        <Text key={s.id}>
          {i > 0 ? '   ' : ''}
          {s.state === 'running' && (
            <Text>
              <Text color={PROVIDER_COLORS[s.id] ?? THEME.violet}>
                {frames[tick % frames.length]}
              </Text>
              <Text dimColor> {s.label}</Text>
            </Text>
          )}
          {s.state === 'done' && (
            <Text>
              <Text color={THEME.green}>✓</Text>
              <Text dimColor> {s.label} </Text>
              <Text color={THEME.green}>{s.count}</Text>
            </Text>
          )}
          {s.state === 'error' && (
            <Text>
              <Text color={THEME.red}>✗</Text>
              <Text dimColor> {s.label} </Text>
              <Text color={THEME.yellow}>{shortProviderError(s.error)}</Text>
            </Text>
          )}
          {s.state === 'pending' && <Text dimColor>· {s.label}</Text>}
        </Text>
      ))}
    </Text>
  )
}
