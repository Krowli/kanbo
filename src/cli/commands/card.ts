import type { Command } from 'commander'
import { Option } from 'commander'

import { READY_COLUMN_SLUG } from '../../domain/column-templates'
import { BoardError } from '../../domain/errors'
import { readUnixSeconds } from '../../domain/time'
import type { KanboCardInclude } from '../../mcp/transport'
import { DEFAULT_KANBO_CARD_INCLUDES, DEFAULT_KANBO_COMMENT_LIMIT, KANBO_CARD_INCLUDES } from '../../mcp/transport'
import type { BoardCardWrite, UpdateCardInput } from '../../ops/cards'
import type { Issue, IssuePullRequest } from '../../sqlite/schema'
import { createCliActor, createPlacementActor, isAgentShell } from '../actor'
import { describeCardExtras, readCardExtras } from '../card-extras'
import type { BoardCommandOptions, BoardSession } from '../command'
import { parseCount, parseExecutionMode, requireCard, runBoardCommand, withBoardOptions } from '../command'
import { CliError } from '../output'
import type { CardView } from '../view'
import { CARD_DETAIL_VIEW_FIELDS, CARD_VIEW_FIELDS, describeCard, describeCards, projectCard, withCardAttention } from '../view'

/**
 * `kanbo card …` — the cards themselves.
 *
 * Every write here is filed under the shell that made it and goes through the
 * board's own operations, so a card an agent moved from a terminal reads on the
 * board exactly like one moved in the app: the same field history, the same
 * status line, the same board version bump for whoever is watching.
 */

const PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent'] as const

/**
 * Where `card create` puts a card no `--column` placed. A person's card goes
 * to To Do, as the home screen and the wizard put it: they wrote it down to
 * have it done. An agent's goes where the board's operations put any card with
 * no column — the first one (Backlog on the standard board) — as it did in
 * 0.2: an agent writing down follow-up work should not hand it straight to the
 * next agent that runs `kanbo ready`. A board with no To Do gets the default
 * for a person too.
 */
async function readDefaultColumn(session: BoardSession): Promise<string | undefined> {
  if (isAgentShell()) {
    return undefined
  }
  return (await session.ops.findColumn(session.workspace.id, READY_COLUMN_SLUG))?.name
}

interface ListOptions extends BoardCommandOptions {
  column?: string[]
  waiting?: boolean
  parent?: string
  active?: boolean
  returned?: boolean
  text?: string
  updatedSince?: number
  label?: string[]
  priority?: Issue['priority'][]
  limit?: number
  offset?: number
  all?: boolean
}

interface GetOptions extends BoardCommandOptions {
  include?: KanboCardInclude[]
  comments?: number
}

/** How many cards `kanbo card list` prints when the caller names no limit. */
const DEFAULT_LIST_LIMIT = 50

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
  parent?: string
}

/** A command that takes a line of text as `--text`, and `--content` for it too. */
interface TextOptions extends BoardCommandOptions {
  text?: string
  content?: string
}

