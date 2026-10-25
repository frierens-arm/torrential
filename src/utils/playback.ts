import { pad2 } from './tv.js'

/**
 * Where a stopped stream should land.
 *
 * A finished episode belongs back on the EPISODE GRID — the list you pick the
 * next episode from — with the cursor already on what comes next. The torrent
 * pre-flight card is deliberately NOT the destination: after the credits the
 * pack listing for the episode you just watched is noise.
 *
 * Bailing out early (pressing q at 40%) keeps the old behaviour and stays on
 * the pre-flight card, which is where swapping torrents for the same episode
 * belongs.
 *
 * Pure on purpose: the App applies the plan, tests assert it.
 */

export interface PlaybackReturnInput {
  /** True when the file played to >= 95% (see App's progress tracking). */
  finished: boolean
  /** The episode that was last streamed, or null for movies/magnets/packs. */
  last: { seriesKey: string; season: number | null; episode: number } | null
  /** The series currently open in the browser, if any. */
  seriesKey: string | null
  /** Episode numbers that exist in the played season; null when unknown. */
  episodes: number[] | null
  /**
   * Season the episode grid is parked on: a number, null for the absolute
   * (season-less) bucket, undefined when no episode grid is open.
   */
  gridSeason: number | null | undefined
}

export interface PlaybackReturnPlan {
  /** Land on the episode grid (true) or fall through to the old routing. */
  toEpisodes: boolean
  /** Episode row the cursor should sit on (the next one, else the finished one). */
  cursorEpisode: number | null
  /** Next episode number, or null when the season ends here. */
  next: number | null
  /** Pre-flight card note ("next up E02"). */
  note: string | null
}

const STAY: PlaybackReturnPlan = { toEpisodes: false, cursorEpisode: null, next: null, note: null }

export function planPlaybackReturn(input: PlaybackReturnInput): PlaybackReturnPlan {
  if (!input.finished) return STAY
  const last = input.last
  if (!last) return STAY
  if (input.seriesKey === null || last.seriesKey !== input.seriesKey) return STAY
  if (input.episodes === null) return STAY
  if (input.gridSeason === undefined || input.gridSeason !== last.season) return STAY

  const episodes = [...input.episodes].sort((a, b) => a - b)
  const next = episodes.find(episode => episode > last.episode) ?? null
  const cursorEpisode = next ?? last.episode
  const note =
    next === null
      ? `finished E${pad2(last.episode)} — last episode here · b for seasons`
      : `finished E${pad2(last.episode)} — next up E${pad2(next)} · ⏎ to play`

  return { toEpisodes: true, cursorEpisode, next, note }
}
