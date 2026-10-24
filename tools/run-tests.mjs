#!/usr/bin/env node
/**
 * Cross-platform test entry point.
 *
 * `node --test test/*.test.ts` depends on the shell expanding the glob, which
 * cmd.exe on Windows does not do. This wrapper expands the directory itself
 * and hands an explicit file list to Node's built-in runner (with tsx loaded
 * so the TypeScript sources import exactly as they do in the app).
 *
 *   npm test                 # everything in test/
 *   npm test -- --test-name-pattern range
 */
import { spawn } from 'node:child_process'
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dir = path.join(root, 'test')

let files
try {
  files = readdirSync(dir)
    .filter(name => name.endsWith('.test.ts'))
    .sort()
    .map(name => path.join(dir, name))
} catch {
  console.error(`no test directory at ${dir}`)
  process.exit(1)
}

if (files.length === 0) {
  console.error('no *.test.ts files found')
  process.exit(1)
}

const child = spawn(
  process.execPath,
  ['--import', 'tsx', '--test', '--test-reporter=spec', ...process.argv.slice(2), ...files],
  { stdio: 'inherit', cwd: root, env: { ...process.env, TORRENTIAL_DEBUG: '' } }
)

child.on('error', err => {
  console.error(`could not start the test runner: ${err.message}`)
  process.exit(1)
})
child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`test runner killed by ${signal}`)
    process.exit(1)
  }
  process.exit(code ?? 1)
})
