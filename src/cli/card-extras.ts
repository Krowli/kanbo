import type { KanboCardCommentResult, KanboCardInclude, KanboFieldChangeResult } from '../mcp/transport'
import { projectKanboCardComment, projectKanboFieldChange } from '../mcp/transport'
import type { Issue, IssuePullRequest, IssueStatus } from '../sqlite/schema'
import type { BoardSession } from './command'
import { sanitizeTerminalText } from './terminal-text'
import type { RunView } from './view'
import { describeCards, projectCard, projectRun } from './view'

/**
 * What `kanbo card get` shows beside the card: the parts an agent would
 * otherwise ask for one command at a time. Each part is read only when asked
 * for, each in one statement.
 */
export interface CardExtras {
  subCards?: { id: string, title: string, columnSlug: string | null }[]
  /** The latest comments, oldest of them first; `commentCount` is how many the card has in all. */
  comments?: KanboCardCommentResult[]
  commentCount?: number
  runs?: RunView[]
  history?: KanboFieldChangeResult[]
  pullRequests?: Pick<IssuePullRequest, 'id' | 'owner' | 'repo' | 'number' | 'url'>[]
}

export async function readCardExtras(
  session: BoardSession,
  card: Issue,
  columns: IssueStatus[],
  include: readonly KanboCardInclude[],
  commentLimit: number,
): Promise<CardExtras> {
  const wants = new Set(include)
  const [subCards, comments, runs, history, pullRequests] = await Promise.all([
    wants.has('subCards') ? session.store.issues.listPage({ workspaceId: card.workspaceId, parentIssueId: card.id }) : null,
    wants.has('comments') ? session.store.comments.listByIssue(card.id) : null,
    wants.has('runs') ? session.ops.listRuns(card.id) : null,
    wants.has('history') ? session.store.fieldChanges.listByIssue(card.id) : null,
    wants.has('prs') ? session.store.pullRequests.listByIssue(card.id) : null,
  ])
  return {
    ...(subCards
      ? {
          subCards: subCards.cards.map((row) => {
            const view = projectCard(row, columns, { issueId: row.id, attemptCount: 0, activeRun: null })
            return { id: view.id, title: view.title, columnSlug: view.columnSlug }
          }),
        }
      : {}),
    ...(comments ? { comments: comments.slice(-commentLimit).map(projectKanboCardComment), commentCount: comments.length } : {}),
    ...(runs ? { runs: runs.map(projectRun) } : {}),
    ...(history ? { history: history.map(projectKanboFieldChange) } : {}),
    ...(pullRequests
      ? { pullRequests: pullRequests.map(link => ({ id: link.id, owner: link.owner, repo: link.repo, number: link.number, url: link.url })) }
      : {}),
  }
}

/** A unix-seconds moment as `YYYY-MM-DD HH:MM` UTC. */
function formatMoment(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 16).replace('T', ' ')
}

/** The parts under the card, each under a heading; nothing for a part that was not asked for. */
export function describeCardExtras(extras: CardExtras): string {
  const sections: string[] = []
  if (extras.subCards && extras.subCards.length > 0) {
    sections.push(['Sub-cards:', describeCards(extras.subCards.map(sub => ({ ...sub, description: null, column: sub.columnSlug })))].join('\n'))
  }
  if (extras.comments && extras.comments.length > 0) {
    const heading = extras.commentCount === extras.comments.length
      ? 'Comments:'
      : `Comments (last ${extras.comments.length} of ${extras.commentCount}):`
    sections.push([heading, ...extras.comments.map(comment =>
      `${formatMoment(comment.createdAt)}  ${comment.author}: ${sanitizeTerminalText(comment.content)}`)].join('\n'))
  }
  if (extras.runs && extras.runs.length > 0) {
    sections.push(['Runs:', ...extras.runs.map(run =>
      `#${run.attempt}  ${run.state}  ${sanitizeTerminalText(run.agentName)}  ${formatMoment(run.startedAt)}  ${run.id}`)].join('\n'))
  }
  if (extras.history && extras.history.length > 0) {
    sections.push(['History:', ...extras.history.map(change =>
      `${formatMoment(change.createdAt)}  ${change.actor}  ${change.field}: ${sanitizeTerminalText(change.from ?? '—')} → ${sanitizeTerminalText(change.to ?? '—')}`)].join('\n'))
  }
  if (extras.pullRequests && extras.pullRequests.length > 0) {
    sections.push(['Pull requests:', ...extras.pullRequests.map(link => `${link.owner}/${link.repo}#${link.number}  ${link.url}`)].join('\n'))
  }
  return sections.join('\n\n')
}
