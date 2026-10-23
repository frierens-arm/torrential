import { Box, Text } from 'ink'
import { useInput } from 'ink'
import type { SeasonRef, SeasonRow } from '../../utils/tv.js'
import { THEME } from '../../constants.js'
import { formatBytes, padEnd, padStart, qualityBadge, seedColor, truncate } from '../../utils/format.js'
import { useTerminalSize } from '../hooks.js'

export interface SeasonScreenProps {
  show: string
  rows: SeasonRow[]
  /** Supplementary smart-search indicator ("hunting season packs…"). */
  hunting?: string | null
  selected: number
  onSelected: (index: number) => void
  onPick: (ref: SeasonRef) => void
  onBack: () => void
}

/**
 * Tier 2 — the season browser: every season the swarm offered for this
 * series, plus whole-series packs and the season-less (absolute
 * numbering) bucket. ⏎ dives into episodes (or the pack's torrent list).
 */
export function SeasonScreen({
  show,
  rows,
  hunting,
  selected,
  onSelected,
  onPick,
  onBack
}: SeasonScreenProps): React.ReactElement {
  const { width, height } = useTerminalSize()

  useInput((input, key) => {
    if (key.return) {
      const row = rows[Math.min(selected, rows.length - 1)]
      if (row) onPick(row.ref)
      return
    }
    if (input === 'q' || input === 'b' || key.escape) {
      onBack()
      return
    }
    if (key.upArrow || input === 'k') {
      onSelected(Math.max(0, selected - 1))
      return
    }
    if (key.downArrow || input === 'j') {
      onSelected(Math.max(0, Math.min(rows.length - 1, selected + 1)))
      return
    }
    if (input === 'g') {
      onSelected(0)
      return
    }
    if (input === 'G') {
      onSelected(Math.max(0, rows.length - 1))
    }
  })

  const labelWidth = Math.max(18, Math.min(38, Math.floor((width - 40) / 2)))
  const reserved = 7
  const visibleRows = Math.max(3, height - reserved)
  const first =
    rows.length <= visibleRows
      ? 0
      : Math.min(Math.max(0, selected - Math.floor(visibleRows / 2)), rows.length - visibleRows)
  const windowed = rows.slice(first, first + visibleRows)

  return (
    <Box flexDirection="column" width={width} paddingTop={1}>
      {/* breadcrumb */}
      <Box paddingLeft={1}>
        <Text>
          <Text color={THEME.violet} bold>
            ❯{' '}
          </Text>
          <Text bold>{show}</Text>
          <Text dimColor>{`  ·  ${rows.length} seasons found · pick a season to browse episodes`}</Text>
        </Text>
      </Box>

      {hunting && (
        <Box paddingLeft={1} marginTop={1}>
          <Text color={THEME.cyan}>⟳ {hunting}…</Text>
        </Box>
      )}

      {/* season table */}
      <Box flexDirection="column" marginTop={1}>
        <Text dimColor bold>
          {'  # '}
          {padEnd('SEASON', labelWidth + 1)}
          {padStart('SEED', 5)}
          {padStart('EPS', 5)}
          {padStart('PACKS', 7)}
          {padStart('TORRENTS', 10)}
          {'  '}
          {'BEST SIZE'}
        </Text>
        {windowed.map((row, i) => {
          const index = first + i
          const isSelected = index === selected
          const rowBg = isSelected ? THEME.selBg : undefined
          const best = row.best
          return (
            <Text key={`${row.ref.kind}-${row.ref.kind === 'season' ? row.ref.season : ''}`} wrap="truncate-end">
              <Text backgroundColor={rowBg} color={isSelected ? THEME.cyan : 'gray'}>
                {isSelected ? '  ▸ ' : '    '}
              </Text>
              <Text backgroundColor={rowBg} color={isSelected ? '#ffffff' : undefined} bold={isSelected}>
                {padEnd(truncate(row.label, labelWidth), labelWidth + 1)}
              </Text>
              <Text backgroundColor={rowBg} color={seedColor(row.bestSeeders)}>
                {padStart(String(row.bestSeeders), 5)}
              </Text>
              <Text backgroundColor={rowBg} color={THEME.cyan}>
                {padStart(String(row.episodeCount), 5)}
              </Text>
              <Text backgroundColor={rowBg} color={THEME.indigo}>
                {padStart(String(row.packCount), 7)}
              </Text>
              <Text backgroundColor={rowBg} dimColor>
                {padStart(String(row.torrentCount), 10)}
              </Text>
              <Text backgroundColor={rowBg} dimColor>
                {'  ' + (best ? formatBytes(best.sizeBytes) : '—')}
              </Text>
            </Text>
          )
        })}
      </Box>

      {/* best-pack preview line */}
      {rows.length > 0 && rows[0].best && (
        <Box paddingLeft={1} marginTop={1}>
          <Text dimColor>
            top swarm: {truncate(rows[0].best.title, Math.max(20, width - 22))}
          </Text>
        </Box>
      )}

      {/* footer */}
      <Box marginTop={1} paddingLeft={1}>
        <Text dimColor>
          <Text color={THEME.violet}>j/k ↑↓</Text> navigate · <Text color={THEME.violet}>⏎</Text>{' '}
          browse episodes · <Text color={THEME.violet}>b/q</Text> back to series ·{' '}
          <Text color={THEME.violet}>ctrl+c</Text> quit
        </Text>
      </Box>
    </Box>
  )
}
