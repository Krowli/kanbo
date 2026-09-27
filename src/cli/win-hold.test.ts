import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { describe, expect, it } from 'vitest'

import { openBoardDatabase } from '../sqlite/open-database'
import { writeFakeBin } from '../testing/fake-bin'

// Temporary: which step leaves a folder Windows will not remove.
function tryRemove(path: string): string {
  try {
    rmSync(path, { recursive: true, force: true })
    return 'removed'
  }
  catch (error) {
    return (error as Error).message
  }
}

describe.runIf(process.platform === 'win32')('what holds a folder on Windows', () => {
  it('a sqlite file opened and closed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hold-sqlite-'))
    const board = await openBoardDatabase(join(root, 'board.db'))
    board.close()
    console.log('HOLD sqlite-file:', tryRemove(root))
  })

  it('sqlite in memory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hold-memory-'))
    ;(await openBoardDatabase(':memory:')).close()
    console.log('HOLD sqlite-memory:', tryRemove(root))
  })

  for (const via of ['cmd', 'node'] as const) {
    it(`a handshake started in it, via ${via}, that exits at once`, async () => {
      const root = mkdtempSync(join(tmpdir(), `hold-${via}-`))
      const project = join(root, 'project')
      mkdirSync(project)
      const shim = writeFakeBin(root, 'kanbo', 'process.exit(1)')
      const command = via === 'cmd' ? shim : process.execPath
      const args = via === 'cmd' ? ['mcp'] : [join(root, 'kanbo.js'), 'mcp']
      const transport = new StdioClientTransport({ command, args, cwd: project, stderr: 'pipe' })
      const client = new Client({ name: 'hold', version: '0' })
      try {
        await client.connect(transport, { timeout: 5000 })
      }
      catch (error) {
        console.log(`HOLD ${via} connect:`, (error as Error).message)
      }
      finally {
        await client.close().catch(() => {})
      }
      console.log(`HOLD ${via} pid ${transport.pid} project:`, tryRemove(project))
      await new Promise(resolve => setTimeout(resolve, 2000))
      console.log(`HOLD ${via} project after 2s:`, tryRemove(project))
      console.log(`HOLD ${via} root:`, tryRemove(root))
      expect(true).toBe(true)
    }, 30_000)
  }
})
