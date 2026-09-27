import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { writeBinding } from '../binding'
import { withFsRetry } from './fs-retry'

/** `renameSync` failing the way Windows fails it while another process holds the file. */
const renames = vi.hoisted(() => ({ busy: 0, calls: 0 }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    renameSync: (from: string, to: string) => {
      renames.calls += 1
      if (renames.busy > 0) {
        renames.busy -= 1
        throw Object.assign(new Error(`EBUSY: resource busy or locked, rename '${from}'`), { code: 'EBUSY' })
      }
      actual.renameSync(from, to)
    },
  }
})

function failure(code: string): Error {
  return Object.assign(new Error(code), { code })
}

describe('file operations while something else holds the file', () => {
  let projectDir: string

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'kanbo-retry-'))
    renames.busy = 0
    renames.calls = 0
  })

  afterEach(() => {
    rmSync(projectDir, { force: true, recursive: true })
  })

  it('writes the binding when the rename is refused twice with EBUSY', () => {
    renames.busy = 2

    const path = writeBinding(projectDir, { schemaVersion: 1, workspaceId: 'w', boardId: null, dbPath: null })

    expect(renames.calls).toBe(3)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ workspaceId: 'w' })
  })

  it('gives up after 8 tries, and does not wait on a real permission error off Windows', () => {
    const always = vi.fn(() => {
      throw failure('EBUSY')
    })
    expect(() => withFsRetry(always, 'linux')).toThrowError('EBUSY')
    expect(always).toHaveBeenCalledTimes(8)

    const denied = vi.fn(() => {
      throw failure('EPERM')
    })
    expect(() => withFsRetry(denied, 'linux')).toThrowError('EPERM')
    expect(denied).toHaveBeenCalledTimes(1)
  })

  it('tries EPERM and EACCES again on Windows', () => {
    let failures = ['EPERM', 'EACCES']
    const operation = vi.fn(() => {
      const [next, ...rest] = failures
      failures = rest
      if (next) {
        throw failure(next)
      }
      return 'done'
    })

    expect(withFsRetry(operation, 'win32')).toBe('done')
    expect(operation).toHaveBeenCalledTimes(3)
  })
})
