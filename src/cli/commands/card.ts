import type { Command } from 'commander'

import type { BoardCardWrite, UpdateCardInput } from '../../ops/cards'
import type { Issue, IssuePullRequest } from '../../sqlite/schema'
import { createCliActor, createPlacementActor } from '../actor'
import type { BoardCommandOptions, BoardSession } from '../command'
import { parseCount, parseExecutionMode, requireCard, runBoardCommand, withBoardOptions } from '../command'
import { CliError } from '../output'
import type { CardView } from '../view'
import { CARD_VIEW_FIELDS, describeCard, describeCards, projectCard } from '../view'

/**
 * `kanbo card …` — the cards themselves.
 *
 * Every write here is filed under the shell that made it and goes through the
 * board's own operations, so a card an agent moved from a terminal reads on the
 * board exactly like one moved in the app: the same field history, the same
 * status line, the same board version bump for whoever is watching.
 */

const PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent'] as const

interface ListOptions extends BoardCommandOptions {
  column?: string
  limit?: number
}

interface CreateOptions extends BoardCommandOptions {
  title?: string
  description?: string
  column?: string
  parent?: string
  executionMode?: Issue['executionMode']
}

interface UpdateOptions extends BoardCommandOptions {
  title?: string
  description?: string
  priority?: Issue['priority']
  labels?: string[]
  executionMode?: Issue['executionMode']
}

interface TextOptions extends BoardCommandOptions {
  text: string
}

interface ContentOptions extends BoardCommandOptions {
  content: string
}

interface WaitApprovalOptions extends BoardCommandOptions {
  text?: string
}

