import { PROVIDER_IDS } from '../constants.js'

/* ------------------------------------------------------------------ *
 * --sources flag: pick which indexers this session queries
 * ------------------------------------------------------------------ */

/** Accepted spellings → canonical provider ids. */
const SOURCE_ALIASES: Record<string, string> = {
  tpb: 'piratebay',
  piratebay: 'piratebay',
  thepiratebay: 'piratebay',
  apibay: 'piratebay',
  '1337x': '1337x',
  '1337': '1337x',
  x1337: '1337x',
  leet: '1337x',
  nyaa: 'nyaa',
  'nyaa.si': 'nyaa'
}

export const SOURCE_HINT = 'valid sources: piratebay (tpb), 1337x, nyaa'

export interface SourcesParseResult {
  /** Canonical ids in display order, or null when the input was invalid. */
  providers: string[] | null
  error?: string
}

/**
 * Parse a comma-separated --sources value ("tpb,nyaa") into canonical
 * provider ids. Unknown ids are rejected loudly so typos never silently
 * disable a source the user wanted.
 */
export function parseSourcesFlag(value: string): SourcesParseResult {
  const wanted = value
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean)
  if (wanted.length === 0) {
    return { providers: null, error: `--sources needs at least one source (${SOURCE_HINT})` }
  }
  const ids: string[] = []
  for (const w of wanted) {
    const id = SOURCE_ALIASES[w]
    if (!id) {
      return { providers: null, error: `unknown source "${w}" — ${SOURCE_HINT}` }
    }
    if (!ids.includes(id)) ids.push(id)
  }
  return { providers: PROVIDER_IDS.filter(id => ids.includes(id)) }
}
