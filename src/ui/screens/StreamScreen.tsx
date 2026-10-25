import { useMemo } from 'react'
import { Box, Text } from 'ink'
import { useInput } from 'ink'
import type { StreamStats } from '../../types.js'
import { THEME } from '../../constants.js'
import { formatBytes, formatEta, formatSpeed, truncateStart } from '../../utils/format.js'
import { qrWidth, renderQr } from '../../utils/qr.js'
import type { PhoneShareState } from '../hooks/useStreamSession.js'
import { ProgressBar } from '../components/ProgressBar.js'
import { Spinner } from '../components/Spinner.js'
import { useTerminalSize } from '../hooks.js'

export interface PlayerInfo {
  label: string
  detached: boolean
  note?: string
}

export interface StreamScreenProps {
  stats: StreamStats | null
  player: PlayerInfo | null
  /** Phone hand-off state: QR URL, errors, live flag. */
  phone: PhoneShareState
  /** Toggle LAN sharing for this stream (`l`). */
  onTogglePhone: () => void
  keepCache: boolean
  /** Set when --keep is active: the file is moved here on teardown. */
  keepDir?: string | null
  onStop: () => void
}

/** Below this width the QR would wrap and stop scanning — show the URL only. */
const MIN_QR_WIDTH = 40

const PHASE_COPY: Record<StreamStats['phase'], string> = {
  connecting: 'contacting the swarm…',
  metadata: 'pulling metadata…',
  picking: 'waiting for a file choice…',
  ready: 'priming the stream…',
  streaming: 'streaming',
  done: 'downloaded — fully cached',
  error: 'stream failed',
  stopped: 'stopped'
}

/**
 * The live playback dashboard: gradient sheen progress bar, speeds,
 * peers, cache ratio, and the local URL the player is attached to.
 */
