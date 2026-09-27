import type { CliResult } from '../output'
import { CliError, printResult, readFormat } from '../output'
import { confirmPlan } from '../setup/confirm'
import { applyConnectPlan, describeConnectPlan, describeManualOutcome, pendingItems, planConnect } from '../setup/connect-plan'
import type { GlobalInstructionClient, McpClient } from '../setup/paths'
import { GLOBAL_INSTRUCTION_CLIENTS, MCP_CLIENTS } from '../setup/paths'
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
 * It plans what `kanbo connect <agents> --global` plans (`setup/connect-plan.ts`),
 * for the agents its flags name. Every change is worked out first and shown; nothing is written until the
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
  /** `claude mcp remove` ran, and the `add` after it did not. */
  removed?: boolean
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

  // What `kanbo connect <agents> --global` plans, with this command's own choice of agents.
  const plan = await planConnect([
    ...instructionClients.map(agent => ({ agent, instructions: 'user' as const, mcp: null })),
    ...mcpClients.map(agent => ({ agent, instructions: null, mcp: 'user' as const })),
  ], { projectDir: process.cwd(), yes: options.yes })
  for (const note of plan.notes) {
    console.error(note)
  }

  if (pendingItems(plan).length > 0) {
    const confirmed = await confirmPlan({
      preview: describeConnectPlan(plan, 'kanbo init --global will:').replace(
        'Nothing else is changed.',
        'No board is created. Narrow this with --instructions and --mcp, or use kanbo connect <agents> --global.',
      ),
      question: 'Make these changes?',
      yes: options.yes,
      machineOutput: Boolean(options.json || format),
      command: 'kanbo init --global',
    })
    if (!confirmed) {
      throw new CliError(1, 'Nothing was changed.')
    }
  }

  const outcomes = applyConnectPlan(plan)
  const instructions: GlobalInstructionOutcome[] = outcomes
    .filter(outcome => outcome.kind === 'instructions')
    .map(({ agents, path, state }) => ({ client: agents[0] as GlobalInstructionClient, path, state: state as GlobalInstructionOutcome['state'] }))
  const mcp: GlobalMcpOutcome[] = outcomes
    .filter(outcome => outcome.kind !== 'instructions')
    .map(({ agents, path, state, command, reason, removed }) => ({
      client: agents[0] as McpClient,
      path,
      // `claude mcp add` having run is the registration written.
      state: state === 'ran' ? 'written' : state,
      ...(command ? { command } : {}),
      ...(reason ? { reason } : {}),
      ...(removed ? { removed } : {}),
    }))

  printResult(describeResult(instructions, mcp), options)
}

function describeResult(instructions: GlobalInstructionOutcome[], mcp: GlobalMcpOutcome[]): CliResult {
  const lines: string[] = []
  for (const outcome of instructions) {
    lines.push(`Instructions: ${outcome.path} (${outcome.state})`)
  }
  for (const outcome of mcp) {
    if (outcome.state === 'manual') {
      lines.push(`MCP: ${describeManualOutcome(outcome.client, outcome)}`)
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
