import { describe, expect, it } from 'vitest'

import type { ClipboardEnvironment, ClipboardRunner } from './clipboard'
import { copyToClipboard, osc52 } from './clipboard'
import { runWithInput } from './process'

/** A runner that says yes only to the programs named, and remembers every call. */
function runner(installed: string[]): { run: ClipboardRunner, calls: { command: string, args: readonly string[], detached?: boolean, input: Uint8Array }[] } {
  const calls: { command: string, args: readonly string[], detached?: boolean, input: Uint8Array }[] = []
  return {
    calls,
    run: async (command, args, input, options) => {
      calls.push({ command, args, detached: options.detached, input })
      return installed.includes(command)
    },
  }
}

/** A stderr that records what was written to it. */
function stderr(isTTY: boolean): { isTTY: boolean, written: string[], write: (chunk: string) => boolean } {
  const written: string[] = []
  return { isTTY, written, write: (chunk) => {
    written.push(chunk)
    return true
  } }
}

function linux(env: NodeJS.ProcessEnv, overrides: Partial<ClipboardEnvironment> = {}): ClipboardEnvironment {
  return { platform: 'linux', env, readFile: () => 'Linux version 6.8.0-generic', ...overrides }
}

describe('copyToClipboard', () => {
  it('uses clip.exe with UTF-16LE and a byte-order mark under WSL', async () => {
    const { run, calls } = runner(['clip.exe'])

    const outcome = await copyToClipboard('é—x', linux({}, { readFile: () => 'Linux version 5.15.90.1-microsoft-standard-WSL2', run }))

    expect(outcome).toBe('copied')
    expect(calls.map(call => call.command)).toEqual(['clip.exe'])
    expect(Buffer.from(calls[0]!.input).equals(Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from('é—x', 'utf16le')]))).toBe(true)
  })

  it('uses wl-copy under Wayland', async () => {
    const { run, calls } = runner(['wl-copy'])

    expect(await copyToClipboard('text', linux({ WAYLAND_DISPLAY: 'wayland-0' }, { run }))).toBe('copied')
    expect(calls.map(call => call.command)).toEqual(['wl-copy'])
  })

  it('uses xclip detached under X11, and xsel when xclip is missing', async () => {
    const { run, calls } = runner(['xsel'])

    expect(await copyToClipboard('text', linux({ DISPLAY: ':0' }, { run }))).toBe('copied')
    expect(calls).toMatchObject([
      { command: 'xclip', args: ['-selection', 'clipboard'], detached: true },
      { command: 'xsel', args: ['--clipboard', '--input'] },
    ])
    expect(Buffer.from(calls[1]!.input).toString('utf8')).toBe('text')
  })

  it('sends OSC 52 to a terminal stderr over SSH when there is no clipboard program', async () => {
    const { run } = runner([])
    const err = stderr(true)

    const outcome = await copyToClipboard('hello', linux({ SSH_TTY: '/dev/pts/0' }, { run, stderr: err }))

    expect(outcome).toBe('osc52')
    expect(err.written).toEqual([osc52('hello')])
    expect(osc52('hello')).toBe(`\u001B]52;c;${Buffer.from('hello').toString('base64')}\u0007`)
  })

  it('sends nothing over SSH when stderr is not a terminal', async () => {
    const err = stderr(false)

    expect(await copyToClipboard('hello', linux({ SSH_CONNECTION: '1 2 3 4' }, { run: runner([]).run, stderr: err }))).toBe('unavailable')
    expect(err.written).toEqual([])
  })

  it('is unavailable on Linux with no display and no SSH', async () => {
    const { run, calls } = runner(['xclip', 'wl-copy'])

    expect(await copyToClipboard('text', linux({}, { run, stderr: stderr(true) }))).toBe('unavailable')
    expect(calls).toEqual([])
  })
})

describe('runWithInput', () => {
  const echoBack = 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.exit(s==="hi"?0:3))'

  it('hands the input to the program and says whether it exited 0', async () => {
    expect(await runWithInput(process.execPath, ['-e', echoBack], Buffer.from('hi'), { timeoutMs: 10_000 })).toBe(true)
    expect(await runWithInput(process.execPath, ['-e', echoBack], Buffer.from('no'), { timeoutMs: 10_000 })).toBe(false)
  })

  it('is false for a program that is not installed, and for one that outlives the timeout', async () => {
    expect(await runWithInput('kanbo-no-such-clipboard-program', [], Buffer.from('x'), { timeoutMs: 10_000 })).toBe(false)
    expect(await runWithInput(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], Buffer.from('x'), { timeoutMs: 300 })).toBe(false)
  })
})
