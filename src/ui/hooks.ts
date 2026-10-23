import { useEffect, useState } from 'react'
import { useStdout } from 'ink'

/** Terminal dimensions that react to resizes. */
export function useTerminalSize(): { width: number; height: number } {
  const { stdout } = useStdout()
  const read = (): { width: number; height: number } => ({
    width: Math.max(40, stdout?.columns ?? 80),
    height: Math.max(12, stdout?.rows ?? 24)
  })
  const [size, setSize] = useState(read)
  useEffect(() => {
    const onResize = (): void => setSize(read())
    stdout?.on('resize', onResize)
    return () => {
      stdout?.removeListener('resize', onResize)
    }
  }, [stdout])
  return size
}

/** Animation clock — increments every `intervalMs` while `active`. */
export function useTick(intervalMs: number, active = true): number {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setTick(t => t + 1), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs, active])
  return tick
}
