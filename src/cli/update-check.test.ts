import type { SpawnSyncReturns } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createKanboMcpServer } from '../mcp/server'
import type { KanboToolTransport } from '../mcp/transport'
import { createPromptDriver } from '../testing/prompt-driver'
import { withUpdateNote } from './mcp-board'
import { runKanbo } from './program'
import { createUi, setUiForTests } from './ui/ui'
import type { UpdateInstaller } from './update-check'
import { isNewerVersion, LATEST_VERSION_URL, readInstallKind, startUpdateCheck } from './update-check'

/** npm answering with this `latest` version. */
function npmSays(version: string): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ name: 'kanbo-cli', version }), { status: 200 }))
}

/** npm never answering: the request ends only when it is aborted. */
function npmHangs(): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi.fn<typeof fetch>((_url, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
  }))
}

function succeeded(): SpawnSyncReturns<string> {
  return { pid: 1, output: [], stdout: '', stderr: '', status: 0, signal: null }
}

/** A program with one command that prints a line, as every kanbo command's output comes before the offer. */
function program(): Command {
  const created = new Command().name('kanbo').version('0.3.0').exitOverride().configureOutput({ writeOut: () => {}, writeErr: () => {} })
  created.command('hello').option('--json [fields]').option('--format <format>').action(() => console.log('hello output'))
  created.command('mcp').action(() => {})
  created.command('fail').action(() => {
    throw new Error('the command failed')
  })
  return created
}

