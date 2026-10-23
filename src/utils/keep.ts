import fs from 'node:fs'
import path from 'node:path'

/* ------------------------------------------------------------------ *
 * --keep / -k: hoist the streamed file out of the throwaway cache
 * ------------------------------------------------------------------ */

/** `Movie.mkv` → `Movie (2).mkv`, `Movie (3).mkv`… until a free slot is found. */
export function uniqueDest(dir: string, fileName: string): string {
  let dest = path.join(dir, fileName)
  if (!fs.existsSync(dest)) return dest
  const ext = path.extname(fileName)
  const stem = ext.length > 0 ? fileName.slice(0, fileName.length - ext.length) : fileName
  for (let n = 2; n < 1000; n++) {
    dest = path.join(dir, `${stem} (${n})${ext}`)
    if (!fs.existsSync(dest)) return dest
  }
  return path.join(dir, `${stem}-${Date.now()}${ext}`)
}

/**
 * Move a downloaded file into the keep directory.
 *
 * `rename()` first (instant, same volume); on cross-device setups
 * (cache on one disk, movies on another) it fails with EXDEV and we
 * fall back to copy + delete.
 *
 * Returns the destination path, or null when the source never
 * materialized on disk (playback ended before any piece arrived).
 */
export async function moveFileToKeepDir(src: string, keepDir: string): Promise<string | null> {
  try {
    await fs.promises.access(src, fs.constants.F_OK)
  } catch {
    return null
  }
  await fs.promises.mkdir(keepDir, { recursive: true })
  const dest = uniqueDest(keepDir, path.basename(src))
  try {
    await fs.promises.rename(src, dest)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code !== 'EXDEV') throw err
    // Different volumes: copy across, then drop the cache copy.
    await fs.promises.copyFile(src, dest)
    await fs.promises.rm(src, { force: true })
  }
  return dest
}
