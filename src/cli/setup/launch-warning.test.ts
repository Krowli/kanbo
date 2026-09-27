import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { writeFakeBin } from '../../testing/fake-bin'
import { NOT_ON_PATH_WARNING, NPX_LAUNCH_WARNING, readLaunchWarning } from './launch-warning'

describe('readLaunchWarning', () => {
  let bin: string

  beforeEach(() => {
    bin = mkdtempSync(join(tmpdir(), 'kanbo-launch-'))
  })

  afterEach(() => {
    rmSync(bin, { force: true, recursive: true })
  })

  const npxScript = '/home/me/.npm/_npx/1a2b3c/node_modules/kanbo-cli/dist/cli.cjs'

  it('says kanbo runs from npx when it runs from npm\'s npx cache, whatever PATH has', () => {
    writeFakeBin(bin, 'kanbo', '')
    expect(readLaunchWarning({ script: npxScript, env: { PATH: bin } })).toBe(NPX_LAUNCH_WARNING)
    expect(readLaunchWarning({ script: 'C:\\Users\\me\\AppData\\Local\\npm-cache\\_npx\\1a2b\\node_modules\\kanbo-cli\\dist\\cli.cjs', env: { PATH: '' } }))
      .toBe(NPX_LAUNCH_WARNING)
  })

  it('says it runs from npx when npm exec started it and kanbo is not on PATH', () => {
    expect(readLaunchWarning({ script: '/somewhere/cli.cjs', env: { PATH: bin, npm_command: 'exec' } })).toBe(NPX_LAUNCH_WARNING)
  })

  it('says kanbo is not on PATH when it is not', () => {
    expect(readLaunchWarning({ script: '/somewhere/cli.cjs', env: { PATH: bin } })).toBe(NOT_ON_PATH_WARNING)
  })

  it('says nothing when kanbo is on PATH', () => {
    writeFakeBin(bin, 'kanbo', '')
    expect(readLaunchWarning({ script: '/usr/local/lib/node_modules/kanbo-cli/dist/cli.cjs', env: { PATH: bin, npm_command: 'exec' } })).toBeNull()
  })
})
