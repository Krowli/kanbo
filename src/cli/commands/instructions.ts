import type { Command } from 'commander'

import { KANBO_MCP_INSTRUCTIONS } from '../../mcp/instructions'
import { openBoardSession } from '../command'
import { DATABASE_NOT_FOUND_MESSAGE } from '../db-target'
import { CliError, EXIT_NOT_RESOLVED } from '../output'
import type { ClipboardEnvironment } from '../setup/clipboard'
import { copyToClipboard } from '../setup/clipboard'
import { AGENT_GUIDE_TEXT, COMMAND_SHEET, GLOBAL_BODY, INSTRUCTION_BLOCK_VERSION, PROJECT_BODY, wrapInstructionBlock } from '../setup/instructions'
import { ORCHESTRATOR_GUIDE } from '../setup/orchestrator-guide'

/**
 * `kanbo instructions` — the text to give an agent, without a trip to GitHub.
 *
 * The text goes to stdout and nothing else does, so `kanbo instructions >>
 * AGENTS.md` writes exactly the text. The two lines around it that say what to
 * do with it go to stderr, and only when stderr is a terminal a person reads.
 */

/** The versions of the text, as typed after `kanbo instructions`. */
export const INSTRUCTION_KINDS = ['agent', 'short', 'global', 'orchestrator', 'mcp', 'board'] as const

export type InstructionKind = typeof INSTRUCTION_KINDS[number]

/** What `board` says in a folder with no board. */
export const NO_BOARD_FOR_INSTRUCTIONS_MESSAGE
  = 'This folder has no kanbo board, so there are no board rules to print. Run "kanbo init" here to set one up, '
    + 'or ask for a version that needs no board: agent | short | global | orchestrator | mcp.'

const HEADER = 'Paste this into CLAUDE.md or AGENTS.md — or run `kanbo connect <agent>` to have kanbo do it.'
const FOOTER = 'Copy it: kanbo instructions --copy · Other versions: short | global | orchestrator | mcp | board'

/**
 * The text of each version that needs no board. A function, not a table: the
 * MCP instructions sit on an import cycle back to this command list (through
 * the capabilities manifest), and a table built at load time would hold
 * `undefined` for them.
 */
function staticText(kind: Exclude<InstructionKind, 'board'>): string {
  switch (kind) {
    case 'agent':
      return AGENT_GUIDE_TEXT
    case 'short':
      return PROJECT_BODY
    case 'global':
      return GLOBAL_BODY
    case 'orchestrator':
      return ORCHESTRATOR_GUIDE
    case 'mcp':
      return KANBO_MCP_INSTRUCTIONS
  }
}

interface InstructionsOptions {
  copy?: boolean
  markers?: boolean
}

/** What the command reaches outside itself for; tests hand in their own clipboard. */
export interface InstructionsCommandDependencies {
  clipboard?: ClipboardEnvironment
}

export function registerInstructionsCommand(program: Command, dependencies: InstructionsCommandDependencies = {}): void {
  program
    .command('instructions')
    .description('print the text to give an agent: agent (default), short, global, orchestrator, mcp or board')
    .argument('[kind]', 'which version: agent, short, global, orchestrator, mcp or board', 'agent')
    .option('--copy', 'also put the text on the clipboard')
    .option('--markers', 'wrap the text in the kanbo section markers, which say which text it is; kanbo connect keeps any but short and global')
    .action(async (kind: string, options: InstructionsOptions) => {
      const found = parseKind(kind)
      const body = await readInstructionText(found)
      // The pointer (short, global) comes out exactly as kanbo connect writes it; any other text's
      // marker says which one it is (k=orchestrator), and kanbo connect leaves that block alone.
      const pointer = found === 'short' || found === 'global'
      const text = options.markers ? wrapInstructionBlock(body, INSTRUCTION_BLOCK_VERSION, pointer ? undefined : found) : body

      const hints = process.stderr.isTTY === true
      if (hints) {
        process.stderr.write(`${HEADER}\n\n`)
      }
      console.log(text)
      if (hints) {
        process.stderr.write(`\n${FOOTER}\n`)
      }
      if (options.copy) {
        process.stderr.write(`${describeCopy(await copyToClipboard(text, dependencies.clipboard))}\n`)
      }
    })
}

function parseKind(kind: string): InstructionKind {
  const found = INSTRUCTION_KINDS.find(candidate => candidate === kind)
  if (!found) {
    throw new CliError(1, `Unknown version "${kind}". Use one of: ${INSTRUCTION_KINDS.join(', ')}.`)
  }
  return found
}

/** The text of one version; `board` reads this folder's board, as `kanbo prime` prints it. */
async function readInstructionText(kind: InstructionKind): Promise<string> {
  if (kind !== 'board') {
    return staticText(kind)
  }
  const session = await openBoardSession({}, 'read').catch((error: unknown) => {
    if (error instanceof CliError && error.exitCode === EXIT_NOT_RESOLVED && error.message === DATABASE_NOT_FOUND_MESSAGE) {
      throw new CliError(EXIT_NOT_RESOLVED, NO_BOARD_FOR_INSTRUCTIONS_MESSAGE)
    }
    throw error
  })
  try {
    return `${await session.ops.buildPrimeText(session.workspace.id)}\n\n${COMMAND_SHEET}`
  }
  finally {
    await session.close()
  }
}

function describeCopy(outcome: Awaited<ReturnType<typeof copyToClipboard>>): string {
  switch (outcome) {
    case 'copied':
      return 'Copied to the clipboard.'
    case 'osc52':
      return 'Sent to your terminal\'s clipboard (OSC 52).'
    case 'unavailable':
      return 'Couldn\'t reach a clipboard — select the text above.'
  }
}
