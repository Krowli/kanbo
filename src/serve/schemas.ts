import { z } from 'zod'

/**
 * The request shapes `kanbo serve` takes: the bodies and queries of the
 * board's `/issues` routes, in zod. An app that serves the same routes takes
 * the same shapes, so a client that builds a request for one builds it for the
 * other, and a field one does not take is not taken by the other either.
 */

const priority = z.enum(['none', 'low', 'medium', 'high', 'urgent'])
const category = z.enum(['triage', 'backlog', 'unstarted', 'started', 'completed', 'canceled'])
const executionMode = z.enum(['worktree', 'main'])
const milestoneStatus = z.enum(['open', 'closed'])
const relationType = z.enum(['blocks', 'duplicates', 'relates_to'])
const id = z.string().min(1)

/**
 * The column's entry rules. Any string is taken, so an unknown rule is refused
 * by the board as `board_entry_rule_invalid` naming it, not by the schema.
 */
const entryRules = z.array(z.string()).nullable().optional()

/** A list given as `a,b` or as the parameter repeated; `a=` is the empty list. */
const requiredCommaList = z.union([z.string(), z.array(z.string())])
  .transform(value => (Array.isArray(value) ? value : value.split(',')).map(item => item.trim()).filter(Boolean))
const commaList = requiredCommaList.optional()

/** A number in a query string, where everything arrives as text. */
const queryNumber = z.string().regex(/^\d+$/).transform(Number)

export const workspaceIdQuery = z.object({ workspaceId: id.optional() })
export const requiredWorkspaceIdQuery = z.object({ workspaceId: id })
export const workspaceIdsQuery = z.object({ workspaceIds: requiredCommaList })
export const searchQuery = z.object({ q: z.string(), limit: z.string().optional() })
export const readyQuery = z.object({ workspaceId: id, limit: queryNumber.optional() })

export const listIssuesQuery = z.object({
  workspaceId: id.optional(),
  workspaceIds: commaList,
  milestoneId: z.string().optional(),
  parentIssueId: z.string().optional(),
  priority: z.string().optional(),
  labels: commaList,
  statusId: z.string().optional(),
})

export const createStatusBody = z.object({
  workspaceId: id,
  name: id,
  description: z.string().nullable().optional(),
  color: z.string().nullable().optional(),
  category: category.optional(),
  entryRules,
})

export const updateStatusBody = z.object({
  name: id.optional(),
  description: z.string().nullable().optional(),
  color: z.string().nullable().optional(),
  entryRules,
})

export const workspaceIdBody = z.object({ workspaceId: id })

/** Where the cards of a column being deleted go — in the body or the query; required when it holds any. */
export const removeStatusBody = z.object({ moveCardsTo: id.optional() })
export const removeStatusQuery = z.object({ moveCardsTo: id.optional() })

export const reorderStatusesBody = z.object({ workspaceId: id, orderedIds: z.array(z.string()) })

export const createMilestoneBody = z.object({
  workspaceId: id,
  title: id,
  description: z.string().nullable().optional(),
  startDate: z.number().nullable().optional(),
  dueDate: z.number().nullable().optional(),
  status: milestoneStatus.optional(),
})

export const updateMilestoneBody = z.object({
  title: id.optional(),
  description: z.string().nullable().optional(),
  startDate: z.number().nullable().optional(),
  dueDate: z.number().nullable().optional(),
  status: milestoneStatus.optional(),
})

export const closeSprintBody = z.object({ carryTo: id.nullable().optional() })

export const createIssueBody = z.object({
  workspaceId: id,
  title: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  priority: priority.optional(),
  labels: z.array(z.string()).optional(),
  milestoneId: z.string().nullable().optional(),
  parentIssueId: z.string().nullable().optional(),
  statusId: z.string().nullable().optional(),
  statusName: id.nullable().optional(),
  dueDate: z.number().nullable().optional(),
  assigneeKind: z.string().nullable().optional(),
  assigneeId: z.string().nullable().optional(),
  executionMode: executionMode.optional(),
})

export const updateIssueBody = z.object({
  workspaceId: id.optional(),
  title: id.optional(),
  description: z.string().nullable().optional(),
  priority: priority.optional(),
  labels: z.array(z.string()).optional(),
  milestoneId: z.string().nullable().optional(),
  parentIssueId: z.string().nullable().optional(),
  statusId: z.string().nullable().optional(),
  statusName: id.nullable().optional(),
  assigneeKind: z.string().nullable().optional(),
  assigneeId: z.string().nullable().optional(),
  dueDate: z.number().nullable().optional(),
  order: z.number().optional(),
  executionMode: executionMode.optional(),
})

export const reorderIssuesBody = z.object({
  workspaceId: id,
  orderedIds: z.array(z.string()),
  patch: z.object({
    issueIds: z.array(z.string()),
    fields: z.object({
      priority: priority.optional(),
      milestoneId: z.string().nullable().optional(),
      statusId: z.string().nullable().optional(),
      assigneeKind: z.string().nullable().optional(),
      assigneeId: z.string().nullable().optional(),
    }),
  }).optional(),
})

export const bulkUpdateBody = z.object({
  issueIds: z.array(z.string()),
  update: z.object({
    statusId: z.string().nullable().optional(),
    priority: priority.optional(),
    labels: z.array(z.string()).optional(),
    milestoneId: z.string().nullable().optional(),
    assigneeKind: z.string().nullable().optional(),
    assigneeId: z.string().nullable().optional(),
    dueDate: z.number().nullable().optional(),
  }),
})

export const setStatusLineBody = z.object({ statusLine: z.string().nullable() })
export const waitApprovalBody = z.object({ statusLine: z.string().nullable().optional() })
export const approveBody = z.object({ comment: z.string().nullable().optional() })
export const returnBody = z.object({ comment: id, toStatusName: id.nullable().optional() })

export const startRunBody = z.object({
  agentName: id,
  host: z.string().nullable().optional(),
  branch: z.string().nullable().optional(),
  executionMode: executionMode.optional(),
  launchedByKind: z.enum(['user', 'agent', 'external']).optional(),
  externalSessionRef: z.string().nullable().optional(),
})

export const finishRunBody = z.object({
  state: z.enum(['finished', 'failed', 'stopped']),
  branch: z.string().nullable().optional(),
  worktreePath: z.string().nullable().optional(),
  errorText: z.string().nullable().optional(),
  externalSessionRef: z.string().nullable().optional(),
})

export const addCommentBody = z.object({ content: id })
export const createRelationBody = z.object({ sourceIssueId: id, targetIssueId: id, type: relationType })
export const addContextRefBody = z.object({ ref: id })
export const addPullRequestBody = z.object({ url: id })
