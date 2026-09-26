import type { Command } from 'commander'

import { ENTRY_RULES } from '../../domain/entry-rules'
import { requireHumanActor } from '../actor'
import type { BoardCommandOptions } from '../command'
import { runBoardCommand, withBoardOptions } from '../command'
import { CliError } from '../output'
import { describeColumns, projectColumn } from '../view'

interface DescribeColumnOptions extends BoardCommandOptions {
  text: string
}

interface ColumnRulesOptions extends BoardCommandOptions {
  require?: string
  clear?: boolean
}

/**
 * `kanbo columns …` — the board's columns.
 *
 * Listing them is how a person finds the slug a card is moved by; describing
 * one is how a person tells every agent that will ever read this board when a
 * card belongs in it, in one line they only have to write once. Setting its
 * rules is how a person keeps an agent from moving a card in before it is
 * ready — a person's command, refused in an agent's shell. Adding the
 * standard set brings a board made before them up to date without touching the
 * columns its owner made.
 */
export function registerColumnsCommands(program: Command): void {
  const columns = program
    .command('columns')
    .description('the columns of this board')

  withBoardOptions(columns
    .command('list')
    .description('every column in board order, with the slug a card is moved by'))
    .action(async (options: BoardCommandOptions) => {
      await runBoardCommand(options, 'read', async (session) => {
        const views = (await session.ops.listColumns(session.workspace.id)).map(projectColumn)
        return { value: views, text: describeColumns(views) }
      })
    })

  withBoardOptions(columns
    .command('describe')
    .description('say in one line when a card belongs in a column')
    .argument('<column>', 'the column, by slug, name or id')
    .requiredOption('--text <text>', 'what the column means'))
    .action(async (column: string, options: DescribeColumnOptions) => {
      await runBoardCommand(options, 'write', async (session) => {
        const updated = await session.ops.describeColumn(session.workspace.id, column, options.text)
        const view = projectColumn(updated)
        return { value: view, text: describeColumns([view]) }
      })
    })

  withBoardOptions(columns
    .command('rules')
    .description('set what a card must satisfy before an agent may move it into a column')
    .argument('<column>', 'the column, by slug, name or id')
    .option('--require <rules>', `comma-separated: ${ENTRY_RULES.join(', ')}`)
    .option('--clear', 'ask nothing of a card entering the column'))
    .action(async (column: string, options: ColumnRulesOptions) => {
      // Checked before the board is opened, like `approve`: a refusal leaves
      // the board exactly as it found it.
      const actor = requireHumanActor('columns rules')
      const rules = readRequestedRules(options)

      await runBoardCommand(options, 'write', async (session) => {
        const updated = await session.ops.setColumnEntryRules(session.workspace.id, column, rules, actor)
        const view = projectColumn(updated)
        return { value: view, text: describeColumns([view]) }
      })
    })

  withBoardOptions(columns
    .command('add-standard')
    .description('add any of the standard columns this board is missing'))
    .action(async (options: BoardCommandOptions) => {
      await runBoardCommand(options, 'write', async (session) => {
        const { statuses, added } = await session.ops.addStandardColumns(session.workspace.id)
        const views = statuses.map(projectColumn)
        return {
          value: { added, columns: views },
          text: added.length === 0
            ? 'This board already has every standard column'
            : `Added ${added.join(', ')}\n\n${describeColumns(views)}`,
        }
      })
    })
}

/** The rules `--require` names, or `null` for `--clear` — exactly one of the two. */
function readRequestedRules(options: ColumnRulesOptions): string[] | null {
  if (options.clear && options.require !== undefined) {
    throw new CliError(1, 'Pass --require or --clear, not both.')
  }
  if (options.clear) {
    return null
  }
  if (options.require === undefined) {
    throw new CliError(1, `Pass --require ${ENTRY_RULES.join(',')} (any of them) or --clear.`)
  }
  return options.require.split(',').map(rule => rule.trim()).filter(Boolean)
}
