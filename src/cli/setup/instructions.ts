import { createHash } from 'node:crypto'

import {
  COMMENT_RULE,
  MOVE_CARD_RULE,
  OWN_SESSION_RULE,
  PERSON_ONLY_RULE,
  STATUS_LINE_RULE,
  SUBTASK_RULE,
  WAIT_FOR_PERSON_RULE,
} from '../../ops/agent-rules'
import { canPrompt } from '../ui/environment'
import { getUi } from '../ui/ui'
import type { FileChange } from './file-change'
import { planTextFile, readTextFile } from './text-file'

/**
 * The instruction block kanbo writes into an agent's standing instructions,
 * and the three things done to it: written, found again, taken out.
 *
 * The block is a pointer, not the rules: it tells an agent the project is on a
 * board and to run `kanbo prime`, which prints the board's columns, its rules
 * and — from the command line — the commands. The rules can then change
 * without every project's `CLAUDE.md` going out of date.
 *
 * Two versions of the block exist. The project block says "this project is on
 * a board"; the global one, for a person's user-level file, says "a project
 * with `.kanbo/` is on a board" and binds nothing — one user file serves every
 * project, and most of them have no board.
 *
 * The start marker carries the block's version and a hash of its body
 * (`<!-- KANBO_START v2 h=1a2b3c4d -->`), so a block a person changed by hand
 * can be told apart from one an older kanbo wrote. Blocks from kanbo 0.1–0.2
 * start with a bare `<!-- KANBO_START -->`.
 */

/** The version of the block this build writes. */
export const INSTRUCTION_BLOCK_VERSION = 2

export const INSTRUCTION_END = '<!-- KANBO_END -->'

/** Either start marker: the bare one of 0.1–0.2, or one with a version and a hash. */
const INSTRUCTION_START_PATTERN = /<!-- KANBO_START(?: v(\d+) h=([0-9a-f]{8}))? -->/

/**
 * What a block found in a file is, next to the one this build writes there:
 * - `current` — the same block;
 * - `outdated` — written by kanbo (an older one, or for the other scope) and not changed since;
 * - `legacy` — written by kanbo 0.1–0.2, whose marker says nothing more;
 * - `edited` — its body no longer matches the hash on its marker: a person changed it.
 */
export type InstructionBlockState = 'current' | 'outdated' | 'legacy' | 'edited'

/** The commands an agent uses, spelled once for the guide and the `kanbo prime` cheat sheet. */
const COMMAND = {
  ready: 'kanbo ready',
  move: 'kanbo card move <id> <column>',
  statusLine: 'kanbo card status-line <id> --text "..."',
  subtask: 'kanbo card create --description "..." --parent <id>',
  comment: 'kanbo card comment <id> --content "..."',
  waitApproval: 'kanbo card wait-approval <id>',
  runStart: 'kanbo run start <id> --agent <name> --session <ref>',
  capabilities: 'kanbo capabilities',
}

/**
 * What to run and when, and nothing about how to do the work: the method is
 * the person's own instructions to their agent. The rules are the sentences
 * `ops/agent-rules.ts` holds for every surface, with the command beside each.
 */
const RULE_LINES = [
  `- Take a card from \`${COMMAND.ready}\`.`,
  `- ${MOVE_CARD_RULE} (\`${COMMAND.move}\`)`,
  `- ${STATUS_LINE_RULE} (\`${COMMAND.statusLine}\`)`,
  `- ${SUBTASK_RULE} (\`${COMMAND.subtask}\`)`,
  `- ${COMMENT_RULE} (\`${COMMAND.comment}\`)`,
  `- ${WAIT_FOR_PERSON_RULE} (\`${COMMAND.waitApproval}\`)`,
  `- ${PERSON_ONLY_RULE}`,
  `- ${OWN_SESSION_RULE} (\`${COMMAND.runStart}\`)`,
  `- Run \`${COMMAND.capabilities}\` for the full list of tools, commands and rules.`,
]

/**
 * The whole guide for an agent working a board from the command line — what
 * the project block said in kanbo 0.1–0.2, before it became a pointer.
 */
export const AGENT_GUIDE_TEXT = [
  '## Kanbo board',
  '',
  'Work on this project is tracked on a kanbo board. Before starting a task run `kanbo prime` —'
  + ' it prints the board\'s columns and what each one means.',
  '',
  ...RULE_LINES,
].join('\n')

/**
 * The commands, for an agent with no MCP tools: `kanbo prime` prints this under
 * the board's rules, which say when to use each.
 */
export const COMMAND_SHEET = [
  'Commands:',
  '',
  `- \`${COMMAND.ready}\` — the cards you may take next`,
  `- \`${COMMAND.move}\` — move a card to another column`,
  `- \`${COMMAND.statusLine}\` — say what is happening on the card right now`,
  `- \`${COMMAND.comment}\` — add a finding, result, decision or question`,
  `- \`${COMMAND.subtask}\` — add a subtask`,
  `- \`${COMMAND.waitApproval}\` — ask a person, then end your turn`,
  `- \`${COMMAND.runStart}\` — record a run you started yourself`,
  `- \`${COMMAND.capabilities}\` — every tool, command and rule`,
].join('\n')

/** How to take work and who approves it — said by both blocks after their first sentence. */
const POINTER_TAIL = `Take work with \`${COMMAND.ready}\`. ${PERSON_ONLY_RULE}`

/** The body of the project block: what `kanbo instructions short` prints. */
export const PROJECT_BODY = [
  '## Kanbo board',
  '',
  'This project tracks its work on a kanbo board. Before starting a task, run `kanbo prime`'
  + ' (or call the `kanbo_prime` tool) and follow what it prints.',
  POINTER_TAIL,
].join('\n')

