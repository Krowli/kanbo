import type { Command } from 'commander'

import type { FinishRunInput } from '../../ops/runs'
import type { Issue, IssueRun } from '../../sqlite/schema'
import { createCliActor, requireHumanActor } from '../actor'
import type { BoardCommandOptions, BoardSession } from '../command'
import { parseExecutionMode, requireCard, requireRun, runBoardCommand, withBoardOptions } from '../command'
import { CliError } from '../output'
import { projectRun, RUN_VIEW_FIELDS } from '../view'

const RUN_STATES = ['finished', 'failed', 'stopped'] as const

interface StartOptions extends BoardCommandOptions {
  agent: string
  branch?: string
  executionMode?: Issue['executionMode']
  session?: string
}

interface AttachSessionOptions extends BoardCommandOptions {
  replace?: boolean
}

interface FinishOptions extends BoardCommandOptions {
  state: FinishRunInput['state']
  errorText?: string
}

/**
 * `kanbo run …` — saying that a card is being worked on, and how that ended.
 *
 * A run launched from a terminal is recorded exactly like one an app launched:
 * the card gets a line saying who is on it and a comment naming the attempt, so
 * `kanbo ready` stops offering the card to the next agent that asks. Its
 * launch is filed as `external` — no app started this, and a board that
 * claimed otherwise would send someone looking for a session that never existed.
 */
export function registerRunCommands(program: Command): void {
  const run = program
    .command('run')
    .description('Record when an agent starts and finishes work on a card')

  withBoardOptions(run
    .command('start')
    .description('Say that you started working on a card')
    .argument('<card>', 'the card, as MAN-012, MAN-12 or 12')
    .requiredOption('--agent <name>', 'your name, e.g. claude')
    .option('--branch <branch>', 'the branch the work happens on')
    .option('--execution-mode <mode>', 'where the work happens: worktree or main (default: what the card says)', parseExecutionMode)
    .option('--session <ref>', 'your session, to find it later: claude:<session id> or codex:<session id>'))
    .action(async (reference: string, options: StartOptions) => {
      await runBoardCommand(options, 'write', async (session) => {
        const card = await requireCard(session, reference)
        const started = await session.ops.startRun(card.id, {
          agentName: options.agent,
          branch: options.branch,
          executionMode: options.executionMode,
          externalSessionRef: options.session,
          launchedByKind: 'external',
        }, createCliActor())
        const view = projectRun({ ...started, attempt: await attemptFor(session, started) })
        return { value: view, text: `Run ${view.id} started on ${card.id}`, fields: RUN_VIEW_FIELDS }
      })
    })

  withBoardOptions(run
    .command('attach-session')
    .description('Say which agent session did this work (the first one given stays)')
    .argument('<runId>', 'the run id kanbo run start printed')
    .argument('<ref>', 'claude:<session id> or codex:<session id>')
    .option('--replace', 'replace the session already given (a person only)'))
    .action(async (runId: string, ref: string, options: AttachSessionOptions) => {
      // Checked before the board is opened, the same as `approve`.
      const actor = options.replace ? requireHumanActor('run attach-session --replace') : null
      await runBoardCommand(options, 'write', async (session) => {
        const found = await requireRun(session, runId)
        const attached = actor
          ? await session.ops.clearRunSessionRef(found.id, actor, { replaceWith: ref })
          : await session.ops.recordRunSessionRef(found.id, ref)
        const view = projectRun({ ...attached, attempt: await attemptFor(session, attached) })
        return { value: view, text: `Run ${view.id} carries ${attached.externalSessionRef}`, fields: RUN_VIEW_FIELDS }
      })
    })

  withBoardOptions(run
    .command('clear-session')
    .description('Remove the session given for this work (a person only)')
    .argument('<runId>', 'the run, as `kanbo run start` printed it'))
    .action(async (runId: string, options: BoardCommandOptions) => {
      const actor = requireHumanActor('run clear-session')
      await runBoardCommand(options, 'write', async (session) => {
        const found = await requireRun(session, runId)
        const cleared = await session.ops.clearRunSessionRef(found.id, actor)
        const view = projectRun({ ...cleared, attempt: await attemptFor(session, cleared) })
        return { value: view, text: `Run ${view.id} names no log`, fields: RUN_VIEW_FIELDS }
      })
    })

  withBoardOptions(run
    .command('finish')
    .description('Say how the work ended')
    .argument('<runId>', 'the run, as `kanbo run start` printed it')
    .requiredOption('--state <state>', `one of ${RUN_STATES.join(', ')}`, parseRunState)
    .option('--error-text <text>', 'what went wrong, for a failed run'))
    .action(async (runId: string, options: FinishOptions) => {
      await runBoardCommand(options, 'write', async (session) => {
        const run = await requireRun(session, runId)
        const finished = await session.ops.finishRun(run.id, {
          state: options.state,
          errorText: options.errorText,
        }, createCliActor())
        const view = projectRun({ ...finished, attempt: await attemptFor(session, finished) })
        return { value: view, text: `Run ${view.id} ${view.state}`, fields: RUN_VIEW_FIELDS }
      })
    })
}

/**
 * Which attempt a run is. `startRun` and `finishRun` hand back the row
 * itself; the count only exists once every run of the card is lined up.
 */
async function attemptFor(session: BoardSession, run: IssueRun): Promise<number> {
  const runs = await session.ops.listRuns(run.issueId)
  return runs.find(candidate => candidate.id === run.id)?.attempt ?? runs.length
}

function parseRunState(value: string): FinishRunInput['state'] {
  const state = RUN_STATES.find(candidate => candidate === value)
  if (!state) {
    throw new CliError(1, `Unknown run state "${value}". Use one of ${RUN_STATES.join(', ')}.`)
  }
  return state
}
