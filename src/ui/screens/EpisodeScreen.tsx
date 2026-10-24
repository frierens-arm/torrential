import { Box, Text } from 'ink'
import { useInput } from 'ink'
import type { SearchResult } from '../../types.js'
import type { EpisodeRow } from '../../utils/tv.js'
import { pad2 } from '../../utils/tv.js'
import { THEME } from '../../constants.js'
import { formatBytes, padEnd, padStart, qualityBadge, seedColor, truncate } from '../../utils/format.js'
import { useTerminalSize } from '../hooks.js'

export interface EpisodeScreenProps {
  show: string
  /** "Season 2" · "Specials" · "Episodes" (absolute bucket). */
  label: string
  rows: EpisodeRow[]
  /** Season packs for this view, pinned below the episode list. */
  packs: SearchResult[]
  /** Supplemental smart-search indicator ("hunting S02E05…"). */
  hunting?: string | null
  /** Episode last streamed from this season — marked with ▶ and preselected. */
  resumeEpisode?: number | null
  selected: number
  onSelected: (index: number) => void
  /** ⏎ on an episode row (index into rows). */
  onPickEpisode: (row: EpisodeRow) => void
  /** ⏎ on a pinned pack row (index into packs). */
  onPickPack: (result: SearchResult) => void
  onBack: () => void
}

/** One navigable row: an episode, or a pinned season pack. */
interface Row {
  kind: 'episode' | 'pack'
  episode?: EpisodeRow
  pack?: SearchResult
}

/**
 * Tier 3 — the episode grid for one season: every episode the swarm can
 * serve, plus the season's packs pinned at the bottom. Range-only
 * episodes ("covered by S02E01-E04") are flagged.
 */
