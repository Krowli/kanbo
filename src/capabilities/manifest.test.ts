import { Command } from 'commander'
import { describe, expect, it } from 'vitest'

import { HUMAN_ONLY_ACTIONS } from '../cli/actor'
import { registerKanboCommands } from '../cli/commands'
import { CLI_EXIT_CODES } from '../cli/output'
import { ENTRY_RULES } from '../domain/entry-rules'
import { KANBO_TOOL_NAMES } from '../mcp/tool-names'
import { APPROVED_COMMENT } from '../ops/approval'
import { RETURNED_STATUS_LINE_PREFIX } from '../ops/cards'
import { BOARD_RULES } from '../ops/prime'
import {
  LAUNCHED_STATUS_LINE_PREFIX,
  NO_REPORT_STATUS_LINE,
  RUN_FAILED_COMMENT,
  RUN_FAILED_COMMENT_PREFIX,
  RUN_FINISHED_COMMENT,
  RUN_STARTED_COMMENT_PREFIX,
  RUN_STOPPED_BY_YOU_COMMENT,
  RUN_STOPPED_COMMENT,
  RUN_STOPPED_REASON_PREFIX,
  STOPPED_BY_YOU_STATUS_LINE,
} from '../ops/runs'
import { KANBO_PACKAGE_VERSION } from '../package-version'
import { AGENT_APPROVAL_COMMENT_REFUSAL, AGENT_WAITING_REFUSAL } from '../postgres/roles.sql'
import { buildCapabilitiesManifest } from './manifest'

/**
 * The manifest promises never to name a tool, a command or a canonical string
 * this file did not already know about somewhere else in the package — every
 * check below reads the same source `buildCapabilitiesManifest` does, walked a
 * second time, so a source that gains something and a manifest that does not
 * both fail here rather than drifting apart silently.
 */

/** The leaf command paths the binary answers to — the same walk `mcp/docs.test.ts` runs, kept local on purpose: it is a second, independent read of `registerKanboCommands`, not a copy of the manifest's own walk. */
function registeredCommandPaths(): string[] {
  const program = new Command()
  registerKanboCommands(program)

  function walk(command: Command, prefix: string[]): string[] {
    return command.commands.flatMap((child) => {
      const path = [...prefix, child.name()]
      return child.commands.length > 0 ? walk(child, path) : [path.join(' ')]
    })
  }

  return walk(program, [])
}

/**
 * A second, hand-written list of the same constants `manifest.ts` reads —
 * this file's edge, not just the manifest's: it catches a canonical string
 * that is on the manifest but drifted from its own constant, or the reverse,
 * because both lists have to be edited to agree. It cannot catch a *new*
 * canonical string constant added somewhere under `ops/` that neither this
 * list nor the manifest was told about — that one carries no failing test
 * until whoever adds it also adds it here.
 */
const CANONICAL_STRINGS = {
  launched: LAUNCHED_STATUS_LINE_PREFIX,
  stoppedByYou: STOPPED_BY_YOU_STATUS_LINE,
  returned: RETURNED_STATUS_LINE_PREFIX,
  noReport: NO_REPORT_STATUS_LINE,
  runStarted: RUN_STARTED_COMMENT_PREFIX,
  runFinished: RUN_FINISHED_COMMENT,
  runFailed: RUN_FAILED_COMMENT,
  runFailedReason: RUN_FAILED_COMMENT_PREFIX,
  runStoppedByYou: RUN_STOPPED_BY_YOU_COMMENT,
  runStopped: RUN_STOPPED_COMMENT,
  runStoppedReason: RUN_STOPPED_REASON_PREFIX,
  approved: APPROVED_COMMENT,
}

describe('buildCapabilitiesManifest', () => {
  const manifest = buildCapabilitiesManifest()

  it('names the package this build is, at the version package.json carries — the one place that version is written', () => {
    expect(manifest.package.name).toBe('kanbo')
    expect(manifest.package.version).toBe(KANBO_PACKAGE_VERSION)
  })

  it.each(KANBO_TOOL_NAMES)('carries %s, with a JSON Schema and a CLI equivalent', (name) => {
    const tool = manifest.tools.find(candidate => candidate.name === name)
    expect(tool, `${name} is missing from the manifest`).toBeDefined()
    expect(tool!.inputSchema).toMatchObject({ type: 'object' })
    expect(tool!.cli.kanbo.startsWith('kanbo ')).toBe(true)
  })

  it('carries no tool the board does not have', () => {
    expect(manifest.tools.map(tool => tool.name).sort()).toEqual([...KANBO_TOOL_NAMES].sort())
  })

  it.each(registeredCommandPaths())('gives `kanbo %s` a row', (path) => {
    expect(manifest.commands.some(command => command.path === path), `${path} is missing from the manifest`).toBe(true)
  })

  it('carries no command the binary does not answer to', () => {
    expect(manifest.commands.map(command => command.path).sort()).toEqual(registeredCommandPaths().sort())
  })

  it.each(HUMAN_ONLY_ACTIONS)('marks %s as a person\'s command', (action) => {
    const command = manifest.commands.find(candidate => candidate.path === action)
    expect(command?.humanOnly, `${action} should be humanOnly`).toBe(true)
  })

  it('lists every column entry rule the board can check, each described', () => {
    expect(manifest.entryRules.map(entry => entry.rule)).toEqual([...ENTRY_RULES])
    for (const entry of manifest.entryRules) {
      expect(entry.description).not.toBe('')
    }
  })

  it('marks nothing else humanOnly', () => {
    const humanOnly = manifest.commands.filter(command => command.humanOnly).map(command => command.path)
    expect(humanOnly.sort()).toEqual([...HUMAN_ONLY_ACTIONS].sort())
  })

  it('attaches every promised exit code to every command', () => {
    for (const command of manifest.commands) {
      expect(command.exitCodes).toBe(CLI_EXIT_CODES)
    }
  })

  it('states every board rule prime does, and nothing it does not', () => {
    expect(manifest.rules).toEqual(BOARD_RULES)
  })

  it.each(Object.entries(CANONICAL_STRINGS))('carries the canonical string %s from its own constant', (name, value) => {
    expect(manifest.canonicalStrings[name], `${name} is missing from the manifest`).toBe(value)
  })

  it('carries no canonical string this file does not also know about', () => {
    expect(Object.keys(manifest.canonicalStrings).sort()).toEqual(Object.keys(CANONICAL_STRINGS).sort())
  })

  it('states the roles and refusals the database itself enforces', () => {
    expect(manifest.roles.person).toBe('kanban_person')
    expect(manifest.roles.agent).toBe('kanban_agent')
    expect(manifest.roles.refusals).toEqual([AGENT_WAITING_REFUSAL, AGENT_APPROVAL_COMMENT_REFUSAL])
  })

  it('names all three storages', () => {
    expect(manifest.storages.map(storage => storage.kind).sort()).toEqual(['host-file', 'own-file', 'postgres'])
  })

  it('states at least one limit', () => {
    expect(manifest.limits.length).toBeGreaterThan(0)
  })
})
