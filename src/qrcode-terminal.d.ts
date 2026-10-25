/**
 * Minimal typings for `qrcode-terminal` (no upstream types).
 *
 * Only the synchronous callback form is used: `generate()` invokes the
 * callback before returning, which is what lets the TUI render the QR once
 * at share time instead of per frame.
 */
declare module 'qrcode-terminal' {
  export interface QrGenerateOptions {
    /** Half-block output (two module rows per terminal row). */
    small?: boolean
    /** Force a QR version; omitted = smallest that fits. */
    version?: number
  }

  export function generate(text: string, options?: QrGenerateOptions, callback?: (output: string) => void): void
  export function generate(text: string, callback?: (output: string) => void): void
  /** 'L' | 'M' | 'Q' | 'H' — L keeps the QR small, which is what a URL wants. */
  export function setErrorLevel(level: 'L' | 'M' | 'Q' | 'H'): void
}
