import { describe, expect, it } from 'vitest'

import type { BrowserEnvironment } from './access'
import { chooseBrowserLauncher } from './access'

const LINK = 'http://127.0.0.1:4318/#token=a&b^c'
const LINUX_VERSION = 'Linux version 6.8.0-45-generic (buildd@lcy02-amd64-075) (gcc 13.2.0)'
const WSL_VERSION = 'Linux version 5.15.153.1-microsoft-standard-WSL2 (root@941d701f84f1) (gcc 11.2.0)'

function linux(environment: Partial<BrowserEnvironment> & { procVersion?: string, onPath?: string[] }): BrowserEnvironment {
  return {
    platform: 'linux',
    env: {},
    readFile: path => (path === '/proc/version' ? environment.procVersion ?? LINUX_VERSION : null),
    findOnPath: command => (environment.onPath?.includes(command) ? `/usr/bin/${command}` : null),
    ...environment,
  }
}

describe('opening the board page in a browser', () => {
  it('uses open on macOS', () => {
    expect(chooseBrowserLauncher(LINK, { platform: 'darwin', env: {} })).toEqual({ command: 'open', args: [LINK] })
  })

  it('hands Windows the link as one argument, past no cmd parsing', () => {
    expect(chooseBrowserLauncher(LINK, { platform: 'win32', env: {} }))
      .toEqual({ command: 'rundll32', args: ['url.dll,FileProtocolHandler', LINK] })
  })

  it('uses xdg-open on a Linux desktop, X11 or Wayland', () => {
    expect(chooseBrowserLauncher(LINK, linux({ env: { DISPLAY: ':0' } }))).toEqual({ command: 'xdg-open', args: [LINK] })
    expect(chooseBrowserLauncher(LINK, linux({ env: { WAYLAND_DISPLAY: 'wayland-0' } }))).toEqual({ command: 'xdg-open', args: [LINK] })
  })

  it('does not try on a Linux machine without a display: the printed link is enough', () => {
    expect(chooseBrowserLauncher(LINK, linux({ env: {}, onPath: ['xdg-open'] }))).toBeNull()
  })

  it('opens Windows\' browser from WSL: wslview when it is there, else cmd.exe', () => {
    expect(chooseBrowserLauncher(LINK, linux({ procVersion: WSL_VERSION, onPath: ['wslview'] })))
      .toEqual({ command: 'wslview', args: [LINK] })
    expect(chooseBrowserLauncher(LINK, linux({ procVersion: WSL_VERSION })))
      .toEqual({ command: 'cmd.exe', args: ['/c', 'start', '""', LINK] })
  })
})
