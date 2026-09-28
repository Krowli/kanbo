import type { Command } from 'commander'
import { Option } from 'commander'

import { COLUMN_TEMPLATE_IDS, COLUMN_TEMPLATES } from '../../domain/column-templates'
import { ENTRY_RULES } from '../../domain/entry-rules'
import type { IssueStatus } from '../../sqlite/schema'
import { requireHumanActor, typedWords } from '../actor'
import {
  addColumn,
  applyTemplate,
  COLUMN_CATEGORIES,
  countCardsIn,
  moveColumn,
  readColumnPosition,
  readTemplateId,
  removeColumn,
  renameColumn,
  requireNamedColumn,
} from '../column-changes'
import { askRemoval, runColumnsMenu } from '../columns-menu'
import type { BoardCommandOptions } from '../command'
import { openBoardSession, runBoardCommand, withBoardOptions } from '../command'
import { CliError } from '../output'
import { canPrompt } from '../ui/environment'
import { getUi } from '../ui/ui'
import { describeColumns, projectColumn } from '../view'

interface DescribeColumnOptions extends BoardCommandOptions {
  text: string
}

interface AddColumnOptions extends BoardCommandOptions {
  after?: string
  before?: string
  description?: string
  category?: IssueStatus['category']
}

interface MoveColumnOptions extends BoardCommandOptions {
  first?: boolean
  last?: boolean
  before?: string
  after?: string
}

interface RemoveColumnOptions extends BoardCommandOptions {
  moveCardsTo?: string
}

