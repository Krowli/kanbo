import type { CliResult } from '../output'
import { CliError, printResult, readFormat } from '../output'
import { confirmPlan } from '../setup/confirm'
import type { FileChange } from '../setup/file-change'
import { applyFileChange } from '../setup/file-change'
import { GLOBAL_INSTRUCTION_BLOCK, planInstructionBlock } from '../setup/instructions'
import {
  claudeUserAddArgv,
  displayCommand,
  planCodexMcpServer,
  planJsonMcpServer,
  readClaudeUserMcpCommand,
  runClaudeMcp,
} from '../setup/mcp-config'
import { mcpLaunchSpec } from '../setup/mcp-launch'
import type { GlobalInstructionClient, McpClient } from '../setup/paths'
import { GLOBAL_INSTRUCTION_CLIENTS, globalInstructionPath, globalMcpConfigPath, MCP_CLIENTS } from '../setup/paths'
import type { InitOptions } from './init'

/**
 * `kanbo init --global` — this person's own agent tools, told about kanbo once
 * for every project.
 *
 * It binds no board and creates none: the block it writes says "a project with
 * `.kanbo/` is on a board", and a project becomes one with a plain `kanbo init`.
 * The MCP registrations start the same `kanbo mcp` every project registration
 * starts, which resolves the board from the folder the client starts it in —
 * on Windows spelled as this Node and this kanbo's script (`mcp-launch.ts`).
 *
 * Every change is worked out first and shown; nothing is written until the
 * person says yes (or said `--yes`), and a file that already says it is
 * reported `unchanged`.
 */

/** Written when `--instructions` is not given. Gemini is asked for by name. */
const DEFAULT_INSTRUCTION_CLIENTS: GlobalInstructionClient[] = ['claude', 'codex']

/** The flags that are about binding a project, which `--global` does not do. */
const PROJECT_ONLY_FLAGS = [
  ['file', '--file'],
  ['db', '--db'],
  ['databaseUrl', '--database-url'],
  ['workspace', '--workspace'],
  ['board', '--board'],
  ['identifier', '--identifier'],
  ['agentUrl', '--agent-url'],
] as const satisfies readonly (readonly [keyof InitOptions, string])[]

/** What happened to one MCP registration. */
interface GlobalMcpOutcome {
  client: McpClient
  path: string
  /** `manual` when the person has to run `command` themselves. */
  state: 'written' | 'unchanged' | 'manual'
  command?: string
  reason?: string
}

interface GlobalInstructionOutcome {
  client: GlobalInstructionClient
  path: string
  state: 'written' | 'unchanged'
}

export async function initGlobal(options: InitOptions): Promise<void> {
  const format = readFormat(options)
  const given = PROJECT_ONLY_FLAGS.filter(([key]) => options[key] !== undefined).map(([, flag]) => flag)
  if (given.length > 0) {
    throw new CliError(1, `--global binds no board; ${given.join(', ')} ${given.length === 1 ? 'is' : 'are'} for a project. `
      + 'Run kanbo init in the project for that.')
  }

  const instructionClients = parseGlobalInstructions(options.instructions)
  const mcpClients = options.mcp ?? [...MCP_CLIENTS]

  const instructionChanges = instructionClients.map(client => ({
    client,
    change: planInstructionBlock(globalInstructionPath(client), GLOBAL_INSTRUCTION_BLOCK),
  }))
  const fileMcpChanges = mcpClients.filter(client => client !== 'claude').map(client => ({
    client,
    change: planGlobalMcpFile(client),
  }))
  const claudeNeeded = mcpClients.includes('claude') && readClaudeUserMcpCommand() === undefined

  const pending = [...instructionChanges, ...fileMcpChanges].filter(({ change }) => change.next !== null)
  let confirmed = true
  if (pending.length > 0 || claudeNeeded) {
    confirmed = await confirmPlan({
      preview: describePlan(pending.map(({ change }) => change), claudeNeeded),
      question: 'Make these changes?',
      yes: options.yes,
      machineOutput: Boolean(options.json || format),
      command: 'kanbo init --global',
    })
  }
  if (!confirmed) {
    throw new CliError(1, 'Nothing was changed.')
  }

  const instructions: GlobalInstructionOutcome[] = instructionChanges.map(({ client, change }) => ({
    client,
    ...applyFileChange(change),
  }))
  const mcp: GlobalMcpOutcome[] = mcpClients.map((client) => {
    if (client === 'claude') {
      return registerWithClaude(claudeNeeded)
    }
    const planned = fileMcpChanges.find(entry => entry.client === client)!
    return { client, ...applyFileChange(planned.change) }
  })

  printResult(describeResult(instructions, mcp), options)
}

