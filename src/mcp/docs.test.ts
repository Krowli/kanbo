/**
 * The reference docs are where an agent is told what the board can be asked to
 * do, and their two lists are the part that has to stay complete: a tool the
 * package publishes and `docs/mcp.md` never names is a tool only this directory
 * knows exists, and the same goes for a command the `kanbo` binary answers to
 * and `docs/cli.md`. Both
 * checks are on the tables rather than on the prose, because a row is where a
 * tool or a command gets its meaning and the other way of doing the same thing.
 *
 * Neither list is written out here. The tools come from `tool-names.ts` and the
 * commands from `registerKanboCommands` — the function the binary itself calls,
 * not a copy of it — so a command added to the binary is a failing test until
 * the docs have a row for it.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Command } from 'commander'
import { describe, expect, it } from 'vitest'

import { HUMAN_ONLY_ACTIONS } from '../cli/actor'
import { registerKanboCommands } from '../cli/commands'
import { NO_BOARD_AGENT_FIRST_LINE, NO_BOARD_HINT } from '../cli/home'
import { ORCHESTRATOR_GUIDE } from '../cli/setup/orchestrator-guide'
import { KANBO_TOOL_NAMES } from './tool-names'

const DOCS_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs')

/**
 * The first cell of a table row, or nothing when the line is not one.
 *
 * The split is on a pipe that is not escaped: a command's own `\|` — the way a
 * row writes `--state finished\|failed\|stopped` — is part of the cell and not
 * the end of it.
 */
function firstCell(line: string): string | null {
  if (!line.startsWith('|')) {
    return null
  }
  return line.split(/(?<!\\)\|/)[1] ?? ''
}

/**
 * The tools a doc documents, read out of the first cell of its table rows.
 *
 * Only the first cell counts: a name in prose, or in the column beside one, is
 * a mention rather than the row that says what the tool is for.
 */
function readDocumentedToolNames(doc: string): Set<string> {
  const documented = new Set<string>()
  for (const line of doc.split('\n')) {
    const cell = firstCell(line)
    if (cell === null) {
      continue
    }
    for (const match of cell.matchAll(/`(kanbo_[a-z_]+)`/g)) {
      documented.add(match[1]!)
    }
  }
  return documented
}

/**
 * Every command the binary answers to, as a person types it — `card move`,
 * `roles apply` — taken from the registrations rather than from a list, which
 * is what makes this a check and not a second copy of the same list.
 *
 * A command with subcommands is not itself one: `kanbo card` on its own prints
 * usage, and it is the leaves that do something.
 */
function registeredCommandPaths(): string[] {
  const program = new Command()
  // The binary's own registration, not a copy of it: `cli/program.ts` calls this
  // same function, so a command added there is a command this walk finds.
  registerKanboCommands(program)

  function walk(command: Command, prefix: string[]): string[] {
    return command.commands.flatMap((child) => {
      const path = [...prefix, child.name()]
      return child.commands.length > 0 ? walk(child, path) : [path.join(' ')]
    })
  }

  return walk(program, []).sort()
}

/**
 * The command spellings a doc's tables give, with the `kanbo` in front of
 * them dropped: a row names several spellings of one command group, and only
 * the first of them repeats the binary's name.
 */
function readDocumentedCommands(doc: string): string[] {
  const documented: string[] = []
  for (const line of doc.split('\n')) {
    const cell = firstCell(line)
    if (cell === null) {
      continue
    }
    for (const match of cell.matchAll(/`([^`]+)`/g)) {
      documented.push(match[1]!.replace(/^kanbo /, ''))
    }
  }
  return documented
}

describe('the reference docs', () => {
  const documented = readDocumentedToolNames(readFileSync(join(DOCS_DIRECTORY, 'mcp.md'), 'utf8'))
  const documentedCommands = readDocumentedCommands(readFileSync(join(DOCS_DIRECTORY, 'cli.md'), 'utf8'))

  it.each(KANBO_TOOL_NAMES)('gives %s a row of its own', (name) => {
    expect(documented, `${name} has no row in a docs/mcp.md table`).toContain(name)
  })

  it.each(registeredCommandPaths())('gives `kanbo %s` a row of its own', (path) => {
    // The spelling in the table carries the command's arguments after it, so a
    // row matches when it starts with the command and stops being the command
    // there — `card list …` documents `card list`, and `card list-runs` would
    // not.
    const row = documentedCommands.some(spelling => spelling === path || spelling.startsWith(`${path} `))
    expect(row, `kanbo ${path} has no row in the docs/cli.md command table`).toBe(true)
  })

  it('gives bare `kanbo` a row, and shows what it prints without a terminal word for word', () => {
    const cli = readFileSync(join(DOCS_DIRECTORY, 'cli.md'), 'utf8')
    expect(documentedCommands).toContain('kanbo')
    for (const line of [...NO_BOARD_HINT, NO_BOARD_AGENT_FIRST_LINE]) {
      expect(cli).toContain(line)
    }
    // Not "always 0": leaving the wizard without writing is exit 1.
    const row = cli.split('\n').find(line => line.startsWith('| `kanbo` |'))!
    expect(row).toContain('Exits `0` after the hint, and when you leave the home screen (Exit, or Ctrl-C at the menu)')
    expect(row).toContain('in the wizard, Ctrl-C at any question or No at the last one ("Write these changes?") exits `1`')
  })
})

describe('docs/orchestrator.md', () => {
  it('shows the orchestrator instruction file word for word, as `kanbo instructions orchestrator` prints it', () => {
    const doc = readFileSync(join(DOCS_DIRECTORY, 'orchestrator.md'), 'utf8').replace(/\r\n/g, '\n')
    expect(doc).toContain(`\`\`\`markdown\n${ORCHESTRATOR_GUIDE}\n\`\`\`\n`)
  })

  it('names every command only a person may run, so an orchestrator never tries one', () => {
    for (const action of HUMAN_ONLY_ACTIONS) {
      expect(ORCHESTRATOR_GUIDE, action).toContain(`\`kanbo ${action}\``)
    }
  })

  it('names no column but To Do by its slug: a board\'s other columns are its own, and kanbo prime says what they are', () => {
    for (const slug of ['backlog', 'in_progress', 'in_review', 'done', 'canceled']) {
      expect(ORCHESTRATOR_GUIDE, slug).not.toMatch(new RegExp(`\`${slug}\``))
    }
  })
})
