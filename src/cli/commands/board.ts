import type { Command } from 'commander'

import { isAgentShell } from '../actor'
import { BOARD_SECTION_FIELDS, buildBoardSections, describeBoardSections } from '../board-text'
import type { BoardCommandOptions } from '../command'
import { runBoardCommand } from '../command'
import { CliError } from '../output'
import { projectCard } from '../view'

interface BoardOptions extends BoardCommandOptions {
  column?: string
  all?: boolean
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
    .description('Show the board here: columns, cards, what each is doing, what waits for you')
    .option('--column <column>', 'only this column, by slug, name or id')
    .option('--all', 'every card in Done and Canceled, not just the last few')
    .option('--db <path>', 'the board file to open')
    .option('--database-url <url>', 'a shared Postgres board to use instead of a board file')
    .option('--workspace <nameOrId>', 'the project, when this folder is not bound to one')
    .option('--json [fields]', 'print the columns as JSON; name comma-separated fields to print only those of each')
    .option('--format <format>', 'print JSON: json (one line) or pretty (indented)')
    .action(async (options: BoardOptions) => {
      await runBoardCommand(options, 'read', async (session) => {
        const workspaceId = session.workspace.id
        const columns = await session.ops.listColumns(workspaceId)
        const wanted = options.column ? await session.ops.findColumn(workspaceId, options.column) : null
        if (options.column && !wanted) {
          throw new CliError(1, `This board has no column "${options.column}". See kanbo columns list.`)
        }

        const rows = wanted
          ? (await session.store.issues.listPage({ workspaceId, statusIds: [wanted.id] })).cards
          : await session.store.issues.listInBoardOrder(workspaceId)
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
