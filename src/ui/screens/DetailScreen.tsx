import { useEffect, useState } from 'react'
import { Box, Text } from 'ink'
import { useInput } from 'ink'
import type { SearchResult, StreamTarget } from '../../types.js'
import { PROVIDER_SHORT, THEME } from '../../constants.js'
import { formatBytes, qualityBadge, seedColor } from '../../utils/format.js'
import { Spinner } from '../components/Spinner.js'
import { useTerminalSize } from '../hooks.js'

export interface DetailScreenProps {
  /** Candidate torrents for the chosen episode / pack, best first. */
  torrents: SearchResult[]
  /** Active candidate (index into torrents). */
  index: number
  onIndex: (index: number) => void
  /** TV context line: "Breaking Bad · S02E05" or "Breaking Bad · Season 2 pack". */
  contextLabel: string
  /** Which file inside the torrent the engine should stream. */
  target: StreamTarget
  /** Called with the resolved magnet when the user confirms streaming. */
  onStream: (result: SearchResult, magnet: string, target: StreamTarget) => void
  /** Supplemental smart-search indicator ("hunting S02E05…"). */
  hunting?: string | null
  onBack: () => void
}

/**
 * Pre-flight check: metadata card for one torrent, lazy magnet resolution
 * for scrapers, zero-seeder warnings, and n/p cycling through every
 * candidate the swarm offered for this episode.
 */