export function StreamScreen({
  stats,
  player,
  phone,
  onTogglePhone,
  keepCache,
  keepDir,
  onStop
}: StreamScreenProps): React.ReactElement {
  const { width } = useTerminalSize()
  const qrLines = useMemo(() => (phone.url ? renderQr(phone.url) : []), [phone.url])
  const qrFits =
    phone.url !== null &&
    width >= MIN_QR_WIDTH &&
    qrLines.length > 0 &&
    qrWidth(qrLines) < width - 4

  useInput((input, key) => {
    if (input === 'q' || input === 'b' || key.escape) onStop()
    if (input === 'l' && (stats?.phase === 'streaming' || stats?.phase === 'ready' || stats?.phase === 'done')) {
      onTogglePhone()
    }
  })

  if (!stats) {
    return (
      <Box flexDirection="column" paddingTop={2} paddingLeft={2}>
        <Box>
          <Spinner />
          <Text dimColor> spawning engine…</Text>
        </Box>
      </Box>
    )
  }

  const isError = stats.phase === 'error'
  const isDone = stats.phase === 'done'
  const active = stats.phase === 'streaming' || stats.phase === 'ready'
  const pct = (stats.progress * 100).toFixed(1)
  const barWidth = Math.max(24, Math.min(44, width - 12))

  return (
    <Box flexDirection="column" paddingTop={1} paddingLeft={2} width={width}>
      {/* phase line */}
      <Box>
        {stats.phase === 'connecting' || stats.phase === 'metadata' || stats.phase === 'ready' ? (
          <Text>
            <Spinner color={THEME.cyan} />
            <Text color={THEME.cyan}> {PHASE_COPY[stats.phase]}</Text>
          </Text>
        ) : isDone ? (
          <Text color={THEME.green}>✓ {PHASE_COPY[stats.phase]}</Text>
        ) : stats.phase === 'streaming' ? (
          <Text>
            <Text color={THEME.green}>▶ {PHASE_COPY[stats.phase]}</Text>
            {stats.turbo && <Text color={THEME.cyan} bold> · turbo</Text>}
            {player && <Text dimColor> via {player.label}</Text>}
          </Text>
        ) : isError ? (
          <Text color={THEME.red}>✗ {PHASE_COPY[stats.phase]}</Text>
        ) : (
          <Text dimColor>· {PHASE_COPY[stats.phase]}</Text>
        )}
      </Box>

      {/* file identity */}
      <Box marginTop={1}>
        <Text>
          <Text bold color="#ffffff">
            {stats.fileName}
          </Text>
          <Text dimColor> — {formatBytes(stats.fileSize)}</Text>
          {stats.videoFileCount > 1 && (
            <Text dimColor color={THEME.subtle}>
              {' '}
              (file {stats.fileIndex + 1} of {stats.fileCount} in this pack)
            </Text>
          )}
        </Text>
      </Box>
      {stats.title !== stats.fileName && (
        <Text dimColor>from: {stats.title}</Text>
      )}

      {/* endpoint */}
      {stats.url && (
        <Box marginTop={1} flexDirection="column">
          <Text>
            <Text dimColor color={THEME.subtle}>endpoint </Text>
            <Text color={THEME.blue}>{stats.url}</Text>
          </Text>
          <Text dimColor color={THEME.subtle}>
            (open this URL manually in any player if nothing launches)
          </Text>
        </Box>
      )}

      {/* phone hand-off: QR + tokenized LAN URL */}
      {phone.active && phone.url && (
        <Box marginTop={1} flexDirection="column">
          <Text color={THEME.cyan} bold>
            ⌁ watch on your phone
          </Text>
          {qrFits ? (
            <Box flexDirection="column" marginTop={0}>
              {qrLines.map((line, index) => (
                <Text key={index}>{line}</Text>
              ))}
            </Box>
          ) : (
            <Text color={THEME.subtle} dimColor>
              terminal too narrow for a QR code — type the URL below into your phone
            </Text>
          )}
          <Text color={THEME.blue}>{phone.url}</Text>
          <Text dimColor color={THEME.subtle}>
            same Wi-Fi · opens as a web player, nothing is saved on the phone
          </Text>
        </Box>
      )}
      {phone.error && !phone.active && (
        <Box marginTop={1}>
          <Text color={THEME.yellow}>⚠ phone share: {phone.error}</Text>
        </Box>
      )}

      {/* player status */}
      {player && (
        <Box flexDirection="column">
          <Text dimColor color={THEME.subtle}>
            player: {player.label}
            {player.detached ? ' — detached; press q here when you are done' : ''}
          </Text>
          {player.note && <Text color={THEME.yellow}>note: {player.note}</Text>}
        </Box>
      )}

      {/* progress bar */}
      <Box marginTop={1} flexDirection="row">
        <Text color={THEME.violet}>[</Text>
        <ProgressBar progress={stats.progress} width={barWidth} active={active || isDone} />
        <Text color={THEME.violet}>]</Text>
        <Text> {pct}%</Text>
        <Text dimColor> cached</Text>
      </Box>

      {/* live stats grid */}
      <Box marginTop={1}>
        <Text>
          <Text color={THEME.cyan}>↓ {formatSpeed(stats.downloadSpeed)}</Text>
          <Text dimColor> · </Text>
          <Text color={THEME.pink}>↑ {formatSpeed(stats.uploadSpeed)}</Text>
          <Text dimColor> · peers </Text>
          <Text color={stats.peers > 0 ? THEME.lime : THEME.yellow} bold={stats.peers === 0}>
            {String(stats.peers)}
          </Text>
          <Text dimColor> · eta </Text>
          <Text>{formatEta(stats.timeRemaining)}</Text>
          <Text dimColor> · swarm {(stats.overallProgress * 100).toFixed(0)}%</Text>
          {stats.bufferAheadSecs !== null && stats.bufferAheadSecs > 0 && (
            <>
              <Text dimColor> · buffer ≈ </Text>
              <Text color={stats.bufferAheadSecs < 10 ? THEME.yellow : THEME.lime}>
                {stats.bufferAheadSecs >= 3600
                  ? `${Math.floor(stats.bufferAheadSecs / 60)}m`
                  : `${Math.round(stats.bufferAheadSecs)}s`}
              </Text>
              <Text dimColor> ahead</Text>
            </>
          )}
        </Text>
      </Box>

      {/* warnings */}
      {stats.warnings.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {stats.warnings.slice(-3).map((warning, i) => (
            <Text key={i} color={THEME.yellow}>
              ⚠ {warning}
            </Text>
          ))}
        </Box>
      )}

      {/* error block */}
      {isError && (
        <Box
          flexDirection="column"
          marginTop={1}
          borderStyle="round"
          borderColor={THEME.red}
          paddingX={1}
          width={Math.min(width - 6, 60)}
        >
          <Text color={THEME.red} bold>
            {stats.error ?? 'unknown engine error'}
          </Text>
          <Text dimColor>
            {stats.errorHint ??
              'hints: dead torrents (0 seeds) never deliver metadata · trackers may be blocked on this network · try another result'}
          </Text>
          <Text dimColor color={THEME.subtle}>
            press q to go back and pick another torrent for this episode
          </Text>
        </Box>
      )}

      {/* footer */}
      <Box marginTop={1}>
        <Text dimColor>
          <Text color={THEME.violet}>l</Text> {phone.active ? 'stop sharing' : 'watch on phone'}{' '}
          · <Text color={THEME.violet}>q</Text> stop{' '}
          {keepDir
            ? `→ save to ${truncateStart(keepDir, 42)}`
            : keepCache
              ? '(keeping cache)'
              : '& wipe cache'}{' '}
          · <Text color={THEME.violet}>ctrl+c</Text> quit
        </Text>
      </Box>
    </Box>
  )
}
