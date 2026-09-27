import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'

import { Command } from 'commander'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { writeFakeBin } from '../testing/fake-bin'
import { registerInitCommand } from './commands/init'
import { collectDoctorFindings } from './doctor'

// Temporary: which step of kanbo doctor leaves a folder Windows will not remove.
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
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  for (const variant of ['no-kanbo', 'fake-kanbo', 'no-cwd-mock'] as const) {
    it(`doctor, ${variant}`, async () => {
      const root = mkdtempSync(join(tmpdir(), `hold-${variant}-`))
      const bin = join(root, 'bin')
      const projectDir = join(root, 'project')
      for (const directory of [bin, projectDir, join(root, 'home')]) {
        mkdirSync(directory, { recursive: true })
      }
      vi.stubEnv('HOME', join(root, 'home'))
      vi.stubEnv('USERPROFILE', join(root, 'home'))
      vi.stubEnv('CODEX_HOME', join(root, 'codex-home'))
      vi.stubEnv('PATH', [bin, dirname(process.execPath)].join(delimiter))
      const cwd = vi.spyOn(process, 'cwd').mockReturnValue(projectDir)
      vi.spyOn(console, 'log').mockImplementation(() => {})
      const program = new Command().exitOverride()
      registerInitCommand(program)
      await program.parseAsync(['init', '--file', '--instructions', 'claude', '--mcp', 'claude,codex,cursor', '--yes'], { from: 'user' })
      console.warn(`HOLD ${variant} after init:`, tryRemove(join(root, 'home', 'nothing')))
      if (variant !== 'no-kanbo') {
        writeFakeBin(bin, 'kanbo', 'process.exit(1)')
      }
      if (variant === 'no-cwd-mock') {
        cwd.mockRestore()
      }
      const findings = await collectDoctorFindings({ cwd: projectDir, self: null, handshakeTimeoutMs: 5000 })
      console.warn(`HOLD ${variant} findings:`, findings.map(finding => `${finding.check}=${finding.status}`).join(' '))
      console.warn(`HOLD ${variant} project:`, tryRemove(projectDir))
      await new Promise(resolve => setTimeout(resolve, 2000))
      console.warn(`HOLD ${variant} project after 2s:`, tryRemove(projectDir))
      console.warn(`HOLD ${variant} root:`, tryRemove(root))
      expect(true).toBe(true)
    }, 30_000)
  }
})
