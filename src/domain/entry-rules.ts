import { z } from 'zod'

import type { IssueStatus } from '../sqlite/schema'
import { BoardError } from './errors'

/**
 * What a column may ask of a card before an agent puts the card in it (ruling
 * 6-1). The set is fixed: each rule is one fact the board can check on its own.
 *
 * - `checklist_complete` — the description holds at least one markdown task
 *   item, and every one of them is checked.
 * - `pull_request_linked` — the card names at least one pull request.
 * - `ci_green` — the newest CI verdict across the card's linked pull requests
 *   is green.
 * - `approved` — a person's last decision on the card was to approve it.
 */
export const ENTRY_RULES = ['checklist_complete', 'pull_request_linked', 'ci_green', 'approved'] as const

export type EntryRule = typeof ENTRY_RULES[number]

/** Why a rule is unmet, as a key a translated surface can name in its own words. */
export const UNMET_ENTRY_RULE_REASONS = [
  'no_checklist',
  'unchecked',
  'no_pull_request',
  'no_ci',
  'ci_red',
  'approval_pending',
  'returned',
  'not_approved',
] as const

type UnmetEntryRuleReason = typeof UNMET_ENTRY_RULE_REASONS[number]

/**
 * One rule a card does not meet yet: `detail` says what is missing in English
 * words the command line and MCP print; `reason` (with `checked` and `total`
 * for `unchecked`) says the same for a surface that translates it.
 */
export interface UnmetEntryRule {
  rule: EntryRule
  reason: UnmetEntryRuleReason
  detail: string
  checked?: number
  total?: number
}

/** What `evaluateEntryRules` needs to know beyond the card's own fields. */
export interface EntryRuleFacts {
  /** How many pull requests the card names. */
  pullRequestCount: number
  /** The newest CI verdict across those pull requests, or `null` while none has arrived. */
  latestCi: 'green' | 'red' | null
  /** Where the card stands with the person who approves it (`BoardApproval['state']`). */
  approval: 'none' | 'pending' | 'approved' | 'returned'
}

const entryRulesSchema = z.array(z.enum(ENTRY_RULES))

/**
 * The rules a caller asked for, as the column stores them: known rules only,
 * each once, in `ENTRY_RULES` order, and `null` for none — an empty list and no
 * list are the same column. An unknown rule is `board_entry_rule_invalid`,
 * before anything is written.
 */
export function serializeEntryRules(rules: readonly string[] | null): string | null {
  const parsed = entryRulesSchema.safeParse(rules ?? [])
  if (!parsed.success) {
    const invalid = (rules ?? []).filter(rule => !(ENTRY_RULES as readonly string[]).includes(rule))
    throw new BoardError('board_entry_rule_invalid', { rules: invalid, allowed: [...ENTRY_RULES] })
  }
  const chosen = ENTRY_RULES.filter(rule => parsed.data.includes(rule))
  return chosen.length > 0 ? JSON.stringify(chosen) : null
}

/**
 * The rules a column asks for. A rule this build does not know — written by a
 * newer one — is left out rather than failing the read: the column still
 * enforces everything this build can check.
 */
export function readEntryRules(column: Pick<IssueStatus, 'entryRules'>): EntryRule[] {
  if (!column.entryRules) {
    return []
  }
  const stored: string[] = JSON.parse(column.entryRules)
  return ENTRY_RULES.filter(rule => stored.includes(rule))
}

/** How many markdown task items a description holds, and how many are checked. */
export interface ChecklistProgress {
  total: number
  checked: number
}

/** A list item that is a task: `- [ ]`, `* [x]`, `+ [X]`, `1. [ ]`, at any depth. */
const TASK_ITEM = /^\s*(?:[-*+]|\d{1,9}[.)])\s+\[([ x])\](?:\s|$)/i
/** The line that opens or closes a fenced code block: three or more backticks or tildes. */
const FENCE = /^\s*(`{3,}|~{3,})/

/**
 * Count the task items of a markdown description.
 *
 * Every list item that starts with `[ ]` or `[x]` (either case) counts,
 * nested ones included — a sub-task is still a task. Lines inside a fenced code
 * block (```` ``` ```` or `~~~`) do not: a `- [ ]` there is an example someone
 * quoted, not a box anyone can tick. An indented code block cannot be told
 * apart from a nested list without a full markdown parser, so it counts; fence
 * the example to keep it out.
 */
