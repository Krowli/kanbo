import { existsSync, readFileSync } from 'node:fs'

import {
  COMMENT_RULE,
  MOVE_CARD_RULE,
  OWN_SESSION_RULE,
  PERSON_ONLY_RULE,
  STATUS_LINE_RULE,
  SUBTASK_RULE,
  WAIT_FOR_PERSON_RULE,
} from '../../ops/agent-rules'
import type { FileChange } from './file-change'

/**
 * The instruction block kanbo writes into an agent's standing instructions,
 * and the three things done to it: written, found again, taken out.
 *
 * Two versions of the block exist. The project block says "this project is on
 * a board"; the global one, for a person's user-level file, says "a project
 * with `.kanbo/` is on a board" and binds nothing — one user file serves every
 * project, and most of them have no board.
 */

/** The markers that make the block something this tool can find again. */
export const INSTRUCTION_START = '<!-- KANBO_START -->'
export const INSTRUCTION_END = '<!-- KANBO_END -->'

/**
 * What to run and when, and nothing about how to do the work: the method is
 * the person's own instructions to their agent. The rules are the sentences
 * `ops/agent-rules.ts` holds for every surface, with the command beside each.
 */
const RULE_LINES = [
  '- Take a card from `kanbo ready`.',
  `- ${MOVE_CARD_RULE} (\`kanbo card move <id> <column>\`)`,
  `- ${STATUS_LINE_RULE} (\`kanbo card status-line <id> --text "..."\`)`,
  `- ${SUBTASK_RULE} (\`kanbo card create --description "..." --parent <id>\`)`,
  `- ${COMMENT_RULE} (\`kanbo card comment <id> --content "..."\`)`,
  `- ${WAIT_FOR_PERSON_RULE} (\`kanbo card wait-approval <id>\`)`,
  `- ${PERSON_ONLY_RULE}`,
  `- ${OWN_SESSION_RULE} (\`kanbo run start <id> --agent <name> --session <ref>\`)`,
  '- Run `kanbo capabilities` for the full list of tools, commands and rules.',
]

/** The block `kanbo init --instructions …` writes into a project's own file. */
export const INSTRUCTION_BLOCK = [
  INSTRUCTION_START,
  '## Kanbo board',
  '',
  'Work on this project is tracked on a kanbo board. Before starting a task run `kanbo prime` —'
  + ' it prints the board\'s columns and what each one means.',
  '',
  ...RULE_LINES,
  INSTRUCTION_END,
].join('\n')

/** The block `kanbo init --global` writes into a person's user-level file. */
export const GLOBAL_INSTRUCTION_BLOCK = [
  INSTRUCTION_START,
  '## Kanbo boards',
  '',
  'A project with a `.kanbo/` directory tracks its work on a kanbo board. In such a project, before starting a task'
  + ' run `kanbo prime` (or call the `kanbo_prime` tool) — it prints the board\'s columns and what each one means.'
  + ' A project without `.kanbo/` has no board: ignore this section there, and do not create one — a person sets a'
  + ' board up with `kanbo init`.',
  '',
  ...RULE_LINES,
  INSTRUCTION_END,
].join('\n')

/**
 * The block in that file, once.
 *
 * A file that already carries the markers has its block replaced rather than
 * appended to, so a current block changes nothing at all and an outdated one is
 * brought forward. Everything outside the markers is the person's own writing
 * and is never touched.
 */
export function planInstructionBlock(path: string, block: string): FileChange {
  const existing = readText(path)
  const next = withBlock(existing, block)
  return { path, next: existing === next ? null : next }
}

/**
 * The file without the block, or no change when it carries none. The file
 * itself stays even when nothing is left in it: kanbo does not record which
 * files it created, and a person's file is not this tool's to delete.
 */
export function planInstructionBlockRemoval(path: string): FileChange {
  const existing = readText(path)
  const bounds = existing === null ? null : findBlock(existing)
  if (existing === null || bounds === null) {
    return { path, next: null }
  }
  const before = existing.slice(0, bounds.start).replace(/\s*$/, '')
  const after = existing.slice(bounds.end).trim()
  const joined = [before, after].filter(part => part.length > 0).join('\n\n')
  return { path, next: joined ? `${joined}\n` : '' }
}

/** The block a file carries, markers included, or `null` when it carries none. */
export function readInstructionBlock(path: string): string | null {
  const existing = readText(path)
  const bounds = existing === null ? null : findBlock(existing)
  return existing === null || bounds === null ? null : existing.slice(bounds.start, bounds.end)
}

function withBlock(existing: string | null, block: string): string {
  if (existing === null || !existing.trim()) {
    return `${block}\n`
  }
  const bounds = findBlock(existing)
  if (bounds) {
    return existing.slice(0, bounds.start) + block + existing.slice(bounds.end)
  }
  return `${existing.replace(/\s*$/, '')}\n\n${block}\n`
}

function findBlock(text: string): { start: number, end: number } | null {
  const start = text.indexOf(INSTRUCTION_START)
  const end = text.indexOf(INSTRUCTION_END)
  return start >= 0 && end > start ? { start, end: end + INSTRUCTION_END.length } : null
}

function readText(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null
}