export function EpisodeScreen({
  show,
  label,
  rows,
  packs,
  hunting,
  resumeEpisode,
  selected,
  onSelected,
  onPickEpisode,
  onPickPack,
  onBack
}: EpisodeScreenProps): React.ReactElement {
  const { width, height } = useTerminalSize()

  const flat: Row[] = [
    ...rows.map(episode => ({ kind: 'episode' as const, episode })),
    ...packs.map(pack => ({ kind: 'pack' as const, pack }))
  ]

  useInput((input, key) => {
    if (key.return) {
      const row = flat[Math.min(selected, flat.length - 1)]
      if (!row) return
      if (row.kind === 'episode' && row.episode) onPickEpisode(row.episode)
      if (row.kind === 'pack' && row.pack) onPickPack(row.pack)
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
      onSelected(Math.max(0, Math.min(flat.length - 1, selected + 1)))
      return
    }
    if (input === 'g') {
      onSelected(0)
      return
    }
    if (input === 'G') {
      onSelected(Math.max(0, flat.length - 1))
      return
    }
    if (key.pageUp) {
      onSelected(Math.max(0, selected - 10))
      return
    }
    if (key.pageDown) {
      onSelected(Math.max(0, Math.min(flat.length - 1, selected + 10)))
    }
  })

  const nameWidth = Math.max(14, width - 46)
  const reserved = 8
  const visibleRows = Math.max(3, height - reserved)
  const first =
    flat.length <= visibleRows
      ? 0
      : Math.min(Math.max(0, selected - Math.floor(visibleRows / 2)), flat.length - visibleRows)
  const windowed = flat.slice(first, first + visibleRows)
  const packStart = rows.length

  const header = (
    <Text dimColor bold>
      {'  # '}
      {padEnd('EPISODE', 8)}
      {padEnd('BEST TORRENT', nameWidth + 1)}
      {padStart('SEED', 5)}
      {padStart('SIZE', 9)}
      {'  '}
      {'QUALITY'}
    </Text>
  )

  return (
    <Box flexDirection="column" width={width} paddingTop={1}>
      {/* breadcrumb */}
      <Box paddingLeft={1}>
        <Text>
          <Text color={THEME.violet} bold>
            ❯{' '}
          </Text>
          <Text bold>{show}</Text>
          <Text color={THEME.subtle}> › </Text>
          <Text bold color={THEME.cyan}>
            {label}
          </Text>
          <Text dimColor>
            {`  ·  ${rows.length} episodes${packs.length > 0 ? ` · ${packs.length} packs` : ''}`}
            {resumeEpisode !== null && resumeEpisode !== undefined ? ' · ▶ last watched' : ''}
          </Text>
        </Text>
      </Box>

      {hunting && (
        <Box paddingLeft={1} marginTop={1}>
          <Text color={THEME.cyan}>⟳ {hunting}…</Text>
        </Box>
      )}

      {/* episode + pack rows — the pack section gets a separator heading
          exactly where it enters the visible window */}
      <Box flexDirection="column" marginTop={1}>
        {header}
        {windowed.map((row, i) => {
          const index = first + i
          const isSelected = index === selected
          const rowBg = isSelected ? THEME.selBg : undefined
          const marker = isSelected ? '  ▸ ' : '    '
          const atPackBoundary = index === packStart && packs.length > 0

          if (row.kind === 'episode' && row.episode) {
            const e = row.episode
            const best = e.best
            const badge = best ? qualityBadge(best.quality) : ''
            return (
              <Text key={`ep-${e.episode}`} wrap="truncate-end">
                <Text backgroundColor={rowBg} color={isSelected ? THEME.cyan : 'gray'}>
                  {marker}
                </Text>
                <Text backgroundColor={rowBg} color={isSelected ? '#ffffff' : THEME.cyan} bold={isSelected}>
                  {padEnd(`${e.episode === resumeEpisode ? '▶' : ' '}E${pad2(e.episode)}`, 8)}
                </Text>
                <Text backgroundColor={rowBg} color={isSelected ? '#ffffff' : undefined}>
                  {padEnd(
                    truncate(
                      best ? (best.show ?? best.title) : 'no direct torrent',
                      nameWidth - (e.viaRangeOnly ? 14 : 0)
                    ) + (e.viaRangeOnly ? '  ⇄ via range' : ''),
                    nameWidth + 1
                  )}
                </Text>
                <Text backgroundColor={rowBg} color={best ? seedColor(best.seeders) : THEME.red}>
                  {padStart(best ? String(best.seeders) : '0', 5)}
                </Text>
                <Text backgroundColor={rowBg} dimColor>
                  {padStart(best ? formatBytes(best.sizeBytes) : '—', 9)}
                </Text>
                <Text backgroundColor={rowBg} color={THEME.indigo}>
                  {'  ' + padEnd(badge.length > 0 ? badge : '—', 12)}
                </Text>
              </Text>
            )
          }

          // pinned pack row (the first one carries the section heading)
          const pack = row.pack!
          const badge = qualityBadge(pack.quality)
          return (
            <Box key={`pack-${pack.id}`} flexDirection="column">
              {atPackBoundary && (
                <Text dimColor color={THEME.subtle}>
                  {'  ── season packs ' + '─'.repeat(Math.max(4, width - 20))}
                </Text>
              )}
              <Text wrap="truncate-end">
              <Text backgroundColor={rowBg} color={isSelected ? THEME.cyan : 'gray'}>
                {marker}
              </Text>
              <Text backgroundColor={rowBg} color={isSelected ? '#ffffff' : THEME.pink} bold={isSelected}>
                {padEnd('PACK', 8)}
              </Text>
              <Text backgroundColor={rowBg} color={isSelected ? '#ffffff' : undefined}>
                {padEnd(truncate(`${pack.scopeLabel ?? ''} · ${pack.title}`, nameWidth), nameWidth + 1)}
              </Text>
              <Text backgroundColor={rowBg} color={seedColor(pack.seeders)}>
                {padStart(String(pack.seeders), 5)}
              </Text>
              <Text backgroundColor={rowBg} dimColor>
                {padStart(formatBytes(pack.sizeBytes), 9)}
              </Text>
              <Text backgroundColor={rowBg} color={THEME.indigo}>
                {'  ' + padEnd(badge.length > 0 ? badge : '—', 12)}
              </Text>
              </Text>
            </Box>
          )
        })}

        {flat.length === 0 && (
          <Box flexDirection="column" paddingLeft={1} marginTop={2}>
            <Text color={THEME.yellow}>
              nothing here yet{hunting ? ' — still hunting the swarm' : ' for this season'}.
            </Text>
            <Text dimColor>try another season, or search again with an SxxExx tag</Text>
          </Box>
        )}
      </Box>

      {/* footer */}
      <Box marginTop={1} paddingLeft={1}>
        <Text dimColor>
          <Text color={THEME.violet}>j/k ↑↓</Text> navigate · <Text color={THEME.violet}>⏎</Text>{' '}
          pick episode / pack · <Text color={THEME.violet}>g/G</Text> top/bottom ·{' '}
          <Text color={THEME.violet}>PgUp/PgDn</Text> page · <Text color={THEME.violet}>b/q</Text>{' '}
          back · <Text color={THEME.violet}>ctrl+c</Text> quit
        </Text>
      </Box>
    </Box>
  )
}
