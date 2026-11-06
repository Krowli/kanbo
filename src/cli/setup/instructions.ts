import { createHash } from 'node:crypto'

import { PERSON_ONLY_RULE } from '../../ops/agent-rules'
import { canPrompt } from '../ui/environment'
import { getUi } from '../ui/ui'
import type { FileChange } from './file-change'
import { LEGACY_BLOCK_BODIES } from './legacy-blocks'
import { planTextFile, readTextFile } from './text-file'

/**
 * The instruction blocks kanbo wrote into agents' standing instructions in
 * 0.5 and 0.6 (version 3), and how to recognise and take them out.
 *
 * kanbo writes no block any more: agents learn the board from the MCP server's
 * own instructions. These stay so a file carrying one — or one from an older
 * kanbo — is recognised and the block removed by `kanbo connect`,
 * `kanbo doctor --fix` and `kanbo uninstall`.
 *
 * Two versions of the block exist. The project block says "this project is on
 * a board"; the global one, for a person's user-level file, says "a project
 * with `.kanbo/` is on a board" and binds nothing.
 *
 * The start marker carries the block's version and a hash of its body
 * (`<!-- KANBO_START v3 h=1a2b3c4d -->`), so a block a person changed by hand
 * can be told apart from one an older kanbo wrote. Blocks from kanbo 0.1–0.2
 * start with a bare `<!-- KANBO_START -->`, and are told apart by their body
 * (`legacy-blocks.ts`). A block `kanbo instructions <kind> --markers` printed
 * says which text it is (`k=orchestrator`): only the pointer blocks
 * (`k=short`, `k=global`, or no `k`) are kanbo's to remove without asking.
 *
 * kanbo removes only a block it wrote itself, in exactly the shape it wrote it;
 * any other block is the person's, and is shown and asked about, never
 * silently removed. A file whose markers do not pair up is not touched at all.
 */

/** The version of the block this build writes. */
export const INSTRUCTION_BLOCK_VERSION = 3

export const INSTRUCTION_END = '<!-- KANBO_END -->'

/**
 * Any start marker: the bare one of 0.1–0.2, or one with fields — a version,
 * a kind, a hash, or whatever a newer kanbo puts there.
 */
const INSTRUCTION_START_PATTERN = /<!-- KANBO_START\b([^>]*?)\s*-->/g
const INSTRUCTION_END_PATTERN = /<!-- KANBO_END\s*-->/g

/** The kinds of block that are kanbo's pointer — the one kanbo 0.5–0.6 wrote. */
const POINTER_KINDS = new Set(['short', 'global'])

/**
 * What a block found in a file is, next to the latest one kanbo wrote there:
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

/** How to take work and who approves it — said by both blocks after their first sentence. */
const POINTER_TAIL = `Take work with \`kanbo claim\`. ${PERSON_ONLY_RULE}`

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

/** The project block kanbo 0.5–0.6 wrote into a project's own file. */
export const INSTRUCTION_BLOCK = wrapInstructionBlock(PROJECT_BODY)

/** The global block kanbo 0.5–0.6 wrote into a person's user-level file. */
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

/** A planned block removal, and what the person is told when their own edit was kept. */
export interface PlannedInstructionBlock {
  change: FileChange
  /** Set when the file keeps a block the person changed. */
  note?: string
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