export function registerCardCommands(program: Command): void {
  const card = program
    .command('card')
    .description('Add, change, move and read cards')

  withBoardOptions(card
    .command('list')
    .description('List cards in board order')
    .option('--column <column>', 'only cards in this column, by slug, name or id')
    .option('--limit <count>', 'how many cards to print', parseCount))
    .action(async (options: ListOptions) => {
      await runBoardCommand(options, 'read', async (session) => {
        const columns = await session.ops.listColumns(session.workspace.id)
        const wanted = options.column
          ? await session.ops.findColumn(session.workspace.id, options.column)
          : null
        if (options.column && !wanted) {
          throw new CliError(1, `This board has no column "${options.column}".`)
        }

        const rows = (await session.store.issues.listInBoardOrder(session.workspace.id))
          .filter(row => !wanted || row.statusId === wanted.id)
          .slice(0, options.limit ?? Number.POSITIVE_INFINITY)
        const runs = await session.ops.readBoardProjectionForIssues(rows.map(row => row.id))
        const cards = rows.map((row, index) => projectCard(row, columns, runs[index]))
        return { value: cards, text: describeCards(cards), fields: CARD_VIEW_FIELDS }
      })
    })

  withBoardOptions(card
    .command('get')
    .description('Show one card')
    .argument('<card>', 'the card, as MAN-012, MAN-12 or 12'))
    .action(async (reference: string, options: BoardCommandOptions) => {
      await runBoardCommand(options, 'read', async (session) => {
        return await presentCard(session, await requireCard(session, reference))
      })
    })

  withBoardOptions(card
    .command('create')
    .description('Add a card to the board')
    .option('--title <title>', 'what the card is called (its number when left out)')
    .option('--description <text>', 'what the card is about')
    .option('--column <column>', 'the column to put it in, by slug, name or id')
    .option('--parent <card>', 'the card this one is part of')
    .option('--execution-mode <mode>', 'where the work happens: worktree (its own checkout) or main', parseExecutionMode))
    .action(async (options: CreateOptions) => {
      await runBoardCommand(options, 'write', async (session) => {
        const parent = options.parent ? await requireCard(session, options.parent) : null
        const created = await session.ops.createCard({
          workspace: session.workspace,
          title: options.title,
          description: options.description,
          statusName: options.column,
          parentIssueId: parent?.id,
          executionMode: options.executionMode,
        }, createPlacementActor())
        return await presentCard(session, created)
      })
    })

  withBoardOptions(card
    .command('update')
    .description('Change a card\'s title, description, priority or labels')
    .argument('<card>', 'the card, as MAN-012, MAN-12 or 12')
    .option('--title <title>', 'what the card is called')
    .option('--description <text>', 'what the card is about')
    .option('--priority <priority>', `one of ${PRIORITIES.join(', ')}`, parsePriority)
    .option('--labels <labels>', 'comma-separated labels, replacing the ones the card has', parseLabels)
    .option('--execution-mode <mode>', 'where the work happens: worktree (its own checkout) or main', parseExecutionMode))
    .action(async (reference: string, options: UpdateOptions) => {
      await runBoardCommand(options, 'write', async (session) => {
        const input = readUpdateInput(options)
        const existing = await requireCard(session, reference)
        return await presentCard(session, await session.ops.updateCard(existing.id, input, createPlacementActor()))
      })
    })

  withBoardOptions(card
    .command('move')
    .description('Move a card to another column')
    .argument('<card>', 'the card, as MAN-012, MAN-12 or 12')
    .argument('<column>', 'the column, by slug, name or id'))
    .action(async (reference: string, column: string, options: BoardCommandOptions) => {
      await runBoardCommand(options, 'write', async (session) => {
        const existing = await requireCard(session, reference)
        return await presentCard(session, await session.ops.moveCard(existing.id, column, createPlacementActor()))
      })
    })

  withBoardOptions(card
    .command('status-line')
    .description('Say in one line what is happening on a card right now')
    .argument('<card>', 'the card, as MAN-012, MAN-12 or 12')
    .requiredOption('--text <text>', 'one sentence, present tense'))
    .action(async (reference: string, options: TextOptions) => {
      await runBoardCommand(options, 'write', async (session) => {
        const existing = await requireCard(session, reference)
        return await presentCard(session, await session.ops.setStatusLine(existing.id, options.text, createCliActor()))
      })
    })

  withBoardOptions(card
    .command('comment')
    .description('Leave a comment on a card: a finding, a decision or a question')
    .argument('<card>', 'the card, as MAN-012, MAN-12 or 12')
    .requiredOption('--content <text>', 'what to say'))
    .action(async (reference: string, options: ContentOptions) => {
      await runBoardCommand(options, 'write', async (session) => {
        const existing = await requireCard(session, reference)
        const comment = await session.ops.addComment({ issueId: existing.id, content: options.content }, createCliActor())
        return {
          value: { id: comment.id, issueId: comment.issueId, content: comment.content, createdAt: comment.createdAt },
          text: `Commented on ${existing.id}`,
        }
      })
    })

  withBoardOptions(card
    .command('wait-approval')
    .description('Ask a person to review a card, and stop working on it')
    .argument('<card>', 'the card, as MAN-012, MAN-12 or 12')
    .option('--text <text>', 'the status line to leave, saying what you need'))
    .action(async (reference: string, options: WaitApprovalOptions) => {
      await runBoardCommand(options, 'write', async (session) => {
        const existing = await requireCard(session, reference)
        const waiting = await session.ops.waitApproval(existing.id, { statusLine: options.text }, createCliActor())
        return await presentCard(session, waiting)
      })
    })

  registerPullRequestCommands(card)
}

/** The fields a pull-request link prints, and the ones `--json` may name. */
const PULL_REQUEST_FIELDS = ['id', 'issueId', 'owner', 'repo', 'number', 'url', 'createdAt'] as const

type PullRequestView = Pick<IssuePullRequest, typeof PULL_REQUEST_FIELDS[number]>

function projectPullRequest(link: IssuePullRequest): PullRequestView {
  return {
    id: link.id,
    issueId: link.issueId,
    owner: link.owner,
    repo: link.repo,
    number: link.number,
    url: link.url,
    createdAt: link.createdAt,
  }
}

function describePullRequest(link: PullRequestView): string {
  return `${link.id}  ${link.owner}/${link.repo}#${link.number}  ${link.url}`
}

/**
 * `kanbo card pr …` — the pull requests a card names (ruling 4-1).
 *
 * Linking is all an agent does: what the pull request is — open, merged, green
 * — reaches the card as comments from whoever watches GitHub, so nothing here
 * writes one.
 */