export function DetailScreen({
  torrents,
  index,
  onIndex,
  contextLabel,
  target,
  onStream,
  hunting,
  onBack
}: DetailScreenProps): React.ReactElement {
  const { width } = useTerminalSize()
  const result = torrents[Math.min(index, torrents.length - 1)]

  const [magnet, setMagnet] = useState<string | null>(result?.magnet ?? null)
  const [status, setStatus] = useState<'ok' | 'resolving' | 'error'>(
    result?.magnet ? 'ok' : result?.fetchMagnet ? 'resolving' : 'error'
  )
  const [error, setError] = useState<string>(
    result && (result.magnet || result.fetchMagnet) ? '' : 'no magnet available for this result'
  )

  useEffect(() => {
    if (!result) return
    setMagnet(result.magnet ?? null)
    if (result.magnet) {
      setStatus('ok')
      setError('')
      return
    }
    if (!result.fetchMagnet) {
      setStatus('error')
      setError('no magnet available for this result')
      return
    }
    let cancelled = false
    setStatus('resolving')
    setError('')
    result
      .fetchMagnet()
      .then(m => {
        if (!cancelled) {
          setMagnet(m)
          setStatus('ok')
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err))
          setStatus('error')
        }
      })
    return () => {
      cancelled = true
    }
  }, [result])

  useInput((input, key) => {
    if (key.return) {
      if (status === 'ok' && magnet && result) onStream(result, magnet, target)
      return
    }
    if (input === 'n') {
      if (index < torrents.length - 1) onIndex(index + 1)
      return
    }
    if (input === 'p') {
      if (index > 0) onIndex(index - 1)
      return
    }
    if (input === 'b' || input === 'q' || key.escape) {
      onBack()
    }
  })

  if (!result) {
    return (
      <Box flexDirection="column" paddingTop={2} paddingLeft={2} width={width}>
        <Text color={THEME.yellow}>no torrents for this pick — go back (b) and try another</Text>
      </Box>
    )
  }

  const boxWidth = Math.min(width - 4, 74)
  const inner = boxWidth - 4
  const titleLines = wrapText(result.title, Math.max(20, inner - 14)).slice(0, 3)
  const badge = qualityBadge(result.quality)
  const dead = result.seeders <= 0
  const weak = result.seeders > 0 && result.seeders < 5
  const isPack = target.kind === 'auto'

  const labelColor = THEME.subtle

  return (
    <Box flexDirection="column" paddingTop={2} paddingLeft={2} width={width}>
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={THEME.border}
        paddingX={2}
        paddingY={1}
        width={boxWidth}
      >
        {/* TV context + torrent counter */}
        <Box justifyContent="space-between">
          <Text color={THEME.cyan} bold>
            {contextLabel}
          </Text>
          {torrents.length > 1 && (
            <Text dimColor>
              torrent <Text color={THEME.violet}>{index + 1}</Text>/{torrents.length} · n/p to cycle
            </Text>
          )}
        </Box>

        <Box flexDirection="column" marginTop={1}>
          {titleLines.map((line, i) => (
            <Text key={i} bold color="#ffffff">
              {line}
            </Text>
          ))}
        </Box>

        <Text color={THEME.border}>{'─'.repeat(inner - 2)}</Text>

        <Box flexDirection="row" marginTop={1}>
          <Box flexDirection="column">
            <Box>
              <Text color={labelColor}>{padRight('source', 10)}</Text>
              <Text color={THEME.pink}>{PROVIDER_SHORT[result.provider] ?? result.provider}</Text>
            </Box>
            <Box>
              <Text color={labelColor}>{padRight('seeders', 10)}</Text>
              <Text color={seedColor(result.seeders)} bold={dead}>
                {String(result.seeders)}
              </Text>
            </Box>
            <Box>
              <Text color={labelColor}>{padRight('size', 10)}</Text>
              <Text>{formatBytes(result.sizeBytes)}</Text>
            </Box>
          </Box>
          <Box flexDirection="column" marginLeft={4}>
            <Box>
              <Text color={labelColor}>{padRight('quality', 10)}</Text>
              <Text color={THEME.indigo}>{badge.length > 0 ? badge : '—'}</Text>
            </Box>
            <Box>
              <Text color={labelColor}>{padRight('leechers', 10)}</Text>
              <Text color={THEME.subtle}>{String(result.leechers)}</Text>
            </Box>
            <Box>
              <Text color={labelColor}>{padRight('added', 10)}</Text>
              <Text>{result.uploaded ?? '—'}</Text>
            </Box>
          </Box>
        </Box>

        <Box marginTop={1}>
          <Text color={labelColor}>{padRight('covers', 10)}</Text>
          <Text color={THEME.violet}>{result.scopeLabel ?? '—'}</Text>
        </Box>
        <Box>
          <Text color={labelColor}>{padRight('streams', 10)}</Text>
          {isPack ? (
            <Text color={THEME.blue}>
              whole torrent — multi-file packs open a file picker before playback
            </Text>
          ) : target.kind === 'episode' ? (
            <Text color={THEME.blue}>
              {target.season === null
                ? `episode ${target.episode} file`
                : `S${String(target.season).padStart(2, '0')}E${String(target.episode).padStart(2, '0')} file`}
            </Text>
          ) : (
            <Text color={THEME.blue}>largest video file</Text>
          )}
        </Box>

        <Box marginTop={1}>
          <Text color={labelColor}>{padRight('magnet', 10)}</Text>
          {status === 'resolving' && (
            <>
              <Spinner color={THEME.cyan} />
              <Text dimColor> resolving from {result.provider}…</Text>
            </>
          )}
          {status === 'ok' && <Text color={THEME.green}>✓ resolved — ready to stream</Text>}
          {status === 'error' && <Text color={THEME.red}>✗ {error}</Text>}
        </Box>

        {hunting && (
          <Box marginTop={1}>
            <Text color={THEME.cyan}>⟳ {hunting}…</Text>
          </Box>
        )}

        {dead && (
          <Box marginTop={1}>
            <Text color={THEME.yellow}>
              ⚠ dead swarm — 0 seeders. Playback may never start; press n for a livelier torrent.
            </Text>
          </Box>
        )}
        {weak && !dead && (
          <Box marginTop={1}>
            <Text color={THEME.yellow}>
              ⚠ only {result.seeders} seeder{result.seeders === 1 ? '' : 's'} — expect slow startup; n may find a healthier swarm.
            </Text>
          </Box>
        )}
        {status === 'error' && (
          <Box marginTop={1}>
            <Text dimColor>press b to go back and pick another result</Text>
          </Box>
        )}
      </Box>

      <Box marginTop={1} paddingLeft={1}>
        <Text dimColor>
          <Text color={THEME.violet}>⏎</Text> stream now ·{' '}
          {torrents.length > 1 ? (
            <>
              <Text color={THEME.violet}>n/p</Text> next/prev torrent ·{' '}
            </>
          ) : null}
          <Text color={THEME.violet}>b</Text> back · <Text color={THEME.violet}>q</Text> quit to
          episodes · <Text color={THEME.violet}>ctrl+c</Text> quit
        </Text>
      </Box>
    </Box>
  )
}

function padRight(text: string, len: number): string {
  return text.length >= len ? text.slice(0, len) : text + ' '.repeat(len - text.length)
}

/** Word-wrap that never splits words. */
function wrapText(text: string, max: number): string[] {
  const words = text.split(/\s+/)
  const lines: string[] = []
  let line = ''
  for (const word of words) {
    if (line.length === 0) {
      line = word
    } else if (line.length + 1 + word.length <= max) {
      line += ' ' + word
    } else {
      lines.push(line)
      line = word
    }
  }
  if (line.length > 0) lines.push(line)
  return lines
}
