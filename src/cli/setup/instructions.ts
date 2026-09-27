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
import { LEGACY_BLOCK_BODIES } from './legacy-blocks'
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
 * start with a bare `<!-- KANBO_START -->`, and are told apart by their body
 * (`legacy-blocks.ts`). A block `kanbo instructions <kind> --markers` printed
 * says which text it is (`k=orchestrator`): only the pointer blocks
 * (`k=short`, `k=global`, or no `k`) are kanbo's to replace.
 *
 * kanbo changes only a block it wrote itself, in exactly the shape it wrote it;
 * any other block is the person's, and is shown and asked about, never
 * silently rewritten or removed. A file whose markers do not pair up is not
 * touched at all.
 */

/** The version of the block this build writes. */
export const INSTRUCTION_BLOCK_VERSION = 2

export const INSTRUCTION_END = '<!-- KANBO_END -->'

/**
 * Any start marker: the bare one of 0.1–0.2, or one with fields — a version,
 * a kind, a hash, or whatever a newer kanbo puts there.
 */
const INSTRUCTION_START_PATTERN = /<!-- KANBO_START\b([^>]*?)\s*-->/g
const INSTRUCTION_END_PATTERN = /<!-- KANBO_END\s*-->/g

/** The kinds of block that are kanbo's pointer — the one `kanbo connect` writes. */
const POINTER_KINDS = new Set(['short', 'global'])

/**
 * What a block found in a file is, next to the one this build writes there:
 * - `current` — the same block;
 * - `outdated` — written by kanbo (an older one, or for the other scope) and not changed since;
 * - `legacy` — written word for word by kanbo 0.1–0.2, whose marker says nothing more;
 * - `edited` — a person changed it: its body no longer matches the hash on its
 *   marker, or a bare-marker body is none that 0.1–0.2 wrote;
 * - `newer` — written by a newer kanbo, which this one does not know how to read;
 * - `chosen` — the person put a text other than the pointer there
 *   (`kanbo instructions orchestrator --markers`, say);
 * - `damaged` — its markers do not pair up: a start without an end, an end
 *   without a start, or a start inside another block.
 */
export type InstructionBlockState = 'current' | 'outdated' | 'legacy' | 'edited' | 'newer' | 'chosen' | 'damaged'

/** A block's state, with what its marker said. */
export interface InstructionBlockInspection {
  state: InstructionBlockState
  /** The version on its marker; `null` on a bare one. */
  version: number | null
  /** The text it says it is (`k=…`); `null` when it says none. */
  kind: string | null
  /** For a damaged file: what is wrong with its markers, as a sentence's object. */
  damage?: string
}

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

/**
 * The block, markers included, with this body's version and hash on the start
 * marker — and, when given, the kind of text it is (`k=orchestrator`).
 */
export function wrapInstructionBlock(body: string, version = INSTRUCTION_BLOCK_VERSION, kind?: string): string {
  return `<!-- KANBO_START v${version}${kind ? ` k=${kind}` : ''} h=${hashBody(body)} -->\n${body}\n${INSTRUCTION_END}`
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
  return inspectBlock(text, current)?.state ?? null
}

