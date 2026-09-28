import type { Command } from 'commander'

import { BoardError } from '../../domain/errors'
import { requireHumanActor, typedCommand } from '../actor'
import type { BoardCommandOptions } from '../command'
import { runBoardCommand, withBoardOptions } from '../command'
import { CliError } from '../output'
import { describeSprints, projectSprint, SPRINT_VIEW_FIELDS } from '../view'

interface CreateOptions extends BoardCommandOptions {
  title: string
  start: number
  due: number
  description?: string
}

interface CloseOptions extends BoardCommandOptions {
  carryTo?: string
}

const DAY_SECONDS = 86_400

/**
 * A date as the command line takes it: `YYYY-MM-DD`, read as a UTC day, or a
 * unix-seconds number taken as it is. `end` turns a day into its last second,
 * so a sprint due on a day is still current throughout that day.
 */
function parseDate(value: string, end: boolean): number {
  if (/^\d+$/.test(value)) {
    return Number(value)
  }
  const day = /^\d{4}-\d{2}-\d{2}$/.test(value) ? Date.parse(`${value}T00:00:00Z`) : Number.NaN
  if (Number.isNaN(day)) {
    throw new CliError(1, `Expected a date as YYYY-MM-DD or unix seconds, got "${value}".`)
  }
  return day / 1000 + (end ? DAY_SECONDS - 1 : 0)
}

/**
 * `kanbo sprint …` — milestones read as sprints (ruling 5x-3).
 *
 * Listing and creating are anybody's. Closing one is a person's decision
 * (ruling 5x-4) — what did not get done is a review of the work — so it is
 * refused in a shell started for an agent exactly like `approve`, before
 * the board is opened.
 */
export function registerSprintCommands(program: Command): void {
  const sprint = program
    .command('sprint')
    .description('Group cards into time-boxed sprints')

  withBoardOptions(sprint
    .command('list')
    .description('List sprints by start date; the current one is marked *'))
    .action(async (options: BoardCommandOptions) => {
      await runBoardCommand(options, 'read', async (session) => {
        const views = (await session.ops.listSprints(session.workspace.id)).map(projectSprint)
        return { value: views, text: describeSprints(views), fields: SPRINT_VIEW_FIELDS }
      })
    })

  withBoardOptions(sprint
    .command('create')
    .description('Start a sprint with a first and a last day')
    .requiredOption('--title <title>', 'what the sprint is called')
    .requiredOption('--start <date>', 'first day, as YYYY-MM-DD (UTC) or unix seconds', value => parseDate(value, false))
    .requiredOption('--due <date>', 'last day, as YYYY-MM-DD (UTC, through its end) or unix seconds', value => parseDate(value, true))
    .option('--description <text>', 'what the sprint is for'))
    .action(async (options: CreateOptions) => {
      await runBoardCommand(options, 'write', async (session) => {
        const created = await session.ops.createMilestone({
          workspaceId: session.workspace.id,
          title: options.title,
          description: options.description ?? null,
          startDate: options.start,
          dueDate: options.due,
        })
        const current = await session.ops.currentSprint(session.workspace.id)
        const view = projectSprint({ ...created, cards: { open: 0, done: 0 }, current: current?.id === created.id })
        return { value: view, text: `Created ${view.id}\n\n${describeSprints([view])}`, fields: SPRINT_VIEW_FIELDS }
      })
    })

  withBoardOptions(sprint
    .command('close')
    .description('Close a sprint and move its unfinished cards on (a person only)')
    .argument('<id>', 'the sprint to close')
    .option('--carry-to <id>', 'the open sprint unfinished cards move to; without it they leave the sprint'))
    .action(async (id: string, options: CloseOptions, command: Command) => {
      const actor = requireHumanActor('sprint close', typedCommand(command))

      await runBoardCommand(options, 'write', async (session) => {
        // A board can hold several workspaces: a sprint of another one is not
        // this workspace's to close, even by its id.
        if (!(await session.ops.listSprints(session.workspace.id)).some(sprint => sprint.id === id)) {
          throw new BoardError('issue_milestone_not_found', { milestoneId: id, workspaceId: session.workspace.id })
        }
        const result = await session.ops.closeSprint(id, { carryTo: options.carryTo ?? null }, actor)
        const destination = options.carryTo ? `to ${options.carryTo}` : 'out of the milestone'
        return {
          value: result,
          text: `Closed ${id}; ${result.carried} unfinished card${result.carried === 1 ? '' : 's'} carried ${destination}`,
          fields: ['carried', 'closed'],
        }
      })
    })
}
