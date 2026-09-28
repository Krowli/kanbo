import type { ColumnTemplateId } from '../domain/column-templates'
import { COLUMN_TEMPLATE_IDS, COLUMN_TEMPLATE_LABELS, COLUMN_TEMPLATES, READY_COLUMN_SLUG } from '../domain/column-templates'
import { normalizeStatusName } from '../domain/status-name'
import type { IssueStatus } from '../sqlite/schema'
import { requireHumanActor } from './actor'
import { addColumn, applyTemplate, countCardsIn, moveColumn, removeColumn, renameColumn } from './column-changes'
import type { BoardSession } from './command'
import { openBoardSession, runBoardCommand } from './command'
import { describeFailure, paintFailure } from './failure'
import type { Ui } from './ui/ui'
import { CancelledError } from './ui/ui'
import { describeColumns, projectColumn } from './view'

/**
 * `kanbo columns` with no words, for a person at a terminal: the columns, then
 * a small menu — add, rename, move, remove, apply a template — that comes
 * back after each change until they are done. Every item names the command
 * it runs, and runs the same change that command makes.
 *
 * Ctrl-C at the menu leaves quietly; inside an item it goes back to the menu,
 * as does a change the board refused, after saying why.
 */

type MenuChoice = 'add' | 'rename' | 'move' | 'remove' | 'template' | 'done'

export async function runColumnsMenu(ui: Ui): Promise<void> {
  // A change prints the columns as they now are; the list is shown again only when nothing did.
  let showList = true
  while (true) {
    const columns = await readColumns()
    if (showList) {
      say(ui, ['', 'Columns of this board:', describeColumns(columns.map(projectColumn))].join('\n'))
    }

    let choice: MenuChoice
    try {
      choice = await ui.select<MenuChoice>({ message: 'What would you like to change?', options: MENU })
    }
    catch (error) {
      if (error instanceof CancelledError) {
        return
      }
      throw error
    }
    if (choice === 'done') {
      return
    }

    try {
      showList = !await act(ui, choice, columns)
    }
    catch (error) {
      showList = true
      if (!(error instanceof CancelledError)) {
        console.error(paintFailure(describeFailure(error)))
      }
    }
  }
}

const MENU: { value: MenuChoice, label: string }[] = [
  { value: 'add', label: 'Add a column — kanbo columns add' },
  { value: 'rename', label: 'Rename a column — kanbo columns rename' },
  { value: 'move', label: 'Move a column — kanbo columns move' },
  { value: 'remove', label: 'Remove a column — kanbo columns remove' },
  { value: 'template', label: 'Apply a template — kanbo columns template' },
  { value: 'done', label: 'Done' },
]

export const NOTHING_TO_REMOVE = 'Nothing to remove — To Do always stays.'
const NOTHING_TO_RENAME = 'Nothing to rename — this board has no columns yet.'
const NOTHING_TO_MOVE = 'Nothing to move — this board has no columns yet.'

