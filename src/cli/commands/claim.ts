import type { Command } from 'commander'

import { sessionRefFromEnvironment } from '../../domain/external-session-ref'
import { createPlacementActor } from '../actor'
import type { BoardCommandOptions } from '../command'
import { requireCard, runBoardCommand, withBoardOptions } from '../command'
import { projectCard, projectColumn, projectRun } from '../view'

interface ClaimOptions extends BoardCommandOptions {
  agent?: string
  session?: string
}

/**
 * `kanbo claim [card]` — take a card to work on, in one step.
 *
 * The run starts and the card moves out of To Do into the board's first
 * work-in-progress column in one write, so two agents in two terminals never
 * take the same card. Filed as a placement: in a person's own terminal the
 * column's rules warn, in an agent's shell they refuse.
 */
export function registerClaimCommand(program: Command): void {
  withBoardOptions(program
    .command('claim')
    .description('Take a card to work on: start your run and move it out of To Do, in one step')
    .argument('[card]', 'the card, as MAN-012, MAN-12 or 12 (default: the first ready card)')
    .option('--agent <name>', 'your name, e.g. claude (default: the name this shell writes as)')
    .option('--session <ref>', 'your session, to find it later: claude:<session id> or codex:<session id> (default: the one Claude Code or Codex names in the environment)'))
    .action(async (reference: string | undefined, options: ClaimOptions) => {
      await runBoardCommand(options, 'write', async (session) => {
        const actor = createPlacementActor()
        const named = reference === undefined ? undefined : (await requireCard(session, reference)).id
        const claimed = await session.ops.claimCard({
          workspaceId: session.workspace.id,
          issueId: named,
          run: {
            agentName: options.agent ?? actor.id ?? 'agent',
            externalSessionRef: options.session ?? sessionRefFromEnvironment() ?? undefined,
            launchedByKind: 'external',
          },
        }, actor)
        const [columns, projection, runs] = await Promise.all([
          session.ops.listColumns(session.workspace.id),
          session.ops.readBoardProjectionForIssue(claimed.card.id),
          session.ops.listRuns(claimed.card.id),
        ])
        const card = projectCard(claimed.card, columns, projection)
        for (const item of claimed.card.unmetRules ?? []) {
          console.error(`kanbo: warning: ${card.id} entered "${claimed.column.name}" without ${item.rule}: ${item.detail}`)
        }
        const run = projectRun({ ...claimed.run, attempt: runs.find(each => each.id === claimed.run.id)?.attempt ?? runs.length })
        return {
          value: { card, run, column: projectColumn(claimed.column, columns) },
          text: `Claimed ${card.id}: run ${run.id} started, card moved to ${claimed.column.name}\nWhen you are done: kanbo run finish ${run.id} --state finished`,
        }
      })
    })
}
