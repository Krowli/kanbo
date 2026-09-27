import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

import { describe, expect, it } from 'vitest'

import { SUPPORTED_NODE_RANGE, unsupportedNodeMessage } from './node-version'

/**
 * `dist/cli.cjs` is `launcher.cjs` copied in: the one file an old Node has to
 * be able to parse, so it can say which Node kanbo needs.
 */
const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, 'launcher.cjs'), 'utf8')
const body = source.replace(/^#!.*\n/, '')
const engines = (JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf8')) as { engines: { node: string } }).engines.node

/** Run the launcher as a Node of this version would, with `require` recorded instead of followed. */
function launch(version: string): { errors: string[], exitCode: number | null, required: string[] } {
  const errors: string[] = []
  const required: string[] = []
  let exitCode: number | null = null
  runInNewContext(body, {
    process: { versions: { node: version }, exit: (code: number) => { exitCode = code } },
    console: { error: (line: string) => errors.push(line) },
    require: (id: string) => required.push(id),
  })
  return { errors, exitCode, required }
}

describe('the kanbo launcher', () => {
  it('uses no syntax newer than ES5, so any Node can parse it', () => {
    const code = body.replace(/\/\/.*$/gm, '').replace(/'(?:[^'\\]|\\.)*'/g, '\'\'')
    for (const token of ['??', '?.', '=>', '`', 'const ', 'let ', 'class ', 'async ', '...']) {
      expect(code, token).not.toContain(token)
    }
    expect(() => new Function(body)).not.toThrow()
  })

  it('checks the range engines names', () => {
    expect(SUPPORTED_NODE_RANGE).toBe(engines)
    expect(source).toContain(`var SUPPORTED_NODE_RANGE = '${engines}'`)
  })

  it('on an old Node says which one it needs and starts nothing', () => {
    const { errors, exitCode, required } = launch('16.20.2')

    expect(errors).toEqual([unsupportedNodeMessage('16.20.2')])
    expect(exitCode).toBe(1)
    expect(required).toEqual([])
  })

  it('on a supported Node starts the command', () => {
    expect(launch('22.19.0')).toEqual({ errors: [], exitCode: null, required: ['./cli-main.cjs'] })
    expect(launch('24.11.0').required).toEqual(['./cli-main.cjs'])
  })
})
