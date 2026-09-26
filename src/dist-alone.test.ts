import { execFileSync, spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * The desktop app ships `dist/` alone, with no `package.json` beside or above
 * it. A built `kanbo` that reads anything from the package root at start-up
 * dies on every command there — which is how this was found: a packaged app
 * whose `kanbo --version` threw ENOENT. So the binary is copied on its own
 * into a temporary directory and run from there.
 */

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(packageRoot, 'dist')
const built = existsSync(join(dist, 'cli.cjs'))
const packageVersion = (JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as { version: string }).version

let copy = ''

beforeAll(() => {
  if (!built) {
    return
  }
  copy = mkdtempSync(join(tmpdir(), 'kanbo-dist-alone-'))
  cpSync(dist, join(copy, 'dist'), { recursive: true })
})

afterAll(() => {
  if (copy) {
    rmSync(copy, { recursive: true, force: true })
  }
})

/**
 * The environment a copied binary runs in: none of this shell's board or agent
 * variables, and `better-sqlite3` found the way the packaged app's shim finds
 * it — on `NODE_PATH`, never beside `dist/`.
 */
function copiedEnvironment(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('KANBO_')))
  return { ...env, NODE_PATH: join(packageRoot, 'node_modules') }
}

function runCopied(args: string[], cwd?: string): string {
  return execFileSync(process.execPath, [join(copy, 'dist', 'cli.cjs'), ...args], {
    cwd,
    env: copiedEnvironment(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

describe.skipIf(!built)('the kanbo binary copied without its package', () => {
  it('prints the version it was built with', () => {
    expect(runCopied(['--version']).trim()).toBe(packageVersion)
  })

  it('serves the capabilities manifest with that version', () => {
    const manifest = JSON.parse(runCopied(['capabilities', '--json'])) as { package: { version: string } }
    expect(manifest.package.version).toBe(packageVersion)
  })

  it('serves the board page and its built assets', async () => {
    const project = join(copy, 'project')
    mkdirSync(project)
    runCopied(['init', '--file', '--yes', '--instructions', 'none'], project)
    const server = spawn(process.execPath, [join(copy, 'dist', 'cli.cjs'), 'serve', '--port', '0'], {
      cwd: project,
      env: { ...copiedEnvironment(), KANBO_SERVE_TOKEN: 'dist-alone-token' },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    try {
      const url = await new Promise<string>((resolve, reject) => {
        let stderr = ''
        server.stderr.setEncoding('utf8')
        server.stderr.on('data', (chunk: string) => {
          stderr += chunk
          const started = /kanbo serve: (http:\/\/\S+)/.exec(stderr)
          if (started) {
            resolve(started[1])
          }
        })
        server.once('exit', code => reject(new Error(`kanbo serve exited with ${code}: ${stderr}`)))
      })

      const page = await fetch(`${url}/`)
      expect(page.status).toBe(200)
      expect(await page.text()).toContain('/assets/board.js')
      const script = await fetch(`${url}/assets/board.js`)
      expect(script.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
      expect(await script.text()).toContain('/issues/version')
      const stylesheet = await fetch(`${url}/assets/board.css`)
      expect(stylesheet.headers.get('content-type')).toBe('text/css; charset=utf-8')
      expect(await stylesheet.text()).toContain('.card')
    }
    finally {
      server.kill()
    }
  })
})