/** The body of the global block: what `kanbo instructions global` prints. */
export const GLOBAL_BODY = [
  '## Kanbo boards',
  '',
  'In a project with a `.kanbo/` folder, before starting a task, run `kanbo prime`'
  + ' (or call the `kanbo_prime` tool) and follow what it prints.',
  POINTER_TAIL,
  'A project without `.kanbo/` has no board: ignore this section there, and do not create one — a person sets a'
  + ' board up with `kanbo init`.',
].join('\n')

/** The block, markers included, with this body's version and hash on the start marker. */
export function wrapInstructionBlock(body: string, version = INSTRUCTION_BLOCK_VERSION): string {
  return `<!-- KANBO_START v${version} h=${hashBody(body)} -->\n${body}\n${INSTRUCTION_END}`
}

/** The block `kanbo init --instructions …` writes into a project's own file. */
export const INSTRUCTION_BLOCK = wrapInstructionBlock(PROJECT_BODY)

/** The block `kanbo init --global` writes into a person's user-level file. */
export const GLOBAL_INSTRUCTION_BLOCK = wrapInstructionBlock(GLOBAL_BODY)

/**
 * What the first block in this text is, next to `current` — the block this
 * build writes there — or `null` when the text carries none. Line endings do
 * not count: a CRLF copy of the current block is current.
 */
export function classifyBlock(text: string, current: string): InstructionBlockState | null {
  const normalized = text.replace(/\r\n/g, '\n')
  const bounds = findBlock(normalized)
  if (!bounds) {
    return null
  }
  if (bounds.hash === null) {
    return 'legacy'
  }
  const body = normalized.slice(bounds.bodyStart, bounds.bodyEnd).replace(/^\n/, '').replace(/\n$/, '')
  if (hashBody(body) !== bounds.hash) {
    return 'edited'
  }
  return normalized.slice(bounds.start, bounds.end) === current ? 'current' : 'outdated'
}

/**
 * The block in that file, once.
 *
 * A file that already carries the markers has its block replaced rather than
 * appended to, so a current block changes nothing at all and an outdated one is
 * brought forward. Everything outside the markers is the person's own writing
 * and is never touched.
 */
export function planInstructionBlock(path: string, block: string): FileChange {
  return planTextFile(path, existing => withBlock(existing, block))
}

/** A planned block, and what the person is told when their own edit was kept. */
export interface PlannedInstructionBlock {
  change: FileChange
  /** Set when the file keeps a block the person changed. */
  note?: string
}

/**
 * The same, minding a block the person changed: that one is replaced only when
 * they say so at a terminal, and the default answer is no. `--yes` is not that
 * answer — it agrees to kanbo's own changes, not to losing theirs.
 */
export async function planInstructionBlockAsking(
  path: string,
  block: string,
  options: { yes?: boolean, /** How the file is named to the person; the path itself by default. */ label?: string },
): Promise<PlannedInstructionBlock> {
  if (readInstructionBlockState(path, block) !== 'edited') {
    return { change: planInstructionBlock(path, block) }
  }
  const label = options.label ?? path
  const replace = !options.yes && canPrompt() && await getUi().confirm({
    message: `You changed the kanbo section in ${label}. Replace it with the current one?`,
    initialValue: false,
  })
  return replace
    ? { change: planInstructionBlock(path, block) }
    : { change: { path, next: null }, note: `${label}: you changed the kanbo section, so it was left as it is.` }
}

/**
 * The file without the block, or no change when it carries none. The file
 * itself stays even when nothing is left in it: kanbo does not record which
 * files it created, and a person's file is not this tool's to delete.
 */
export function planInstructionBlockRemoval(path: string): FileChange {
  return planTextFile(path, (existing) => {
    const bounds = existing === null ? null : findBlock(existing)
    if (existing === null || bounds === null) {
      return null
    }
    const before = existing.slice(0, bounds.start).replace(/\s*$/, '')
    const after = existing.slice(bounds.end).trim()
    const joined = [before, after].filter(part => part.length > 0).join('\n\n')
    return joined ? `${joined}\n` : ''
  })
}

/**
 * The block a file carries, markers included, or `null` when it carries none —
 * with `\n` line endings whatever the file uses.
 */
export function readInstructionBlock(path: string): string | null {
  const existing = readTextFile(path)?.text ?? null
  const bounds = existing === null ? null : findBlock(existing)
  return existing === null || bounds === null ? null : existing.slice(bounds.start, bounds.end)
}

/** What the block in that file is, next to `current`; `null` when there is no block or no file. */
export function readInstructionBlockState(path: string, current: string): InstructionBlockState | null {
  const block = readInstructionBlock(path)
  return block === null ? null : classifyBlock(block, current)
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

interface BlockBounds {
  start: number
  end: number
  bodyStart: number
  bodyEnd: number
  /** The hash on the start marker; `null` on a 0.1–0.2 marker. */
  hash: string | null
}

function findBlock(text: string): BlockBounds | null {
  const match = INSTRUCTION_START_PATTERN.exec(text)
  if (!match) {
    return null
  }
  const bodyStart = match.index + match[0].length
  const bodyEnd = text.indexOf(INSTRUCTION_END, bodyStart)
  if (bodyEnd < 0) {
    return null
  }
  return { start: match.index, end: bodyEnd + INSTRUCTION_END.length, bodyStart, bodyEnd, hash: match[2] ?? null }
}

/** The first eight hex digits of the SHA-256 of the body, with `\n` line endings. */
function hashBody(body: string): string {
  return createHash('sha256').update(body.replace(/\r\n/g, '\n'), 'utf8').digest('hex').slice(0, 8)
}
