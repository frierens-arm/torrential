import { Text } from 'ink'
import { SPINNER_FRAMES } from '../../utils/ascii.js'
import { getTheme } from '../../themes.js'
import { useTick } from '../hooks.js'

/** Braille spinner, torlink-fluid. Color resolves at render so skins apply live. */
export function Spinner({ color }: { color?: string }): React.ReactElement {
  const tick = useTick(80)
  return <Text color={color ?? getTheme().violet}>{SPINNER_FRAMES[tick % SPINNER_FRAMES.length]}</Text>
}