export function readChecklist(description: string | null): ChecklistProgress {
  let total = 0
  let checked = 0
  let fence: string | null = null
  for (const line of (description ?? '').split(/\r?\n/)) {
    const marker = FENCE.exec(line)?.[1]
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) {
        fence = null
      }
      continue
    }
    if (marker) {
      fence = marker
      continue
    }
    const item = TASK_ITEM.exec(line)
    if (item) {
      total++
      if (item[1] !== ' ') {
        checked++
      }
    }
  }
  return { total, checked }
}

/**
 * The rules a card does not meet, in the order the column lists them (ruling
 * 6-2). Pure: everything beyond the card's own description arrives in `facts`.
 */
export function evaluateEntryRules(
  card: { description: string | null },
  rules: readonly EntryRule[],
  facts: EntryRuleFacts,
): { unmet: UnmetEntryRule[] } {
  const unmet: UnmetEntryRule[] = []
  for (const rule of rules) {
    const missing = unmetReason(rule, card, facts)
    if (missing) {
      unmet.push({ rule, ...missing })
    }
  }
  return { unmet }
}

/** Why the card fails `rule`, or `null` when it meets it. */
function unmetReason(
  rule: EntryRule,
  card: { description: string | null },
  facts: EntryRuleFacts,
): Omit<UnmetEntryRule, 'rule'> | null {
  switch (rule) {
    case 'checklist_complete': {
      const { total, checked } = readChecklist(card.description)
      if (total === 0) {
        return { reason: 'no_checklist', detail: 'no checklist in the description' }
      }
      return checked < total ? { reason: 'unchecked', detail: `${total - checked} of ${total} unchecked`, checked, total } : null
    }
    case 'pull_request_linked':
      return facts.pullRequestCount > 0 ? null : { reason: 'no_pull_request', detail: 'no pull request linked' }
    case 'ci_green':
      if (facts.latestCi === 'green') {
        return null
      }
      return facts.latestCi === 'red' ? { reason: 'ci_red', detail: 'CI is red' } : { reason: 'no_ci', detail: 'no CI result yet' }
    case 'approved':
      switch (facts.approval) {
        case 'approved':
          return null
        case 'pending':
          return { reason: 'approval_pending', detail: 'waiting for a person to approve' }
        case 'returned':
          return { reason: 'returned', detail: 'returned by a person, not approved' }
        case 'none':
          return { reason: 'not_approved', detail: 'not approved by a person' }
      }
  }
}

/** What `ENTRY_RULES` each mean, in the words the prime text and the manifest use. */
export const ENTRY_RULE_DESCRIPTIONS: Record<EntryRule, string> = {
  checklist_complete: 'every checkbox (`- [ ]`) in the card description is checked, and there is at least one',
  pull_request_linked: 'at least one pull request is linked to the card',
  ci_green: 'the newest CI result across the card\'s linked pull requests is green',
  approved: 'a person has approved the card',
}

/** What `board_column_rules_unmet` carries in its details. */
export interface ColumnRefusalDetails {
  /** The card that was held back; `null` for one that was being created. */
  issueId: string | null
  column: string
  statusId: string
  unmet: UnmetEntryRule[]
}

/**
 * A refusal at a column's door as a person or an agent reads it: the error code
 * first, so a caller matching on it still can, then one line per unmet rule.
 * The command line and the MCP tools say it in exactly these words.
 */
export function describeColumnRefusal(details: ColumnRefusalDetails): string {
  const card = details.issueId ? `${details.issueId} cannot enter` : 'A new card cannot be created in'
  return [
    `board_column_rules_unmet: ${card} "${details.column}" yet:`,
    ...details.unmet.map(item => `- ${item.rule}: ${item.detail}`),
  ].join('\n')
}
