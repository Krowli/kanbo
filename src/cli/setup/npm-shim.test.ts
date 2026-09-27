import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { parseShimTarget, resolveShimTarget } from './npm-shim'

/** The `.cmd` shim npm writes for a global `kanbo` on Windows. */
const CMD_SHIM = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  '',
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ') ELSE (',
  '  SET "_prog=node"',
  '  SET PATHEXT=%PATHEXT:;.JS;=;%',
  ')',
  '',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\kanbo-cli\\dist\\cli.cjs" %*',
  '',
].join('\r\n')

/** The `.ps1` shim beside it. */
const PS1_SHIM = [
  '#!/usr/bin/env pwsh',
  '$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent',
  '',
  '$exe=""',
  'if ($PSVersionTable.PSVersion -lt "6.0" -or $IsWindows) {',
  '  $exe=".exe"',
  '}',
  '$ret=0',
  'if (Test-Path "$basedir/node$exe") {',
  '  if ($MyInvocation.ExpectingInput) {',
  '    $input | & "$basedir/node$exe"  "$basedir/node_modules/kanbo-cli/dist/cli.cjs" $args',
  '  } else {',
  '    & "$basedir/node$exe"  "$basedir/node_modules/kanbo-cli/dist/cli.cjs" $args',
  '  }',
  '  $ret=$LASTEXITCODE',
  '}',
  'exit $ret',
].join('\n')

describe('npm shims', () => {
  it('reads the script a .cmd and a .ps1 shim start, skipping the node.exe they prefer', () => {
    expect(parseShimTarget(CMD_SHIM)).toBe('node_modules\\kanbo-cli\\dist\\cli.cjs')
    expect(parseShimTarget(PS1_SHIM)).toBe('node_modules/kanbo-cli/dist/cli.cjs')
    expect(parseShimTarget('@echo off\r\nexit 1\r\n')).toBeNull()
  })

  it('resolves the script next to the shim, and leaves anything else as it is', () => {
    const directory = mkdtempSync(join(tmpdir(), 'kanbo-shim-'))
    try {
      writeFileSync(join(directory, 'kanbo.cmd'), CMD_SHIM)
      writeFileSync(join(directory, 'kanbo.ps1'), PS1_SHIM)
      const script = join(directory, 'node_modules', 'kanbo-cli', 'dist', 'cli.cjs')

      expect(resolveShimTarget(join(directory, 'kanbo.cmd'))).toBe(script)
      expect(resolveShimTarget(join(directory, 'kanbo.ps1'))).toBe(script)
      expect(resolveShimTarget(join(directory, 'kanbo'))).toBe(join(directory, 'kanbo'))
    }
    finally {
      rmSync(directory, { force: true, recursive: true })
    }
  })
})