interface TemplateOptions extends BoardCommandOptions {
  addMissing?: boolean
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
 * ready. Adding, renaming, moving and removing columns, and putting a
 * template's columns on the board, change what every agent reads its work
 * from — all of these are a person's commands, refused in an agent's shell.
 * `kanbo columns` alone is a small menu of them at a terminal, and the list
 * anywhere else.
 */
export function registerColumnsCommands(program: Command): void {
  const columns = program
    .command('columns')
    .description('See and change the board\'s columns (alone: a menu)')

  withBoardOptions(columns
    .command('list')
    .description('List the columns in order, with the short name to move cards by'))
    .action(async (options: BoardCommandOptions) => {
      await runBoardCommand(options, 'read', async (session) => {
        const views = (await session.ops.listColumns(session.workspace.id)).map(projectColumn)
        return { value: views, text: describeColumns(views) }
      })
    })

  withBoardOptions(columns
    .command('describe')
    .description('Say in one line when a card belongs in a column')
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
    .description('Set what a card needs before an agent may move it into a column')
    .argument('<column>', 'the column, by slug, name or id')
    .option('--require <rules>', `comma-separated: ${ENTRY_RULES.join(', ')}`)
    .option('--clear', 'ask nothing of a card entering the column'))
    .action(async (column: string, options: ColumnRulesOptions, command: Command) => {
      // Checked before the board is opened, like `approve`: a refusal leaves
      // the board exactly as it found it.
      const actor = requireHumanActor('columns rules', typedWords(command))
      const rules = readRequestedRules(options)

      await runBoardCommand(options, 'write', async (session) => {
        const updated = await session.ops.setColumnEntryRules(session.workspace.id, column, rules, actor)
        const view = projectColumn(updated)
        return { value: view, text: describeColumns([view]) }
      })
    })

  withBoardOptions(columns
    .command('add')
    .description('Add a column (before Done unless you say where)')
    .argument('<name>', 'what the column is called')
    .option('--after <column>', 'put it right after this column')
    .option('--before <column>', 'put it right before this column')
    .option('--description <text>', 'when a card belongs in it, in one line agents read')
    .addOption(new Option('--category <category>', 'what kind of column it is').choices(COLUMN_CATEGORIES)))
    .action(async (name: string, options: AddColumnOptions, command: Command) => {
      const actor = requireHumanActor('columns add', typedWords(command))
      await runBoardCommand(options, 'write', async session => await addColumn(session, { ...options, name }, actor))
    })

  withBoardOptions(columns
    .command('rename')
    .description('Rename a column')
    .argument('<column>', 'the column, by slug, name or id')
    .argument('<name>', 'the new name'))
    .action(async (column: string, name: string, options: BoardCommandOptions, command: Command) => {
      const actor = requireHumanActor('columns rename', typedWords(command))
      await runBoardCommand(options, 'write', async session => await renameColumn(session, column, name, actor))
    })

  withBoardOptions(columns
    .command('move')
    .description('Move a column to the start, the end, or next to another column')
    .argument('<column>', 'the column, by slug, name or id')
    .option('--first', 'to the start of the board')
    .option('--last', 'to the end of the board')
    .option('--before <column>', 'right before this column')
    .option('--after <column>', 'right after this column'))
    .action(async (column: string, options: MoveColumnOptions, command: Command) => {
      const actor = requireHumanActor('columns move', typedWords(command))
      const position = readColumnPosition(options)
      await runBoardCommand(options, 'write', async session => await moveColumn(session, column, position, actor))
    })

  withBoardOptions(columns
    .command('remove')
    .description('Remove a column; its cards move to another column')
    .argument('<column>', 'the column, by slug, name or id')
    .option('--move-cards-to <column>', 'where the cards in it go; asked at a terminal when it holds any'))
    .action(async (column: string, options: RemoveColumnOptions, command: Command) => {
      const actor = requireHumanActor('columns remove', typedWords(command))
      let moveCardsTo = options.moveCardsTo ?? null
      if (moveCardsTo === null && canPrompt() && !isMachineOutput(options)) {
        const decision = await askWhereCardsGo(column, options)
        if (decision === null) {
          console.log('Nothing removed.')
          return
        }
        moveCardsTo = decision.moveCardsTo
      }
      await runBoardCommand(options, 'write', async session => await removeColumn(session, column, moveCardsTo, actor))
    })

  withBoardOptions(columns
    .command('template')
    .description('Set up columns from a template: standard, simple or review-qa')
    .argument('<template>', COLUMN_TEMPLATE_IDS.join(', '))
    .option('--add-missing', 'on a board that has columns, add the ones of the template it lacks'))
    .action(async (template: string, options: TemplateOptions, command: Command) => {
      const actor = requireHumanActor('columns template', typedWords(command))
      const id = readTemplateId(template)
      await runBoardCommand(options, 'write', async session => await applyTemplate(session, id, options.addMissing === true, actor))
    })

  withBoardOptions(columns
    .command('add-standard')
    .description('Add the standard columns this board is missing'))
    .action(async (options: BoardCommandOptions, command: Command) => {
      const actor = requireHumanActor('columns add-standard', typedWords(command))
      await runBoardCommand(options, 'write', async (session) => {
        const { statuses, added } = await session.ops.applyColumnTemplate(
          session.workspace.id,
          COLUMN_TEMPLATES.standard,
          { mode: 'add-missing', actor },
        )
        const views = statuses.map(projectColumn)
        return {
          value: { added, columns: views },
          text: added.length === 0
            ? 'This board already has every standard column'
            : `Added ${added.join(', ')}\n\n${describeColumns(views)}`,
        }
      })
    })

  // `kanbo columns` alone: the menu for a person at a terminal, the list for
  // anyone else. A word that is no subcommand reaches this action too (a
  // command with an action of its own takes words as arguments), so it is
  // refused here the way commander refuses one.
  columns.allowExcessArguments().action(async () => {
    const [word] = columns.args
    if (word !== undefined) {
      const names = columns.commands.map(command => command.name())
      columns.error(`error: unknown command '${word}'. Use one of: ${names.join(', ')}`, { code: 'commander.unknownCommand', exitCode: 1 })
    }
    if (canPrompt()) {
      await runColumnsMenu(getUi())
      return
    }
    await runBoardCommand({}, 'read', async (session) => {
      const views = (await session.ops.listColumns(session.workspace.id)).map(projectColumn)
      return { value: views, text: describeColumns(views) }
    })
  })
}

/** At a terminal: the column's cards counted, and — when it holds any — where they go, then a yes. */
async function askWhereCardsGo(column: string, options: BoardCommandOptions): Promise<{ moveCardsTo: string | null } | null> {
  const session = await openBoardSession(options, 'read')
  try {
    const removing = await requireNamedColumn(session, column)
    const cardCount = await countCardsIn(session, removing)
    if (cardCount === 0) {
      return { moveCardsTo: null }
    }
    return await askRemoval(getUi(), await session.ops.listColumns(session.workspace.id), removing, cardCount)
  }
  finally {
    await session.close()
  }
}

function isMachineOutput(options: BoardCommandOptions): boolean {
  return options.json !== undefined || options.format !== undefined
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
