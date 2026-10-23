import { useMemo, useState } from 'react'
import { Box, Text } from 'ink'
import { useInput } from 'ink'
import type { StreamStats, TorrentFileInfo } from '../../types.js'
import { THEME } from '../../constants.js'
import { formatBytes, padEnd, padStart, truncate } from '../../utils/format.js'
import { useTerminalSize } from '../hooks.js'

export interface FilePickerScreenProps {
  /** Engine snapshot in the 'picking' phase (carries `files`). */
  stats: StreamStats
  /** Optional episode hint: pre-highlight its file and badge it. */
  wanted?: { season: number | null; episode: number } | null
  onPick: (fileIndex: number) => void
  onCancel: () => void
}

/**
 * Interactive file selection for multi-file torrents (season packs, batch
 * uploads). Video files are listed first — sorted by episode when the
 * names parse — with the engine's best match pre-highlighted. Non-video
 * files stay reachable at the bottom for the rare deliberate pick.
 */
export function FilePickerScreen({
  stats,
  wanted,
  onPick,
  onCancel
}: FilePickerScreenProps): React.ReactElement {
  const { width, height } = useTerminalSize()

  // Sorted for display: video first, episodes ascending, size as tiebreak.
  // The TRUE torrent file index travels with each row.
  const rows = useMemo(() => {
    const files = stats.files ?? []
    const video = files.filter(f => f.isVideo)
    const other = files.filter(f => !f.isVideo)
    const episodeOf = (f: TorrentFileInfo): number => {
      const s = f.scope
      if (s && s.kind === 'episode') return s.episode
      return Number.MAX_SAFE_INTEGER
    }
    const byEpisode = [...video].sort((a, b) => episodeOf(a) - episodeOf(b) || a.index - b.index)
    return [...byEpisode, ...other]
  }, [stats.files])

  // Pre-highlight: the engine's own episode match, else the first video.
  const [selected, setSelected] = useState(() => {
    if (wanted) {
      const hit = rows.find(f => {
        const s = f.scope
        return (
          s !== undefined &&
          s.kind === 'episode' &&
          s.season === wanted.season &&
          (s.episode === wanted.episode || (s.episodes?.includes(wanted.episode) ?? false))
        )
      })
      if (hit) return rows.indexOf(hit)
    }
    const firstVideo = rows.findIndex(f => f.isVideo)
    return firstVideo >= 0 ? firstVideo : 0
  })

  useInput((input, key) => {
    if (key.return) {
      const row = rows[Math.min(selected, rows.length - 1)]
      if (row) onPick(row.index)
      return
    }
    if (input === 'q' || input === 'b' || key.escape) {
      onCancel()
      return
    }
    if (key.upArrow || input === 'k') {
      setSelected(s => Math.max(0, s - 1))
      return
    }
    if (key.downArrow || input === 'j') {
      setSelected(s => Math.min(rows.length - 1, s + 1))
      return
    }
    if (input === 'g') {
      setSelected(0)
      return
    }
    if (input === 'G') {
      setSelected(rows.length - 1)
      return
    }
    if (key.pageUp) {
      setSelected(s => Math.max(0, s - 10))
      return
    }
    if (key.pageDown) {
      setSelected(s => Math.min(rows.length - 1, s + 10))
    }
  })

  const nameWidth = Math.max(20, width - 38)
  const reserved = 8
  const visibleRows = Math.max(3, height - reserved)
  const first =
    rows.length <= visibleRows
      ? 0
      : Math.min(Math.max(0, selected - Math.floor(visibleRows / 2)), rows.length - visibleRows)
  const windowed = rows.slice(first, first + visibleRows)
  const videoCount = rows.filter(f => f.isVideo).length

  return (
    <Box flexDirection="column" width={width} paddingTop={1}>
      {/* breadcrumb */}
      <Box paddingLeft={1}>
        <Text>
          <Text color={THEME.violet} bold>
            ❯{' '}
          </Text>
          <Text bold>{truncate(stats.title, Math.max(24, width - 44))}</Text>
        </Text>
      </Box>
      <Box paddingLeft={1} marginTop={1}>
        <Text color={THEME.cyan}>
          season pack detected — {videoCount} video files · pick the episode to stream
        </Text>
      </Box>
      {wanted && (
        <Box paddingLeft={1}>
          <Text dimColor>
            hunting{' '}
            {wanted.season === null
              ? `episode ${wanted.episode}`
              : `S${String(wanted.season).padStart(2, '0')}E${String(wanted.episode).padStart(2, '0')}`}{' '}
            — its row is highlighted when present
          </Text>
        </Box>
      )}

      {/* file table */}
      <Box flexDirection="column" marginTop={1}>
        <Text dimColor bold>
          {'  # '}
          {padEnd('FILE', nameWidth + 1)}
          {padStart('SIZE', 10)}
          {'  '}
          {'EPISODE'}
        </Text>
        {windowed.map((f, i) => {
          const index = first + i
          const isSelected = index === selected
          const rowBg = isSelected ? THEME.selBg : undefined
          return (
            <Text key={f.index} wrap="truncate-end">
              <Text backgroundColor={rowBg} color={isSelected ? THEME.cyan : 'gray'}>
                {isSelected ? '  ▸ ' : '    '}
              </Text>
              <Text
                backgroundColor={rowBg}
                color={isSelected ? '#ffffff' : f.isVideo ? undefined : 'gray'}
                bold={isSelected}
              >
                {padEnd(truncate(f.name, nameWidth), nameWidth + 1)}
              </Text>
              <Text backgroundColor={rowBg} dimColor>
                {padStart(formatBytes(f.length), 10)}
              </Text>
              <Text backgroundColor={rowBg} color={f.isVideo ? THEME.indigo : THEME.subtle}>
                {'  ' + padEnd(f.scopeLabel ?? (f.isVideo ? '—' : 'extra'), 12)}
              </Text>
            </Text>
          )
        })}
      </Box>

      {/* footer */}
      <Box marginTop={1} paddingLeft={1}>
        <Text dimColor>
          <Text color={THEME.violet}>j/k ↑↓</Text> navigate · <Text color={THEME.violet}>⏎</Text>{' '}
          stream file · <Text color={THEME.violet}>g/G</Text> top/bottom ·{' '}
          <Text color={THEME.violet}>PgUp/PgDn</Text> page · <Text color={THEME.violet}>b/q</Text>{' '}
          cancel · <Text color={THEME.violet}>ctrl+c</Text> quit
        </Text>
      </Box>
    </Box>
  )
}
