import { Box, Text } from 'ink'
import { useInput } from 'ink'
import type { ProviderStatus, SearchResult } from '../../types.js'
import { THEME } from '../../constants.js'
import { formatBytes, padEnd, padStart, qualityBadge, seedColor, truncate } from '../../utils/format.js'
import { DivePhrase, ProviderChips } from '../components/ProviderChips.js'
import { WaveLine } from '../components/WaveLine.js'
import { useTerminalSize } from '../hooks.js'

export interface MovieResultsScreenProps {
  query: string
  /** Rows the classifier tagged 'movie', best swarm first. */
  movies: SearchResult[]
  statuses: ProviderStatus[]
  selected: number
  onSelected: (index: number) => void
  onPick: (result: SearchResult) => void
  onBack: () => void
  /** "saved → …" line shown after a --keep teardown. */
  keepNote?: string | null
}

/** Column geometry — single source of truth for header and rows. */
function columnWidths(width: number): {
  title: number
  showYear: boolean
  showQuality: boolean
  showSize: boolean
  showProvider: boolean
} {
  const showYear = width >= 62
  const showQuality = width >= 76
  const showSize = width >= 90
  const showProvider = width >= 102
  const fixed =
    4 + // marker column
    1 + // breathing room
    5 + // seed
    (showYear ? 6 : 0) +
    (showQuality ? 12 : 0) +
    (showSize ? 9 : 0) +
    (showProvider ? 8 : 0)
  return { title: Math.max(16, width - 2 - fixed), showYear, showQuality, showSize, showProvider }
}

/** First year token in a release title ("Oppenheimer 2023 1080p" → "2023"). */
function releaseYear(title: string): string {
  return /\b(19\d{2}|20\d{2})\b/.exec(title)?.[1] ?? '—'
}

/**
 * Flat movie results — the auto-mode landing screen for movie queries.
 * No seasons, no episodes: one row per torrent, ⏎ opens the pre-flight
 * card and streams (multi-video torrents detour through the file picker,
 * which the engine decides — this screen stays out of it).
 */
