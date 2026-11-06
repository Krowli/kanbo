import type { Command } from 'commander'

import { BoardError } from '../../domain/errors'
import { isoWeekOf } from '../../domain/iso-week'
import { currentUnixSeconds } from '../../domain/time'
import type { BoardCommandOptions } from '../command'
import { parseCalendarDay, runBoardCommand, withBoardOptions } from '../command'
import { BOARD_METRICS_FIELDS, describeMetrics } from '../metrics-view'

interface StatsOptions extends BoardCommandOptions {
  from?: number
  to?: number
  sprint?: string
}

/** How many ISO weeks `kanbo stats` reads when it is given no range, the current one included. */
export const DEFAULT_STATS_WEEKS = 12

const WEEK_SECONDS = 7 * 86_400

/** The Monday that makes the range `DEFAULT_STATS_WEEKS` ISO weeks long, ending with the week of `now`. */
export function defaultStatsFrom(now: number): number {
  return isoWeekOf(now).start - (DEFAULT_STATS_WEEKS - 1) * WEEK_SECONDS
}

/**
 * `kanbo stats` — how work flows on this board (spec 2026-11-05, Part 4).
 *
 * Reading only, so it is anybody's, an agent's shell included. A sprint sets
 * the range to its own dates and keeps its cards; `--from` and `--to` still
 * win over either end.
 */
export function registerStatsCommand(program: Command): void {
  withBoardOptions(program
    .command('stats')
    .description('How work flows on this board: cycle time, throughput, work in progress, returns, agents')
    .option('--from <date>', `first day, YYYY-MM-DD (UTC) or unix seconds (${DEFAULT_STATS_WEEKS} weeks back when left out)`, value => parseCalendarDay(value, false))
    .option('--to <date>', 'last day, YYYY-MM-DD (UTC, through its end) or unix seconds (now when left out)', value => parseCalendarDay(value, true))
    .option('--sprint <id>', 'only the cards of this sprint, over its dates'))
    .action(async (options: StatsOptions) => {
      await runBoardCommand(options, 'read', async (session) => {
        const now = currentUnixSeconds()
        const sprint = options.sprint === undefined
          ? null
          : (await session.ops.listSprints(session.workspace.id, now)).find(candidate => candidate.id === options.sprint) ?? null
        if (options.sprint !== undefined && sprint === null) {
          throw new BoardError('issue_milestone_not_found', { milestoneId: options.sprint, workspaceId: session.workspace.id })
        }
        const metrics = await session.ops.boardMetrics({
          workspaceIds: [session.workspace.id],
          from: options.from ?? sprint?.startDate ?? defaultStatsFrom(now),
          to: options.to ?? sprint?.dueDate ?? now,
          milestoneId: sprint?.id ?? null,
        }, now)
        return { value: metrics, text: describeMetrics(metrics, sprint), fields: BOARD_METRICS_FIELDS }
      })
    })
}
