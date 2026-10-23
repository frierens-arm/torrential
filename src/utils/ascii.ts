/**
 * The torrential wordmark and animation frames.
 *
 * Logo variants (all verified ≤ 80 cols):
 *   big    — ANSI Shadow, 80 wide, 6 lines   (terminals ≥ 84 columns)
 *   medium — double-block,  41 wide, 2 lines (terminals ≥ 45 columns)
 *   small  — Calvin S,     28 wide, 3 lines (everything else)
 */

/** ANSI Shadow — used when the terminal is wide enough. */
export const LOGO_BIG: string[] = [
  '████████╗ ██████╗ ██████╗ ██████╗ ███████╗███╗   ██╗████████╗██╗ █████╗ ██╗     ',
  '╚══██╔══╝██╔═══██╗██╔══██╗██╔══██╗██╔════╝████╗  ██║╚══██╔══╝██║██╔══██╗██║     ',
  '   ██║   ██║   ██║██████╔╝██████╔╝█████╗  ██╔██╗ ██║   ██║   ██║███████║██║     ',
  '   ██║   ██║   ██║██╔══██╗██╔══██╗██╔══╝  ██║╚██╗██║   ██║   ██║██╔══██║██║     ',
  '   ██║   ╚██████╔╝██║  ██║██║  ██║███████╗██║ ╚████║   ██║   ██║██║  ██║███████╗',
  '   ╚═╝    ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝╚═╝  ╚═══╝   ╚═╝   ╚═╝╚═╝  ╚═╝╚══════╝'
]

/** double-block — the default wordmark, one letter per cell. */
export const LOGO_MED_ROWS: string[][] = [
  ['▀█▀', '█▀█', '█▀█', '█▀█', '█▀▀', '█▄░█', '▀█▀', '▀█▀', '▄▀█', '█░░'],
  [' ░█░', '█▄█', '█▀▄', '█▀▄', '██▄', '█░▀█', '░█░', '▄█▄', '█▀█', '█▄▄']
]

/** Calvin S — ultra compact fallback. */
export const LOGO_SMALL: string[] = [
  '╔╦╗╔═╗╦═╗╦═╗╔═╗╔╗╔╔╦╗╦╔═╗╦  ',
  ' ║ ║ ║╠╦╝╠╦╝║╣ ║║║ ║ ║╠═╣║  ',
  ' ╩ ╚═╝╩╚═╩╚═╚═╝╝╚╝ ╩ ╩╩ ╩╩═╝'
]

/** Braille spinner frames (80ms cadence). */
export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const

/**
 * Downpour wave glyphs — a drifting surface rendered while waiting,
 * torlink-style "fluid" loading.
 */
export const WAVE_GLYPHS = [' ', '·', '¸', '¨', '~', '≈', '~', '¨', '¸', '·'] as const

/** Sheen sweep characters for the progress bar. */
export const BAR_FILLED = '█'
export const BAR_SHEEN = '▓'
export const BAR_EMPTY = '░'

/* ------------------------------------------------------------------ *
 * Color helpers (truecolor hex, graceful degradation via chalk)
 * ------------------------------------------------------------------ */

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  return [
    Number.parseInt(h.slice(0, 2), 16),
    Number.parseInt(h.slice(2, 4), 16),
    Number.parseInt(h.slice(4, 6), 16)
  ]
}

/** Linear interpolation between two hex colors. */
export function hexLerp(a: string, b: string, t: number): string {
  const [r1, g1, b1] = hexToRgb(a)
  const [r2, g2, b2] = hexToRgb(b)
  const clamped = Math.max(0, Math.min(1, t))
  const to = (x: number): string => Math.round(x).toString(16).padStart(2, '0')
  return `#${to(r1 + (r2 - r1) * clamped)}${to(g1 + (g2 - g1) * clamped)}${to(b1 + (b2 - b1) * clamped)}`
}

/** Build a `steps`-long gradient between two hex endpoints. */
export function gradientOf(a: string, b: string, steps: number): string[] {
  if (steps <= 1) return [a]
  return Array.from({ length: steps }, (_, i) => hexLerp(a, b, i / (steps - 1)))
}