export function MovieResultsScreen({
  query,
  movies,
  statuses,
  selected,
  onSelected,
  onPick,
  onBack,
  keepNote
}: MovieResultsScreenProps): React.ReactElement {
  const { width, height } = useTerminalSize()

  useInput((input, key) => {
    if (key.return) {
      if (movies.length > 0) onPick(movies[Math.min(selected, movies.length - 1)])
      return
    }
    if (input === 'q' || key.escape) {
      onBack()
      return
    }
    if (key.upArrow || input === 'k') {
      onSelected(Math.max(0, selected - 1))
      return
    }
    if (key.downArrow || input === 'j') {
      onSelected(Math.max(0, Math.min(movies.length - 1, selected + 1)))
      return
    }
    if (input === 'g') {
      onSelected(0)
      return
    }
    if (input === 'G') {
      onSelected(Math.max(0, movies.length - 1))
      return
    }
    if (key.pageUp) {
      onSelected(Math.max(0, selected - 10))
      return
    }
    if (key.pageDown) {
      onSelected(Math.max(0, Math.min(movies.length - 1, selected + 10)))
    }
  })

  const settling = statuses.some(s => s.state === 'running' || s.state === 'pending')
  const allFailed = statuses.length > 0 && statuses.every(s => s.state === 'error')
  const failedSources = statuses.filter(s => s.state === 'error')
  const partialFailure = !allFailed && failedSources.length > 0
  const { title: titleWidth, showYear, showQuality, showSize, showProvider } = columnWidths(width)

  // Visible row window keeps the selection centered-ish like a pager.
  const reserved = 7
  const visibleRows = Math.max(3, height - reserved)
  const first =
    movies.length <= visibleRows
      ? 0
      : Math.min(Math.max(0, selected - Math.floor(visibleRows / 2)), movies.length - visibleRows)
  const windowed = movies.slice(first, first + visibleRows)

  const header = (
    <Text dimColor bold>
      {'  # '}
      {padEnd('TITLE', titleWidth + 1)}
      {showYear ? padEnd('YEAR', 5) + ' ' : ''}
      {showQuality ? padEnd('QUALITY', 11) + ' ' : ''}
      {showSize ? padStart('SIZE', 8) + ' ' : ''}
      {padStart('SEED', 5)}
      {showProvider ? '  SOURCE' : ''}
    </Text>
  )

  return (
    <Box flexDirection="column" width={width} paddingTop={1}>
      {/* query echo */}
      <Box paddingLeft={1}>
        <Text>
          <Text color={THEME.violet} bold>
            ❯{' '}
          </Text>
          <Text bold>{`"${query}"`}</Text>
          {movies.length > 0 && (
            <Text dimColor>{`  ·  ${movies.length} movies · flat list`}</Text>
          )}
        </Text>
      </Box>

      {/* per-source status */}
      <Box paddingLeft={1} marginTop={1}>
        {allFailed && !settling ? (
          <Text color={THEME.red}>every source failed — network trouble? see hints below</Text>
        ) : (
          <ProviderChips statuses={statuses} />
        )}
      </Box>

      {/* table or waiting states */}
      <Box flexDirection="column" marginTop={1}>
        {header}
        {windowed.map((r, i) => {
          const index = first + i
          const isSelected = index === selected
          const rowBg = isSelected ? THEME.selBg : undefined
          const badge = qualityBadge(r.quality)
          return (
            <Text key={r.id} wrap="truncate-end">
              <Text backgroundColor={rowBg} color={isSelected ? THEME.cyan : 'gray'}>
                {isSelected ? '  ▸ ' : '    '}
              </Text>
              <Text backgroundColor={rowBg} color={isSelected ? '#ffffff' : undefined} bold={isSelected}>
                {padEnd(truncate(r.title, titleWidth), titleWidth + 1)}
              </Text>
              {showYear && (
                <Text backgroundColor={rowBg} color={THEME.indigo}>
                  {padEnd(releaseYear(r.title), 5) + ' '}
                </Text>
              )}
              {showQuality && (
                <Text backgroundColor={rowBg} color={THEME.violet}>
                  {padEnd(badge.length > 0 ? badge : '—', 11) + ' '}
                </Text>
              )}
              {showSize && (
                <Text backgroundColor={rowBg} dimColor>
                  {padStart(formatBytes(r.sizeBytes), 8) + ' '}
                </Text>
              )}
              <Text backgroundColor={rowBg} color={seedColor(r.seeders)}>
                {padStart(String(r.seeders), 5)}
              </Text>
              {showProvider && (
                <Text backgroundColor={rowBg} color={THEME.subtle}>
                  {'  ' + padEnd(r.provider, 8)}
                </Text>
              )}
            </Text>
          )
        })}

        {movies.length === 0 && settling && (
          <Box flexDirection="column" paddingLeft={1} marginTop={2}>
            <WaveLine width={Math.min(width - 4, 44)} />
            <Box marginTop={1}>
              <DivePhrase />
            </Box>
          </Box>
        )}

        {movies.length === 0 && !settling && !allFailed && (
          <Box flexDirection="column" paddingLeft={1} marginTop={2}>
            <Text color={THEME.cyan}>no movie sources for this query — try auto or tv mode</Text>
            <Text dimColor>
              press q to search again · /mode auto lets the classifier route this query
            </Text>
          </Box>
        )}

        {allFailed && !settling && (
          <Box flexDirection="column" paddingLeft={1} marginTop={2}>
            {statuses.map(s => (
              <Text key={s.id} color={THEME.red}>
                ✗ {s.label}: {s.error}
              </Text>
            ))}
            <Text dimColor>
              hints: check connectivity · try a VPN · some networks block trackers/scrapers
            </Text>
          </Box>
        )}
      </Box>

      {/* quiet footnote: full reasons for sources that dropped out */}
      {partialFailure && !settling && (
        <Box flexDirection="column" paddingLeft={1} marginTop={1}>
          {failedSources.map(s => (
            <Text key={s.id} color={THEME.subtle}>
              ⚠ {s.label}: {s.error}
            </Text>
          ))}
          <Text dimColor color={THEME.subtle}>
            showing results from the sources that answered — try a VPN, or drop the source (--sources tpb,nyaa)
          </Text>
        </Box>
      )}

      {/* last --keep rescue */}
      {keepNote && (
        <Box paddingLeft={1} marginTop={1}>
          <Text color={THEME.green}>✓ {keepNote}</Text>
        </Box>
      )}

      {/* footer */}
      <Box marginTop={1} paddingLeft={1}>
        <Text dimColor>
          <Text color={THEME.violet}>j/k ↑↓</Text> navigate · <Text color={THEME.violet}>⏎</Text>{' '}
          stream · <Text color={THEME.violet}>g/G</Text> top/bottom ·{' '}
          <Text color={THEME.violet}>PgUp/PgDn</Text> page · <Text color={THEME.violet}>q</Text> new
          search · <Text color={THEME.violet}>ctrl+c</Text> quit
        </Text>
      </Box>
    </Box>
  )
}
