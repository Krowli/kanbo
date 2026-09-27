import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { findAllOnPath } from './paths'

describe('findAllOnPath', () => {
  let root: string
  let first: string
  let second: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'kanbo-path-'))
    first = join(root, 'first')
    second = join(root, 'second')
    mkdirSync(first)
    mkdirSync(second)
    // What a global npm install leaves on Windows: an sh script and a .cmd shim, side by side.
    for (const name of ['kanbo', 'kanbo.cmd']) {
      writeFileSync(join(first, name), '')
      chmodSync(join(first, name), 0o755)
    }
    writeFileSync(join(second, 'kanbo.exe'), '')
  })

  afterEach(() => {
    rmSync(root, { force: true, recursive: true })
  })

  it('on Windows finds the .cmd shim and the .exe by PATHEXT, never the extensionless script', () => {
    const env = { PATH: `${first};${second}`, PATHEXT: '.EXE;.CMD' }

    expect(findAllOnPath('kanbo', { platform: 'win32', env })).toEqual([join(first, 'kanbo.cmd'), join(second, 'kanbo.exe')])
  })

  it('on Windows takes a name that already has a PATHEXT extension as it is, whatever its case', () => {
    const env = { PATH: first, PATHEXT: '.exe;.cmd' }

    expect(findAllOnPath('kanbo.cmd', { platform: 'win32', env })).toEqual([join(first, 'kanbo.cmd')])
    expect(findAllOnPath(join(first, 'kanbo'), { platform: 'win32', env })).toEqual([join(first, 'kanbo.cmd')])
  })

  // POSIX rules on a POSIX file system: a `C:\` path cannot sit in a `:`-separated PATH, and Windows has no executable bit.
  it.skipIf(process.platform === 'win32')('elsewhere finds the executable of that exact name only', () => {
    const env = { PATH: `${first}:${second}` }

    expect(findAllOnPath('kanbo', { platform: 'linux', env })).toEqual([join(first, 'kanbo')])
  })
})