/** The same, with what the block's marker said. */
export function inspectBlock(text: string, current: string): InstructionBlockInspection | null {
  const normalized = text.replace(/\r\n/g, '\n')
  const found = findBlock(normalized)
  if (found === null) {
    return null
  }
  if ('damage' in found) {
    return { state: 'damaged', version: null, kind: null, damage: found.damage }
  }
  const { fields } = found
  const version = /(?:^|\s)v(\d+)(?=\s|$)/.exec(fields)?.[1]
  const kind = /(?:^|\s)k=(\S+)/.exec(fields)?.[1] ?? null
  const hash = /(?:^|\s)h=([0-9a-f]{8})(?=\s|$)/.exec(fields)?.[1]
  const body = normalized.slice(found.bodyStart, found.bodyEnd).replace(/^\n/, '').replace(/\n$/, '')
  const inspection = (state: InstructionBlockState): InstructionBlockInspection => ({
    state,
    version: version === undefined ? null : Number(version),
    kind,
  })
  if (fields.trim() === '') {
    return inspection(LEGACY_BLOCK_BODIES.includes(body) ? 'legacy' : 'edited')
  }
  if (version !== undefined && Number(version) > INSTRUCTION_BLOCK_VERSION) {
    return inspection('newer')
  }
  if (kind !== null && !POINTER_KINDS.has(kind)) {
    return inspection('chosen')
  }
  if (version === undefined || hash === undefined || hashBody(body) !== hash) {
    return inspection('edited')
  }
  return inspection(normalized.slice(found.start, found.end) === current ? 'current' : 'outdated')
}

/** What the person is told about a file whose markers do not pair up; `label` names the file. */
export function damagedBlockMessage(label: string, damage: string): string {
  return `${label} has ${damage} — fix it by hand, then run again.`
}

