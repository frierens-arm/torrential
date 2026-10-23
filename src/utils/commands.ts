/**
 * Slash commands typed into the search bar (hermes-agent style).
 * Kept dependency-free so it is trivially unit-testable.
 */
export type SlashCommand =
  | { kind: 'theme'; arg?: string }
  | { kind: 'mode'; arg?: string }
  | { kind: 'unknown'; name: string }
  | null

const THEME_WORDS = new Set(['theme', 'skin'])
const MODE_WORDS = new Set(['mode'])

/**
 * Parse a search-bar line. Returns null when the text is a normal search
 * query. `/theme` and `/skin` are interchangeable:
 *   /theme            → show the skin picker
 *   /skin list        → same
 *   /theme ocean      → apply + persist
 * `/mode` works the same way for the session content mode:
 *   /mode             → show current mode + choices
 *   /mode tv          → apply + persist
 */
export function parseSlashCommand(text: string): SlashCommand {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return null
  const words = trimmed.slice(1).trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return { kind: 'unknown', name: '' }
  const head = words[0].toLowerCase()
  if (THEME_WORDS.has(head)) {
    const arg = words.slice(1).join(' ').trim().toLowerCase()
    // `/theme list` and `/theme ?` behave like bare `/theme` (show picker).
    if (arg === 'list' || arg === '?' || arg === 'ls') return { kind: 'theme' }
    return { kind: 'theme', arg: arg.length > 0 ? arg : undefined }
  }
  if (MODE_WORDS.has(head)) {
    const arg = words.slice(1).join(' ').trim().toLowerCase()
    // `/mode list` and `/mode ?` behave like bare `/mode` (show current).
    if (arg === 'list' || arg === '?' || arg === 'ls') return { kind: 'mode' }
    return { kind: 'mode', arg: arg.length > 0 ? arg : undefined }
  }
  return { kind: 'unknown', name: head }
}
