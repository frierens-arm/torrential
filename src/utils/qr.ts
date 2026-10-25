import qrcode from 'qrcode-terminal'

/**
 * Terminal QR rendering.
 *
 * `qrcode-terminal`'s small mode emits Unicode half blocks with no escape
 * sequences at all, so Ink measures and wraps it like any other text. The
 * smallest error-correction level is used because the payload is a short
 * http:// URL and a smaller matrix scans more reliably off a laptop screen
 * from arm's length.
 */
qrcode.setErrorLevel('L')

const cache = new Map<string, string[]>()

/**
 * Render `text` as terminal lines (one string per row).
 *
 * Memoized: the QR is recomputed only when the share URL changes, never on
 * the 4 Hz stats tick.
 */
export function renderQr(text: string): string[] {
  const cached = cache.get(text)
  if (cached) return cached
  let output = ''
  qrcode.generate(text, { small: true }, (rendered: string) => {
    output = rendered
  })
  const lines = output.replace(/[\r\n]+$/, '').split(/\r?\n/)
  cache.set(text, lines)
  return lines
}

/** Widest terminal row the QR occupies, in columns. */
export function qrWidth(lines: string[]): number {
  let width = 0
  for (const line of lines) width = Math.max(width, line.length)
  return width
}
