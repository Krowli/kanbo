import type { Command } from 'commander'

import { isAgentShell } from '../actor'
import { BOARD_SECTION_FIELDS, buildBoardSections, describeBoardSections } from '../board-text'
import type { BoardCommandOptions } from '../command'
import { runBoardCommand } from '../command'
import { CliError } from '../output'
import { projectCard } from '../view'

interface BoardOptions extends Omit<BoardCommandOptions, 'json'> {
  column?: string
  all?: boolean
  /** `--json` alone: the whole result; `--json a,b`: only those fields of each column. */
  json?: string | boolean
}

/** How wide a board is drawn when the output is not a terminal that says. */
const DEFAULT_WIDTH = 80

/**
 * `kanbo board` — the board in a terminal: each column in board order with
 * its count, its cards as `KEY  title`, the status line under each, and a
 * mark on the cards waiting for a person and the ones an agent is working on.
 * Done and Canceled show the cards changed last unless `--all`; an empty
 * Canceled is left out. `--json` prints the same sections as data.
 */
export function registerBoardCommand(program: Command): void {
  program
    .command('board')
    .description('the board in this terminal: columns, cards, status lines, what waits for you')
    .option('--column <column>', 'only this column, by slug, name or id')
    .option('--all', 'every card of Done and Canceled, not just the last few')
    .option('--db <path>', 'board database file to open')
    .option('--database-url <url>', 'external Postgres board to work on instead of a board file')
    .option('--workspace <nameOrId>', 'workspace the command is about')
    .option('--json [fields]', 'print the sections as JSON, or only these comma-separated fields of each')
    .option('--format <format>', 'output format: json or pretty')
    .action(async (options: BoardOptions) => {
      const output = options.json === true
        ? { ...options, json: undefined, format: options.format ?? 'pretty' }
        : { ...options, json: typeof options.json === 'string' ? options.json : undefined }

      await runBoardCommand(output, 'read', async (session) => {
        const workspaceId = session.workspace.id
        const columns = await session.ops.listColumns(workspaceId)
        const wanted = options.column ? await session.ops.findColumn(workspaceId, options.column) : null
        if (options.column && !wanted) {
          throw new CliError(1, `This board has no column "${options.column}". See kanbo columns list.`)
        }

        const rows = (await session.store.issues.listInBoardOrder(workspaceId))
          .filter(row => !wanted || row.statusId === wanted.id)
        const runs = await session.ops.readBoardProjectionForIssues(rows.map(row => row.id))
        const cards = rows.map((row, index) => projectCard(row, columns, runs[index]!))
        // A column asked for by name is shown even when it is an empty Canceled.
        const sections = buildBoardSections(wanted ? [wanted] : columns, cards, { all: options.all === true, keepEmptyCanceled: wanted !== null })

        return {
          value: sections,
          fields: BOARD_SECTION_FIELDS,
          text: describeBoardSections(sections, {
            width: process.stdout.columns || DEFAULT_WIDTH,
            color: colorsWanted(),
            whom: isAgentShell() ? 'a person' : 'you',
          }),
        }
      })
    })
}

/**
 * Colour only for a terminal, and never when `NO_COLOR` says so
 * (no-color.org); `FORCE_COLOR` asks for it anyway, as it does for picocolors.
 * Read on every run rather than once at load, as picocolors does.
 */
function colorsWanted(): boolean {
  if (process.env.NO_COLOR) {
    return false
  }
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0') {
    return true
  }
  return process.stdout.isTTY === true && process.env.TERM !== 'dumb'
}