/** Ask what the item needs and make the change; `true` when the board changed (and its columns were printed). */
async function act(ui: Ui, choice: Exclude<MenuChoice, 'done'>, columns: IssueStatus[]): Promise<boolean> {
  switch (choice) {
    case 'add': {
      const actor = requireHumanActor('columns add', ['columns'])
      const name = (await ui.text({
        message: 'What is the new column called?',
        validate: value => (value?.trim() ? undefined : 'Give the column a name.'),
      })).trim()
      const description = (await ui.text({
        message: 'When does a card belong here? One line agents read (Enter to skip)',
      })).trim()
      const position = await askPosition(ui, columns, null, defaultAddPlace(columns))
      await write(async session => await addColumn(session, {
        name,
        description: description || undefined,
        ...(position !== 'first' ? { after: position.after } : columns[0] ? { before: columns[0].id } : {}),
      }, actor))
      return true
    }
    case 'rename': {
      const actor = requireHumanActor('columns rename', ['columns'])
      if (columns.length === 0) {
        say(ui, NOTHING_TO_RENAME)
        return false
      }
      const column = await askColumn(ui, 'Which column?', columns)
      const name = (await ui.text({
        message: `New name for ${column.name}`,
        initialValue: column.name,
        validate: value => (value?.trim() ? undefined : 'Give the column a name.'),
      })).trim()
      await write(async session => await renameColumn(session, column.id, name, actor))
      return true
    }
    case 'move': {
      const actor = requireHumanActor('columns move', ['columns'])
      if (columns.length === 0) {
        say(ui, NOTHING_TO_MOVE)
        return false
      }
      const column = await askColumn(ui, 'Which column?', columns)
      const index = columns.indexOf(column)
      const position = await askPosition(ui, columns, column, index === 0 ? 'first' : { after: columns[index - 1]!.id })
      await write(async session => await moveColumn(session, column.id, position, actor))
      return true
    }
    case 'remove': {
      const actor = requireHumanActor('columns remove', ['columns'])
      const removable = columns.filter(column => normalizeStatusName(column.name) !== READY_COLUMN_SLUG)
      if (removable.length === 0) {
        say(ui, NOTHING_TO_REMOVE)
        return false
      }
      const column = await askColumn(ui, 'Which column? (To Do stays: agents take work from it)', removable)
      const cardCount = await withSession(async session => await countCardsIn(session, column))
      const decision = await askRemoval(ui, columns, column, cardCount)
      if (!decision) {
        return false
      }
      await write(async session => await removeColumn(session, column.id, decision.moveCardsTo, actor))
      return true
    }
    case 'template': {
      const actor = requireHumanActor('columns template', ['columns'])
      const id = await ui.select<ColumnTemplateId>({
        message: 'Which template? Only the columns this board lacks are added; none is taken away.',
        options: COLUMN_TEMPLATE_IDS.map(template => ({
          value: template,
          label: `${COLUMN_TEMPLATE_LABELS[template]}: ${COLUMN_TEMPLATES[template].map(column => column.name).join(' → ')}`,
        })),
      })
      await write(async session => await applyTemplate(session, id, true, actor))
      return true
    }
  }
}

/**
 * Where the cards of a column being removed go, asked of a person: nothing
 * to ask when it is empty, else a column to move them to — then a yes.
 * `null` when they said no.
 */
export async function askRemoval(
  ui: Ui,
  columns: IssueStatus[],
  column: IssueStatus,
  cardCount: number,
): Promise<{ moveCardsTo: string | null } | null> {
  if (cardCount === 0) {
    return await ui.confirm({ message: `Remove column ${column.name}?`, initialValue: false })
      ? { moveCardsTo: null }
      : null
  }
  const cards = `${cardCount} ${cardCount === 1 ? 'card' : 'cards'}`
  const target = await askColumn(ui, `${column.name} holds ${cards}. Move them to which column?`, columns.filter(other => other.id !== column.id))
  return await ui.confirm({ message: `Remove column ${column.name} and move ${cards} to ${target.name}?`, initialValue: false })
    ? { moveCardsTo: target.id }
    : null
}

async function askColumn(ui: Ui, message: string, columns: IssueStatus[]): Promise<IssueStatus> {
  const id = await ui.select<string>({
    message,
    options: columns.map(column => ({ value: column.id, label: column.name })),
  })
  return columns.find(column => column.id === id)!
}

/** "At the start", or after one of the other columns. */
async function askPosition(
  ui: Ui,
  columns: IssueStatus[],
  moving: IssueStatus | null,
  initial: 'first' | { after: string },
): Promise<'first' | { after: string }> {
  const others = columns.filter(column => column.id !== moving?.id)
  const value = await ui.select<string>({
    message: 'Where should it go?',
    options: [
      { value: 'first', label: 'At the start' },
      ...others.map(column => ({ value: column.id, label: `After ${column.name}` })),
    ],
    initialValue: initial === 'first' ? 'first' : initial.after,
  })
  return value === 'first' ? 'first' : { after: value }
}

/** Where `kanbo columns add` puts a column when told nothing: after the column before Done (or Canceled). */
function defaultAddPlace(columns: IssueStatus[]): 'first' | { after: string } {
  const end = columns.findIndex(column => column.category === 'completed')
  const at = end >= 0 ? end : columns.findIndex(column => column.category === 'canceled')
  const index = at < 0 ? columns.length : at
  return index === 0 ? 'first' : { after: columns[index - 1]!.id }
}

async function readColumns(): Promise<IssueStatus[]> {
  return await withSession(async session => await session.ops.listColumns(session.workspace.id))
}

async function withSession<T>(fn: (session: BoardSession) => Promise<T>): Promise<T> {
  const session = await openBoardSession({}, 'read')
  try {
    return await fn(session)
  }
  finally {
    await session.close()
  }
}

async function write(body: Parameters<typeof runBoardCommand>[2]): Promise<void> {
  await runBoardCommand({}, 'write', body)
}

function say(ui: Ui, text: string): void {
  ui.output.write(`${text}\n`)
}