export function registerCardCommands(program: Command): void {
  const card = program
    .command('card')
    .description('Add, change, move and read cards')

  withBoardOptions(card
    .command('list')
    .description(`List cards in board order, ${DEFAULT_LIST_LIMIT} at a time; filters combine`)
    .option('--column <columns>', 'only cards in these columns, by slug, name or id (comma-separated, or repeat)', collectList, undefined)
    .option('--waiting', 'only cards waiting for a person')
    .option('--parent <card>', 'only the sub-cards of this card')
    .option('--active', 'only cards an agent is working on now')
    .option('--returned', 'only cards a person sent back that nobody has picked up again')
    .option('--text <text>', 'only cards whose key, title or description contains this, ignoring case in any script (über finds Über)')
    .option('--updated-since <time>', 'only cards changed since then: unix seconds, 2026-09-28T10:00:00Z (a zone is required) or 2026-09-28 (UTC midnight)', parseMoment)
    .option('--label <labels>', 'only cards carrying every one of these labels (comma-separated, or repeat)', collectList, undefined)
    .option('--priority <priorities>', `only cards of these priorities: ${PRIORITIES.join(', ')} (comma-separated)`, parsePriorities)
    .option('--limit <count>', `how many cards to print (${DEFAULT_LIST_LIMIT} when left out)`, parseCount)
    .option('--offset <count>', 'how many picked cards to skip first', parseOffset)
    .option('--all', 'print every picked card'))
    .action(async (options: ListOptions) => {
      await runBoardCommand(options, 'read', async (session) => {
        const parent = options.parent ? await requireCard(session, options.parent) : null
        const page = await session.ops.queryCards({
          workspaceId: session.workspace.id,
          columns: options.column,
          waitingForPerson: options.waiting ? true : undefined,
          parentIssueId: parent?.id,
          hasActiveRun: options.active ? true : undefined,
          returned: options.returned ? true : undefined,
          text: options.text,
          updatedSince: options.updatedSince,
          labels: options.label,
          priorities: options.priority,
          offset: options.offset,
          limit: options.all ? undefined : options.limit ?? DEFAULT_LIST_LIMIT,
        }).catch(rethrowUnknownColumn(options.column))
        const runs = await session.ops.readBoardProjectionForIssues(page.cards.map(row => row.id))
        const attention = await session.ops.readCardAttention(page.cards, runs.map(run => run.activeRun !== null))
        const cards = withCardAttention(page.cards.map((row, index) => projectCard(row, page.columns, runs[index])), attention)
        noteMoreCards(page.total, options.offset ?? 0, cards.length)
        return { value: cards, text: describeCards(cards), fields: CARD_VIEW_FIELDS }
      })
    })

  withBoardOptions(card
    .command('get')
    .description('Show one card, with its last comments and its sub-cards')
    .argument('<card>', 'the card, as MAN-012, MAN-12 or 12')
    .option('--include <parts>', `what to show with the card: ${KANBO_CARD_INCLUDES.join(', ')} (comma-separated; ${DEFAULT_KANBO_CARD_INCLUDES.join(',')} when left out, none for the card alone)`, parseIncludes)
    .option('--comments <count>', `how many of the latest comments to show (${DEFAULT_KANBO_COMMENT_LIMIT} when left out)`, parseCount))
    .action(async (reference: string, options: GetOptions) => {
      await runBoardCommand(options, 'read', async (session) => {
        const found = await requireCard(session, reference)
        const [columns, runs] = await Promise.all([
          session.ops.listColumns(session.workspace.id),
          session.ops.readBoardProjectionForIssue(found.id),
        ])
        const view = projectCard(found, columns, runs)
        const extras = await readCardExtras(
          session,
          found,
          columns,
          options.include ?? DEFAULT_KANBO_CARD_INCLUDES,
          options.comments ?? DEFAULT_KANBO_COMMENT_LIMIT,
        )
        return {
          value: { ...view, ...extras },
          text: [describeCard(view), describeCardExtras(extras)].filter(Boolean).join('\n\n'),
          fields: CARD_DETAIL_VIEW_FIELDS,
        }
      })
    })

  withBoardOptions(card
    .command('create')
    .description('Add a card to the board')
    .option('--title <title>', 'what the card is called (its number when left out)')
    .option('--description <text>', 'what the card is about')
    .option('--column <column>', 'the column to put it in, by slug, name or id (default: To Do for a person, the board\'s first column for an agent)')
    .option('--parent <card>', 'the card this one is part of')
    .option('--execution-mode <mode>', 'where the work happens: worktree (its own checkout) or main', parseExecutionMode))
    .action(async (options: CreateOptions) => {
      await runBoardCommand(options, 'write', async (session) => {
        const parent = options.parent ? await requireCard(session, options.parent) : null
        const created = await session.ops.createCard({
          workspace: session.workspace,
          title: options.title,
          description: options.description,
          statusName: options.column ?? await readDefaultColumn(session),
          parentIssueId: parent?.id,
          executionMode: options.executionMode,
        }, createPlacementActor())
        return await presentCard(session, created)
      })
    })

  withBoardOptions(card
    .command('update')
    .description('Change a card\'s title, description, priority, labels or parent')
    .argument('<card>', 'the card, as MAN-012, MAN-12 or 12')
    .option('--title <title>', 'what the card is called')
    .option('--description <text>', 'what the card is about')
    .option('--priority <priority>', `one of ${PRIORITIES.join(', ')}`, parsePriority)
    .option('--labels <labels>', 'comma-separated labels, replacing the ones the card has', parseLabels)
    .option('--execution-mode <mode>', 'where the work happens: worktree (its own checkout) or main', parseExecutionMode)
    .option('--parent <card>', 'the card to put it under; none puts it on the top level'))
    .action(async (reference: string, options: UpdateOptions) => {
      await runBoardCommand(options, 'write', async (session) => {
        const input = readUpdateInput(options)
        const existing = await requireCard(session, reference)
        if (options.parent !== undefined) {
          input.parentIssueId = options.parent === 'none' ? null : (await requireCard(session, options.parent)).id
        }
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
    .option('--text <text>', 'one sentence, present tense (required)')
    .addOption(new Option('--content <text>', 'the same as --text').hideHelp()))
    .action(async (reference: string, options: TextOptions) => {
      const text = readAliasedText('status-line', options, 'text', 'content')
      if (text === undefined) {
        throw new CliError(1, 'kanbo card status-line needs --text (one sentence). Example: kanbo card status-line TST-5 --text "Running the tests"')
      }
      await runBoardCommand(options, 'write', async (session) => {
        const existing = await requireCard(session, reference)
        return await presentCard(session, await session.ops.setStatusLine(existing.id, text, createCliActor()))
      })
    })

  withBoardOptions(card
    .command('comment')
    .description('Leave a comment on a card: a finding, a decision or a question')
    .argument('<card>', 'the card, as MAN-012, MAN-12 or 12')
    .option('--content <text>', 'what to say (required)')
    .addOption(new Option('--text <text>', 'the same as --content').hideHelp()))
    .action(async (reference: string, options: TextOptions) => {
      const content = readAliasedText('comment', options, 'content', 'text')
      if (content === undefined) {
        throw new CliError(1, 'kanbo card comment needs --content (the comment text). Example: kanbo card comment TST-5 --content "Added slugify with a test"')
      }
      await runBoardCommand(options, 'write', async (session) => {
        const existing = await requireCard(session, reference)
        const comment = await session.ops.addComment({ issueId: existing.id, content }, createCliActor())
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
    .option('--text <text>', 'the status line to leave, saying what you need')
    .addOption(new Option('--content <text>', 'the same as --text').hideHelp()))
    .action(async (reference: string, options: TextOptions) => {
      const text = readAliasedText('wait-approval', options, 'text', 'content')
      await runBoardCommand(options, 'write', async (session) => {
        const existing = await requireCard(session, reference)
        const waiting = await session.ops.waitApproval(existing.id, { statusLine: text }, createCliActor())
        return await presentCard(session, waiting)
      })
    })

  registerPullRequestCommands(card)
}

/**
 * The text a command was given under its own option or the other one agents
 * reach for (`--text` for a comment, `--content` for a status line): the MCP
 * tools take both names too. Both, saying different things, is refused.
 */
function readAliasedText(
  command: string,
  options: TextOptions,
  canonical: 'text' | 'content',
  alias: 'text' | 'content',
): string | undefined {
  const own = options[canonical]
  const other = options[alias]
  if (own !== undefined && other !== undefined && own !== other) {
    throw new CliError(1, `kanbo card ${command} got --${canonical} and --${alias} with different text; pass only --${canonical}.`)
  }
  return own ?? other
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
 * The fields `card update` was asked to change — all but the parent, a card
 * of the board, looked up there once the card itself is. A command that names
 * none of them is refused rather than obeyed: an empty update still bumps the
 * board version, and every reader would be told the board changed when it did not.
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

  if (Object.keys(input).length === 0 && options.parent === undefined) {
    throw new CliError(1, 'Nothing to update. Pass --title, --description, --priority, --labels, --execution-mode or --parent.')
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

/** A list option given comma-separated, repeated, or both. */
function collectList(value: string, previous: string[] | undefined): string[] {
  return [...(previous ?? []), ...value.split(',').map(item => item.trim()).filter(item => item.length > 0)]
}

function parsePriorities(value: string): Issue['priority'][] {
  return collectList(value, undefined).map(parsePriority)
}

function parseOffset(value: string): number {
  const count = Number(value)
  if (!Number.isInteger(count) || count < 0) {
    throw new CliError(1, `Expected a whole number of cards to skip, got "${value}".`)
  }
  return count
}

function parseMoment(value: string): number {
  try {
    return readUnixSeconds(value)
  }
  catch (error) {
    throw new CliError(2, `--updated-since: ${(error as Error).message}`)
  }
}

function parseIncludes(value: string): KanboCardInclude[] {
  if (value.trim() === 'none') {
    return []
  }
  return collectList(value, undefined).map((part) => {
    const include = KANBO_CARD_INCLUDES.find(candidate => candidate.toLowerCase() === part.toLowerCase())
    if (!include) {
      throw new CliError(1, `Unknown part "${part}". Use ${KANBO_CARD_INCLUDES.join(', ')} or none.`)
    }
    return include
  })
}

/** A column the board does not have, said the way the rest of `kanbo card` says it. */
function rethrowUnknownColumn(named: string[] | undefined) {
  return (error: unknown): never => {
    if (error instanceof BoardError && error.code === 'issue_status_not_found' && named) {
      throw new CliError(1, `This board has no column "${String(error.details?.statusName)}".`)
    }
    throw error
  }
}

/** When the page is not every picked card, say so on stderr — where the next page starts, and how to get all of them. */
function noteMoreCards(total: number, offset: number, shown: number): void {
  const more = total - offset - shown
  if (more > 0) {
    console.error(`kanbo: ${more} more of ${total}; next page: --offset ${offset + shown}, or --all for every card`)
  }
}