function registerPullRequestCommands(card: Command): void {
  const pr = card
    .command('pr')
    .description('Link pull requests to a card')

  withBoardOptions(pr
    .command('add')
    .description('Link a pull request to a card (linking it twice is fine)')
    .argument('<card>', 'the card, as MAN-012, MAN-12 or 12')
    .argument('<url>', 'the pull request, as https://github.com/<owner>/<repo>/pull/<n> or <owner>/<repo>#<n>'))
    .action(async (reference: string, url: string, options: BoardCommandOptions) => {
      await runBoardCommand(options, 'write', async (session) => {
        const existing = await requireCard(session, reference)
        const link = projectPullRequest(await session.ops.linkPullRequest(existing.id, url, createCliActor()))
        return {
          value: link,
          text: `Linked ${link.owner}/${link.repo}#${link.number} to ${existing.id} (${link.id})`,
          fields: PULL_REQUEST_FIELDS,
        }
      })
    })

  withBoardOptions(pr
    .command('list')
    .description('List the pull requests linked to a card')
    .argument('<card>', 'the card, as MAN-012, MAN-12 or 12'))
    .action(async (reference: string, options: BoardCommandOptions) => {
      await runBoardCommand(options, 'read', async (session) => {
        const existing = await requireCard(session, reference)
        const links = (await session.ops.listPullRequests(existing.id)).map(projectPullRequest)
        return {
          value: links,
          text: links.length === 0 ? `${existing.id} names no pull requests.` : links.map(describePullRequest).join('\n'),
          fields: PULL_REQUEST_FIELDS,
        }
      })
    })

  withBoardOptions(pr
    .command('remove')
    .description('Unlink a pull request from a card')
    .argument('<card>', 'the card, as MAN-012, MAN-12 or 12')
    .argument('<linkId>', 'the link id, as kanbo card pr list prints it'))
    .action(async (reference: string, linkId: string, options: BoardCommandOptions) => {
      await runBoardCommand(options, 'write', async (session) => {
        const existing = await requireCard(session, reference)
        const link = projectPullRequest(await session.ops.unlinkPullRequest(existing.id, linkId, createCliActor()))
        return {
          value: link,
          text: `Unlinked ${link.owner}/${link.repo}#${link.number} from ${existing.id}`,
          fields: PULL_REQUEST_FIELDS,
        }
      })
    })
}

/**
 * The card as both shapes the output contract offers. A card a person placed
 * in a column whose entry rules it does not meet (ruling 6-5) also leaves one
 * warning line per unmet rule on stderr, so the card prints as usual.
 */
async function presentCard(session: BoardSession, card: BoardCardWrite): Promise<{ value: CardView, text: string, fields: readonly string[] }> {
  const [columns, runs] = await Promise.all([
    session.ops.listColumns(session.workspace.id),
    session.ops.readBoardProjectionForIssue(card.id),
  ])
  const view = projectCard(card, columns, runs)
  for (const item of card.unmetRules ?? []) {
    console.error(`kanbo: warning: ${view.id} entered "${view.column ?? '—'}" without ${item.rule}: ${item.detail}`)
  }
  return { value: view, text: describeCard(view), fields: CARD_VIEW_FIELDS }
}

/**
 * The fields `card update` was asked to change. A command that names none of
 * them is refused rather than obeyed: an empty update still bumps the board
 * version, and every reader would be told the board changed when it did not.
 */
function readUpdateInput(options: UpdateOptions): UpdateCardInput {
  const input: UpdateCardInput = {}
  if (options.title !== undefined) {
    input.title = options.title
  }
  if (options.description !== undefined) {
    input.description = options.description
  }
  if (options.priority !== undefined) {
    input.priority = options.priority
  }
  if (options.labels !== undefined) {
    input.labels = options.labels
  }
  if (options.executionMode !== undefined) {
    input.executionMode = options.executionMode
  }

  if (Object.keys(input).length === 0) {
    throw new CliError(1, 'Nothing to update. Pass --title, --description, --priority, --labels or --execution-mode.')
  }
  return input
}

function parsePriority(value: string): Issue['priority'] {
  const priority = PRIORITIES.find(candidate => candidate === value)
  if (!priority) {
    throw new CliError(1, `Unknown priority "${value}". Use one of ${PRIORITIES.join(', ')}.`)
  }
  return priority
}

function parseLabels(value: string): string[] {
  return value.split(',').map(label => label.trim()).filter(label => label.length > 0)
}
