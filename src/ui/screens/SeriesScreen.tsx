import { Box, Text } from 'ink'
import { useInput } from 'ink'
import type { ProviderStatus } from '../../types.js'
import type { SeriesSummary } from '../../utils/tv.js'
import { seasonsLabel } from '../../utils/tv.js'
import { THEME } from '../../constants.js'
import { padEnd, padStart, seedColor, truncate } from '../../utils/format.js'
import { DivePhrase, ProviderChips } from '../components/ProviderChips.js'
import { WaveLine } from '../components/WaveLine.js'
import { useTerminalSize } from '../hooks.js'

export interface SeriesScreenProps {
  query: string
  series: SeriesSummary[]
  statuses: ProviderStatus[]
  selected: number
  onSelected: (index: number) => void
  onPick: (summary: SeriesSummary) => void
  onBack: () => void
  /** "saved → …" line shown after a --keep teardown. */
  keepNote?: string | null
}

/** Column geometry — single source of truth for header and rows. */
function columnWidths(width: number): {
  show: number
  showSeasons: boolean
  showEps: boolean
  showSources: boolean
} {
  const showSeasons = width >= 62
  const showEps = width >= 72
  const showSources = width >= 84
  const fixed =
    4 + // marker column
    1 + // breathing room
    5 + // seed
    9 + // torrents + separator
    (showSeasons ? 10 : 0) +
    (showEps ? 5 : 0) +
    (showSources ? 10 : 0)
  return { show: Math.max(16, width - 2 - fixed), showSeasons, showEps, showSources }
}

/**
 * Tier 1 — matching series, grouped from every source's rows. Rows land
 * live while the indexers answer, sorted by swarm health. ⏎ dives into
 * the season browser for the highlighted show.
 */
export function SeriesScreen({
  query,
  series,
  statuses,
  selected,
  onSelected,
  onPick,
  onBack,
  keepNote
}: SeriesScreenProps): React.ReactElement {
  const { width, height } = useTerminalSize()

  useInput((input, key) => {
    if (key.return) {
      if (series.length > 0) onPick(series[Math.min(selected, series.length - 1)])
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
      onSelected(Math.max(0, Math.min(series.length - 1, selected + 1)))
      return
    }
    if (input === 'g') {
      onSelected(0)
      return
    }
    if (input === 'G') {
      onSelected(Math.max(0, series.length - 1))
      return
    }
    if (key.pageUp) {
      onSelected(Math.max(0, selected - 10))
      return
    }
    if (key.pageDown) {
      onSelected(Math.max(0, Math.min(series.length - 1, selected + 10)))
    }
  })

  const settling = statuses.some(s => s.state === 'running' || s.state === 'pending')
  const allFailed = statuses.length > 0 && statuses.every(s => s.state === 'error')
  const failedSources = statuses.filter(s => s.state === 'error')
  const partialFailure = !allFailed && failedSources.length > 0
  const { show: showWidth, showSeasons, showEps, showSources } = columnWidths(width)

  // Visible row window keeps the selection centered-ish like a pager.
  const reserved = 7
  const visibleRows = Math.max(3, height - reserved)
  const first =
    series.length <= visibleRows
      ? 0
      : Math.min(Math.max(0, selected - Math.floor(visibleRows / 2)), series.length - visibleRows)
  const windowed = series.slice(first, first + visibleRows)

  const header = (
    <Text dimColor bold>
      {'  # '}
      {padEnd('SERIES', showWidth + 1)}
      {padStart('SEED', 5)}
      {padStart('TORRENTS', 8) + ' '}
      {showSeasons ? padEnd('SEASONS', 9) + ' ' : ''}
      {showEps ? padEnd('EPS', 4) + ' ' : ''}
      {showSources ? 'SOURCES' : ''}
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
          {series.length > 0 && (
            <Text dimColor>{`  ·  ${series.length} shows · grouped by series`}</Text>
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
        {windowed.map((s, i) => {
          const index = first + i
          const isSelected = index === selected
          const rowBg = isSelected ? THEME.selBg : undefined
          return (
            <Text key={s.key} wrap="truncate-end">
              <Text backgroundColor={rowBg} color={isSelected ? THEME.cyan : 'gray'}>
                {isSelected ? '  ▸ ' : '    '}
              </Text>
              <Text backgroundColor={rowBg} color={isSelected ? '#ffffff' : undefined} bold={isSelected}>
                {padEnd(truncate(s.show, showWidth), showWidth + 1)}
              </Text>
              <Text backgroundColor={rowBg} color={seedColor(s.bestSeeders)}>
                {padStart(String(s.bestSeeders), 5)}
              </Text>
              <Text backgroundColor={rowBg} dimColor>
                {padStart(String(s.torrentCount), 8) + ' '}
              </Text>
              {showSeasons && (
                <Text backgroundColor={rowBg} color={THEME.indigo}>
                  {padEnd(s.seasons.length > 0 ? seasonsLabel(s.seasons) : '—', 9) + ' '}
                </Text>
              )}
              {showEps && (
                <Text backgroundColor={rowBg} color={THEME.cyan}>
                  {padEnd(s.hasUnsorted ? `${s.episodeCount}+` : String(s.episodeCount), 4) + ' '}
                </Text>
              )}
              {showSources && (
                <Text backgroundColor={rowBg} color={THEME.subtle}>
                  {padEnd(s.sources.join(' '), 10)}
                </Text>
              )}
            </Text>
          )
        })}

        {series.length === 0 && settling && (
          <Box flexDirection="column" paddingLeft={1} marginTop={2}>
            <WaveLine width={Math.min(width - 4, 44)} />
            <Box marginTop={1}>
              <DivePhrase />
            </Box>
          </Box>
        )}

        {series.length === 0 && !settling && !allFailed && (
          <Box flexDirection="column" paddingLeft={1} marginTop={2}>
            <Text color={THEME.cyan}>calm waters — no episodic content matched "{query}".</Text>
            <Text dimColor>
              try fewer words, another spelling, or include an episode tag (S01E01)
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
          browse seasons · <Text color={THEME.violet}>g/G</Text> top/bottom ·{' '}
          <Text color={THEME.violet}>PgUp/PgDn</Text> page · <Text color={THEME.violet}>q</Text>{' '}
          new search · <Text color={THEME.violet}>ctrl+c</Text> quit
        </Text>
      </Box>
    </Box>
  )
}
