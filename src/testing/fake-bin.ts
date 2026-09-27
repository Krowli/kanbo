import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * A program on a test's own `PATH`, written in JavaScript so it runs on every
 * OS: a `#!/usr/bin/env node` script on POSIX, and on Windows the same script
 * beside a `.cmd` shim that runs it with this node — the shape npm gives every
 * global command there.
 *
 * `body` is the script's code; `process.argv.slice(2)` are the arguments it was
 * started with. Returns the path a caller would find on `PATH`.
 */
export function writeFakeBin(
  directory: string,
  name: string,
  body: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === 'win32') {
    const script = join(directory, `${name}.js`)
    writeFileSync(script, body)
    const shim = join(directory, `${name}.cmd`)
    writeFileSync(shim, `@echo off\r\n"${process.execPath}" "%~dp0\\${name}.js" %*\r\n`)
    return shim
  }
  const path = join(directory, name)
  writeFileSync(path, `#!/usr/bin/env node\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}

/** A fake that appends the arguments it was started with, space-joined, as one line to `logPath`. */
export function writeRecordingBin(directory: string, name: string, logPath: string): string {
  return writeFakeBin(
    directory,
    name,
    `require('node:fs').appendFileSync(${JSON.stringify(logPath)}, process.argv.slice(2).join(' ') + '\\n')`,
  )
}