describe('the update check on start', () => {
  let printed: string[]
  let errors: string[]

  beforeEach(() => {
    for (const name of ['CI', 'TERM', 'KANBO_ACTOR_KIND', 'KANBO_DEBUG']) {
      vi.stubEnv(name, undefined)
    }
    printed = []
    errors = []
    vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => void printed.push(values.map(String).join(' ')))
    vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => void errors.push(values.map(String).join(' ')))
  })

  afterEach(() => {
    setUiForTests(null)
    vi.useRealTimers()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  /** Nobody at a terminal: streams that are not one. */
  function withoutTerminal(): void {
    setUiForTests(createUi({ input: new PassThrough(), output: new PassThrough() }))
  }

  it('asks a person at a terminal after the output, and a yes runs the installer', async () => {
    const driver = createPromptDriver()
    setUiForTests(driver.ui)
    const fetch = npmSays('9.0.0')
    const install = vi.fn<UpdateInstaller>(succeeded)

    const running = runKanbo(['hello'], program, {}, { fetch, env: {}, currentVersion: '0.3.0', platform: 'linux', install })
    await driver.waitFor('kanbo 9.0.0 is available (you have 0.3.0). Update now?')
    expect(printed).toEqual(['hello output'])
    driver.press('up', 'enter')
    await running

    expect(fetch).toHaveBeenCalledWith(LATEST_VERSION_URL, expect.anything())
    expect(install).toHaveBeenCalledOnce()
    expect(printed).toEqual(['hello output', 'Updated to 9.0.0.'])
  })

  it('does nothing more when the person says no (the default)', async () => {
    const driver = createPromptDriver()
    setUiForTests(driver.ui)
    const install = vi.fn<UpdateInstaller>(succeeded)

    const running = runKanbo(['hello'], program, {}, { fetch: npmSays('9.0.0'), env: {}, currentVersion: '0.3.0', platform: 'linux', install })
    await driver.waitFor('Update now?')
    driver.press('enter')
    await running

    expect(install).not.toHaveBeenCalled()
    expect(printed).toEqual(['hello output'])
    expect(errors).toEqual([])
  })

  it('says what failed and the command to run when npm fails', async () => {
    const driver = createPromptDriver()
    setUiForTests(driver.ui)
    const install = vi.fn<UpdateInstaller>(() => ({ ...succeeded(), status: 243 }))

    const running = runKanbo(['hello'], program, {}, { fetch: npmSays('9.0.0'), env: {}, currentVersion: '0.3.0', platform: 'linux', install })
    await driver.waitFor('Update now?')
    driver.press('up', 'enter')
    await running

    expect(errors).toEqual(['kanbo was not updated: npm exited with code 243. Run it yourself: npm install -g kanbo-cli@latest'])
  })

  it('gives an agent\'s shell, or a shell with nobody to ask, one line on stderr', async () => {
    withoutTerminal()
    await runKanbo(['hello'], program, {}, { fetch: npmSays('9.0.0'), env: {}, currentVersion: '0.3.0', platform: 'linux' })
    expect(printed).toEqual(['hello output'])
    expect(errors).toEqual(['kanbo 9.0.0 is available (you have 0.3.0) — npm install -g kanbo-cli@latest'])

    errors = []
    setUiForTests(createPromptDriver().ui)
    vi.stubEnv('CLAUDECODE', '1')
    await runKanbo(['hello'], program, {}, { fetch: npmSays('9.0.0'), env: {}, currentVersion: '0.3.0', platform: 'linux' })
    expect(errors).toEqual(['kanbo 9.0.0 is available (running 0.3.0). Ask a person to update: npm install -g kanbo-cli@latest'])
  })

  it('tells a project\'s own install to update in the project, without asking or installing', async () => {
    const driver = createPromptDriver()
    setUiForTests(driver.ui)
    const install = vi.fn<UpdateInstaller>(succeeded)

    await runKanbo(['hello'], program, {}, { fetch: npmSays('9.0.0'), env: {}, currentVersion: '0.3.0', install, platform: 'linux', installKind: 'project' })

    expect(install).not.toHaveBeenCalled()
    expect(driver.transcript()).not.toContain('Update now?')
    expect(errors).toEqual(['kanbo 9.0.0 is available (you have 0.3.0). This project installs kanbo; update it here: npm install kanbo-cli@latest'])

    errors = []
    vi.stubEnv('CLAUDECODE', '1')
    await runKanbo(['hello'], program, {}, { fetch: npmSays('9.0.0'), env: {}, currentVersion: '0.3.0', install, platform: 'linux', installKind: 'project' })
    expect(errors).toEqual(['kanbo 9.0.0 is available (running 0.3.0). Ask a person to update: npm install kanbo-cli@latest'])
  })

  it('offers npx nothing to install, and says it takes the newest with @latest', async () => {
    const driver = createPromptDriver()
    setUiForTests(driver.ui)
    const install = vi.fn<UpdateInstaller>(succeeded)

    await runKanbo(['hello'], program, {}, { fetch: npmSays('9.0.0'), env: {}, currentVersion: '0.3.0', install, platform: 'linux', installKind: 'npx' })

    expect(install).not.toHaveBeenCalled()
    expect(driver.transcript()).not.toContain('Update now?')
    expect(errors).toEqual(['kanbo 9.0.0 is available (you have 0.3.0). npx runs the newest kanbo when you pass @latest: npx kanbo-cli@latest'])
  })

  it.each([
    ['CI', { CI: 'true' }, ['hello']],
    ['KANBO_NO_UPDATE_CHECK=1', { KANBO_NO_UPDATE_CHECK: '1' }, ['hello']],
    ['NO_UPDATE_NOTIFIER', { NO_UPDATE_NOTIFIER: '1' }, ['hello']],
    ['--json', {}, ['hello', '--json']],
    ['--json fields', {}, ['hello', '--json', 'id']],
    ['--format json', {}, ['hello', '--format', 'json']],
    ['--version', {}, ['--version']],
    ['--help', {}, ['hello', '--help']],
    ['kanbo mcp', {}, ['mcp']],
  ])('never asks npm with %s', async (_label, env: NodeJS.ProcessEnv, args) => {
    withoutTerminal()
    const fetch = npmSays('9.0.0')
    await runKanbo(args, program, {}, { fetch, env, currentVersion: '0.3.0', platform: 'linux' }).catch(() => {})
    expect(fetch).not.toHaveBeenCalled()
    expect(errors.join('\n')).not.toContain('is available')
  })

  it('asks npm with CI=0 or CI=false, which are not a CI run', async () => {
    withoutTerminal()
    for (const ci of ['0', 'false', '']) {
      const fetch = npmSays('0.3.0')
      await runKanbo(['hello'], program, {}, { fetch, env: { CI: ci }, currentVersion: '0.3.0', platform: 'linux' })
      expect(fetch, `CI=${ci}`).toHaveBeenCalledOnce()
    }
  })

  it('does not hold a finished command for more than ~300 ms when npm is slow, and stops asking', async () => {
    vi.useFakeTimers()
    withoutTerminal()
    const fetch = npmHangs()
    let done = false
    const running = runKanbo(['hello'], program, {}, { fetch, env: {}, currentVersion: '0.3.0', platform: 'linux' }).then(() => {
      done = true
    })

    await vi.advanceTimersByTimeAsync(299)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await running
    expect(done).toBe(true)
    expect((fetch.mock.calls[0]![1]!.signal as AbortSignal).aborted).toBe(true)
    expect(errors).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('says nothing when kanbo is as new as npm\'s latest, or newer', async () => {
    withoutTerminal()
    for (const latest of ['0.3.0', '0.2.9', '0.4.0-beta.1']) {
      await runKanbo(['hello'], program, {}, { fetch: npmSays(latest), env: {}, currentVersion: '0.3.0', platform: 'linux' })
    }
    expect(errors).toEqual([])
  })

  it('says nothing when npm cannot be reached, and says why only with KANBO_DEBUG=1', async () => {
    withoutTerminal()
    const offline = vi.fn<typeof fetch>(async () => {
      throw new TypeError('fetch failed')
    })
    await runKanbo(['hello'], program, {}, { fetch: offline, env: {}, currentVersion: '0.3.0', platform: 'linux' })
    await runKanbo(['hello'], program, {}, { fetch: vi.fn<typeof fetch>(async () => new Response('nope', { status: 503 })), env: {}, currentVersion: '0.3.0', platform: 'linux' })
    expect(printed).toEqual(['hello output', 'hello output'])
    expect(errors).toEqual([])

    await runKanbo(['hello'], program, {}, { fetch: offline, env: { KANBO_DEBUG: '1' }, currentVersion: '0.3.0', platform: 'linux' })
    expect(errors).toEqual(['kanbo: update check: fetch failed'])
  })

  it('ends a failing command with its own error and no offer, and stops asking npm at once — no request or timer left', async () => {
    vi.useFakeTimers()
    withoutTerminal()
    const fetch = npmHangs()

    const failure = await runKanbo(['fail'], program, {}, { fetch, env: {}, currentVersion: '0.3.0', platform: 'linux' }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    await vi.advanceTimersByTimeAsync(0)

    expect((fetch.mock.calls[0]![1]!.signal as AbortSignal).aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    expect(errors).toEqual([])
  })

  it('on Windows says how to update after closing kanbo, instead of asking, and installs nothing', async () => {
    const driver = createPromptDriver()
    setUiForTests(driver.ui)
    const install = vi.fn<UpdateInstaller>(succeeded)

    await runKanbo(['hello'], program, {}, { fetch: npmSays('9.0.0'), env: {}, currentVersion: '0.3.0', install, platform: 'win32' })

    expect(install).not.toHaveBeenCalled()
    expect(driver.transcript()).not.toContain('Update now?')
    expect(printed).toEqual(['hello output'])
    expect(errors).toEqual(['kanbo 9.0.0 is available (you have 0.3.0). Close kanbo and run: npm install -g kanbo-cli@latest'])
  })

  it.each([
    ['npm\'s own EACCES', { status: 243, stderr: 'npm error code EACCES\nnpm error syscall mkdir' }, 'npm exited with code 243'],
    ['npm\'s own EPERM', { status: 1, stderr: 'npm ERR! code EPERM' }, 'npm exited with code 1'],
    ['a refused start', { status: null, error: Object.assign(new Error('spawnSync npm EACCES'), { code: 'EACCES' }) }, 'spawnSync npm EACCES'],
  ])('points at npm\'s permissions guide when the install fails with %s', async (_label, outcome, why) => {
    const driver = createPromptDriver()
    setUiForTests(driver.ui)
    const install = vi.fn<UpdateInstaller>(() => ({ ...succeeded(), ...outcome }))

    const running = runKanbo(['hello'], program, {}, { fetch: npmSays('9.0.0'), env: {}, currentVersion: '0.3.0', install, platform: 'linux' })
    await driver.waitFor('Update now?')
    driver.press('up', 'enter')
    await running

    expect(errors).toEqual([
      `kanbo was not updated: ${why}. Run it yourself: npm install -g kanbo-cli@latest\n`
      + 'Your npm global folder needs permissions — see https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally',
    ])
  })
})

describe('readInstallKind', () => {
  let root: string

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'kanbo-install-kind-')))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  /** A file at `path` under the temporary root, with its folders. */
  function file(...path: string[]): string {
    const at = join(root, ...path)
    mkdirSync(dirname(at), { recursive: true })
    writeFileSync(at, '')
    return at
  }

  it('reads npm\'s npx cache as npx', () => {
    const script = file('cache', '_npx', 'abc', 'node_modules', 'kanbo-cli', 'dist', 'cli.cjs')
    expect(readInstallKind({ script, cwd: root, execPath: join(root, 'node', 'bin', 'node'), platform: 'linux' })).toBe('npx')
  })

  it('reads a node_modules/kanbo-cli of the current folder or one above it as the project\'s own', () => {
    const script = file('app', 'node_modules', 'kanbo-cli', 'dist', 'cli.cjs')
    mkdirSync(join(root, 'app', 'src', 'deep'), { recursive: true })
    const execPath = join(root, 'node', 'bin', 'node')

    expect(readInstallKind({ script, cwd: join(root, 'app'), execPath, platform: 'linux' })).toBe('project')
    expect(readInstallKind({ script, cwd: join(root, 'app', 'src', 'deep'), execPath, platform: 'linux' })).toBe('project')
    // Another project's install, run from outside it, is not this folder's.
    mkdirSync(join(root, 'elsewhere'))
    expect(readInstallKind({ script, cwd: join(root, 'elsewhere'), execPath, platform: 'linux' })).toBe('global')
  })

  it('reads the global node_modules under this Node\'s prefix as global, even from a folder under that prefix', () => {
    const script = file('node', 'lib', 'node_modules', 'kanbo-cli', 'dist', 'cli.cjs')
    const execPath = join(root, 'node', 'bin', 'node')

    expect(readInstallKind({ script, cwd: join(root, 'node', 'lib'), execPath, platform: 'linux' })).toBe('global')
    expect(readInstallKind({ script, cwd: root, execPath, platform: 'linux' })).toBe('global')
  })
})

describe('isNewerVersion', () => {
  it.each([
    ['0.3.1', '0.3.0', true],
    ['1.0.0', '0.9.9', true],
    ['0.10.0', '0.9.0', true],
    ['0.3.0', '0.3.0', false],
    ['0.2.9', '0.3.0', false],
    // A pre-release counts only for someone running one.
    ['0.4.0-rc.1', '0.3.0', false],
    ['0.3.0', '0.3.0-rc.1', true],
    ['0.3.0-rc.2', '0.3.0-rc.1', true],
    ['0.3.0-rc.10', '0.3.0-rc.9', true],
    ['0.3.0-rc.1', '0.3.0-rc.1', false],
    ['not a version', '0.3.0', false],
  ])('%s over %s: %s', (latest, current, newer) => {
    expect(isNewerVersion(latest, current)).toBe(newer)
  })
})

describe('kanbo mcp and a newer kanbo', () => {
  const board = {
    prime: async () => ({ text: 'Columns: To Do' }),
  } as unknown as KanboToolTransport

  async function primeText(transport: KanboToolTransport): Promise<string> {
    const server = createKanboMcpServer(transport, { includeRunTools: true })
    const [clientChannel, serverChannel] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'update-test', version: '0.0.0' })
    await Promise.all([client.connect(clientChannel), server.connect(serverChannel)])
    try {
      const result = await client.callTool({ name: 'kanbo_prime', arguments: {} })
      return (result.content as { text: string }[]).map(part => part.text).join('\n')
    }
    finally {
      await client.close()
    }
  }

  it('ends kanbo_prime with one line asking for a person to update, once npm has said so', async () => {
    const check = startUpdateCheck({ fetch: npmSays('9.0.0'), env: {}, currentVersion: '0.3.0' })
    await check.settle(1_000)
    expect(await primeText(withUpdateNote(board, check.peek))).toBe(
      'Columns: To Do\n\nNote: kanbo 9.0.0 is available (running 0.3.0). Ask a person to update: npm install -g kanbo-cli@latest',
    )
  })

  it('leaves kanbo_prime as it is when there is nothing newer', async () => {
    const check = startUpdateCheck({ fetch: npmSays('0.3.0'), env: {}, currentVersion: '0.3.0' })
    await check.settle(1_000)
    expect(await primeText(withUpdateNote(board, check.peek))).toBe('Columns: To Do')
  })
})