/** The line `claude mcp add` gets for this person's own registration. */
function claudeUserAdd(): string[] {
  return claudeUserAddArgv(mcpLaunchSpec({ scope: 'user' }))
}

function planGlobalMcpFile(client: Exclude<McpClient, 'claude'>): FileChange {
  const path = globalMcpConfigPath(client)
  const launch = mcpLaunchSpec({ scope: 'user' })
  return client === 'codex' ? planCodexMcpServer(path, launch) : planJsonMcpServer(path, launch)
}

/** Claude Code's user-scope registration goes through its own command, never an edit of `~/.claude.json`. */
function registerWithClaude(needed: boolean): GlobalMcpOutcome {
  const path = globalMcpConfigPath('claude')
  if (!needed) {
    return { client: 'claude', path, state: 'unchanged' }
  }
  const outcome = runClaudeMcp(claudeUserAdd())
  return outcome.state === 'ran'
    ? { client: 'claude', path, state: 'written', command: outcome.command }
    : { client: 'claude', path, state: 'manual', command: outcome.command, reason: outcome.reason }
}

function describePlan(changes: FileChange[], claudeNeeded: boolean): string {
  const lines = ['kanbo init --global will:']
  for (const change of changes) {
    lines.push(`  write  ${change.path}`)
  }
  if (claudeNeeded) {
    lines.push(`  run    ${displayCommand(claudeUserAdd())}`)
  }
  lines.push('No board is created. Narrow this with --instructions and --mcp.')
  return lines.join('\n')
}

function describeResult(instructions: GlobalInstructionOutcome[], mcp: GlobalMcpOutcome[]): CliResult {
  const lines: string[] = []
  for (const outcome of instructions) {
    lines.push(`Instructions: ${outcome.path} (${outcome.state})`)
  }
  for (const outcome of mcp) {
    if (outcome.state === 'manual') {
      lines.push(`MCP: ${outcome.client} — run this yourself: ${outcome.command} (${outcome.reason})`)
    }
    else {
      lines.push(`MCP: ${outcome.path} (${outcome.state})`)
    }
  }
  lines.push('A project uses the board once it has run kanbo init. Check everything with kanbo doctor.')
  return {
    value: { scope: 'global', instructions, mcp },
    text: lines.join('\n'),
    fields: ['scope', 'instructions', 'mcp'],
  }
}

function parseGlobalInstructions(value: string | undefined): GlobalInstructionClient[] {
  if (value === undefined) {
    return DEFAULT_INSTRUCTION_CLIENTS
  }
  const names = value.split(',').map(name => name.trim()).filter(name => name.length > 0)
  if (names.length === 1 && names[0] === 'none') {
    return []
  }
  return names.map((name) => {
    const client = GLOBAL_INSTRUCTION_CLIENTS.find(candidate => candidate === name)
    if (!client) {
      throw new CliError(1, `Unknown instructions target "${name}" for --global. `
        + `Use one or more of ${GLOBAL_INSTRUCTION_CLIENTS.join(', ')}, or none.`)
    }
    return client
  })
}