/** What the person is told about a block a newer kanbo wrote. */
export function newerBlockMessage(label: string, version: number | null): string {
  return `${label}: the kanbo section was written by a newer kanbo (v${version ?? '?'}) — kept. `
    + 'Update kanbo: npm install -g kanbo-cli@latest'
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
 * The same, minding a block that is not kanbo's to replace: one the person
 * changed is replaced only when they say so at a terminal, and the default
 * answer is no. `--yes` is not that answer — it agrees to kanbo's own changes,
 * not to losing theirs. A block of a text the person chose, one a newer kanbo
 * wrote, and a file whose markers do not pair up are left as they are.
 */
export async function planInstructionBlockAsking(
  path: string,
  block: string,
  options: { yes?: boolean, /** How the file is named to the person; the path itself by default. */ label?: string },
): Promise<PlannedInstructionBlock> {
  const inspection = readInstructionBlockInspection(path, block)
  const label = options.label ?? path
  const keep = (note: string): PlannedInstructionBlock => ({ change: { path, next: null }, note })
  switch (inspection?.state) {
    case 'damaged':
      return keep(damagedBlockMessage(label, inspection.damage!))
    case 'newer':
      return keep(newerBlockMessage(label, inspection.version))
    case 'chosen':
      return keep(`${label}: you chose the ${inspection.kind} text for the kanbo section — kept.`)
    case 'edited': {
      const replace = !options.yes && canPrompt() && await getUi().confirm({
        message: `You changed the kanbo section in ${label}. Replace it with the current one?`,
        initialValue: false,
      })
      return replace
        ? { change: planInstructionBlock(path, block) }
        : keep(`${label}: you changed the kanbo section, so it was left as it is.`)
    }
    default:
      return { change: planInstructionBlock(path, block) }
  }
}

/**
 * The file without the block, or no change when it carries none. The file
 * itself stays even when nothing is left in it: kanbo does not record which
 * files it created, and a person's file is not this tool's to delete. A file
 * whose markers do not pair up is not changed.
 */
export function planInstructionBlockRemoval(path: string): FileChange {
  return planTextFile(path, (existing) => {
    const bounds = existing === null ? null : findBlock(existing)
    if (existing === null || bounds === null || 'damage' in bounds) {
      return null
    }
    const before = existing.slice(0, bounds.start).replace(/\s*$/, '')
    const after = existing.slice(bounds.end).trim()
    const joined = [before, after].filter(part => part.length > 0).join('\n\n')
    return joined ? `${joined}\n` : ''
  })
}

/**
 * The same, minding a block that is not plainly kanbo's: one the person
 * changed, chose, or a newer kanbo wrote goes only on a yes at a terminal
 * (default no) or on `--yes`; with neither it is kept, and the person is told.
 * A file whose markers do not pair up is never changed.
 */
export async function planInstructionBlockRemovalAsking(
  path: string,
  options: { yes?: boolean, /** False when nobody may be asked (a dry run). */ prompt?: boolean, label?: string },
): Promise<PlannedInstructionBlock> {
  const inspection = readInstructionBlockInspection(path, INSTRUCTION_BLOCK)
  const label = options.label ?? path
  const keep = (note: string): PlannedInstructionBlock => ({ change: { path, next: null }, note })
  switch (inspection?.state) {
    case undefined:
      return { change: { path, next: null } }
    case 'damaged':
      return keep(damagedBlockMessage(label, inspection.damage!))
    case 'edited':
    case 'chosen':
    case 'newer': {
      const remove = options.yes || (options.prompt !== false && canPrompt() && await getUi().confirm({
        message: `You changed the kanbo section in ${label}. Remove it anyway?`,
        initialValue: false,
      }))
      return remove
        ? { change: planInstructionBlockRemoval(path) }
        : keep(`${label}: you changed the kanbo section, so it was kept. Remove it with --yes.`)
    }
    default:
      return { change: planInstructionBlockRemoval(path) }
  }
}

/**
 * The block a file carries, markers included, or `null` when it carries none
 * (or its markers do not pair up) — with `\n` line endings whatever the file uses.
 */
export function readInstructionBlock(path: string): string | null {
  const existing = readTextFile(path)?.text ?? null
  const bounds = existing === null ? null : findBlock(existing)
  return existing === null || bounds === null || 'damage' in bounds ? null : existing.slice(bounds.start, bounds.end)
}

/** What the block in that file is, next to `current`; `null` when there is no block or no file. */
export function readInstructionBlockState(path: string, current: string): InstructionBlockState | null {
  return readInstructionBlockInspection(path, current)?.state ?? null
}

/** The same, with what the block's marker said. */
export function readInstructionBlockInspection(path: string, current: string): InstructionBlockInspection | null {
  const text = readTextFile(path)?.text
  return text === undefined ? null : inspectBlock(text, current)
}

function withBlock(existing: string | null, block: string): string | null {
  if (existing === null || !existing.trim()) {
    return `${block}\n`
  }
  const bounds = findBlock(existing)
  if (bounds && 'damage' in bounds) {
    return null
  }
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
  /** What the start marker says after `KANBO_START`; empty on a 0.1–0.2 marker. */
  fields: string
}

/**
 * The first block in the text; `null` when there is none; `{ damage }` when
 * the markers do not pair up — every start followed by its end before the
 * next start, and no end without a start.
 */
function findBlock(text: string): BlockBounds | { damage: string } | null {
  const markers = [
    ...[...text.matchAll(INSTRUCTION_START_PATTERN)].map(match => ({ start: true, match })),
    ...[...text.matchAll(INSTRUCTION_END_PATTERN)].map(match => ({ start: false, match })),
  ].sort((a, b) => a.match.index - b.match.index)
  if (markers.length === 0) {
    return null
  }
  for (let index = 0; index < markers.length; index += 2) {
    const open = markers[index]!
    const close = markers[index + 1]
    if (!open.start) {
      return { damage: 'a kanbo end marker without a start' }
    }
    if (!close) {
      return { damage: 'a kanbo start marker without an end' }
    }
    if (close.start) {
      return { damage: 'a kanbo start marker inside another kanbo section' }
    }
  }
  const [open, close] = markers as [typeof markers[number], typeof markers[number]]
  const bodyStart = open.match.index + open.match[0].length
  return {
    start: open.match.index,
    end: close.match.index + close.match[0].length,
    bodyStart,
    bodyEnd: close.match.index,
    fields: open.match[1] ?? '',
  }
}

/** The first eight hex digits of the SHA-256 of the body, with `\n` line endings. */
function hashBody(body: string): string {
  return createHash('sha256').update(body.replace(/\r\n/g, '\n'), 'utf8').digest('hex').slice(0, 8)
}
