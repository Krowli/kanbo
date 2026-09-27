import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

import type { Command } from 'commander'

import { BINDING_FILE_PATH } from '../binding'
import { findKanboProject } from '../doctor'
import { CliError } from '../output'
import { confirmPlan } from '../setup/confirm'
import { AGENT_IDS, AGENTS, instructionPaths } from '../setup/agents'
import type { FileChange } from '../setup/file-change'
import { applyFileChange } from '../setup/file-change'
import { removeWithRetry } from '../setup/fs-retry'
import { confirmOwnEntryRemoval, isKanboEntry, readMcpEntry } from '../setup/connect-plan'
import { planInstructionBlockRemovalAsking } from '../setup/instructions'
import {
  CLAUDE_USER_REMOVE,
  planCodexMcpServerRemoval,
  planJsonMcpServerRemoval,
  readJsonMcpEntry,
  runClaudeMcp,
} from '../setup/mcp-config'
import type { McpScope } from '../setup/mcp-launch'
import { globalMcpConfigPath } from '../setup/paths'
import { canPrompt } from '../ui/environment'
import { CancelledError, getUi } from '../ui/ui'

/**
 * `kanbo uninstall` — take out what `kanbo init` wrote, and nothing else.
 *
 * The marked instruction block and the `kanbo` MCP entries go; the person's
 * own writing around the block and every other MCP server stay, and so does
 * every file, emptied or not — kanbo does not record which files it created,
 * so it does not delete any. Claude Code's user-scope registration goes out
 * the way it went in, through `claude mcp remove`.
 *
 * Boards are never touched unless `--purge` is given: then the project's
 * binding goes, and its board file only after a confirmation that names it —
 * `--yes` does not answer that one, and a shell nobody can ask keeps the file.
 */
interface UninstallOptions {
  project?: boolean
  global?: boolean
  purge?: boolean
  yes?: boolean
  json?: boolean
}

/** One thing the command did, or left for the person. */
interface UninstallAction {
  path: string
  /** `edited`: kanbo's part taken out. `deleted`: the file removed. `ran`/`manual`: a `claude` command. `kept`: left on purpose. */
  action: 'edited' | 'deleted' | 'ran' | 'manual' | 'kept'
  note?: string
}

/** A planned edit, with what it takes out. */
interface PlannedEdit {
  change: FileChange
  what: string
}

export function registerUninstallCommand(program: Command): void {
  program
    .command('uninstall')
    .description('remove what kanbo init wrote: instruction blocks and kanbo MCP entries; boards stay unless --purge')
    .option('--project', 'only this project\'s files')
    .option('--global', 'only your own user-level files')
    .option('--purge', 'also remove this project\'s .kanbo/binding.json, and its board file after a confirmation naming it')
    .option('--yes', 'do it without asking (never deletes a board file)')
    .option('--json', 'print what was done as JSON')
    .action(async (options: UninstallOptions) => {
      await uninstall(options)
    })
}

async function uninstall(options: UninstallOptions): Promise<void> {
  const both = !options.project && !options.global
  const withProject = both || Boolean(options.project)
  const withGlobal = both || Boolean(options.global)
  if (options.purge && !withProject) {
    throw new CliError(1, '--purge removes a project\'s binding and board; run it without --global, in the project.')
  }

  const projectRoot = withProject ? (findKanboProject(process.cwd())?.root ?? process.cwd()) : null
  const notes: string[] = []
  const edits = [
    ...(projectRoot ? await planEdits('project', projectRoot, options, notes) : []),
    ...(withGlobal ? await planEdits('user', process.cwd(), options, notes) : []),
  ].filter(edit => edit.change.next !== null)
  const claudeEntry = withGlobal ? readJsonMcpEntry(globalMcpConfigPath('claude')) : undefined
  const claudeUser = claudeEntry !== undefined && (isKanboEntry(claudeEntry, 'user')
    || await confirmOwnEntryRemoval(AGENTS.claude.label, globalMcpConfigPath('claude'), options, { notes }))
  const bindingPath = projectRoot && options.purge ? join(projectRoot, BINDING_FILE_PATH) : null
  const purgeBinding = bindingPath !== null && existsSync(bindingPath)
  const boardFile = projectRoot && options.purge ? findOwnBoardFile(projectRoot) : null

  const actions: UninstallAction[] = []
  if (edits.length > 0 || claudeUser || purgeBinding || boardFile) {
    const confirmed = await confirmPlan({
      preview: describePlan(edits, claudeUser, purgeBinding ? bindingPath : null, boardFile, notes),
      question: 'Remove these?',
      yes: options.yes,
      machineOutput: Boolean(options.json),
      command: 'kanbo uninstall',
    })
    if (!confirmed) {
      throw new CliError(1, 'Nothing was changed.')
    }

    for (const edit of edits) {
      applyFileChange(edit.change)
      actions.push({ path: edit.change.path, action: 'edited', note: edit.what })
    }
    if (claudeUser) {
      const outcome = runClaudeMcp(CLAUDE_USER_REMOVE)
      actions.push({ path: globalMcpConfigPath('claude'), action: outcome.state, note: outcome.state === 'ran' ? outcome.command : `run this yourself: ${outcome.command} (${outcome.reason})` })
    }
    if (purgeBinding) {
      removeWithRetry(bindingPath)
      actions.push({ path: bindingPath, action: 'deleted', note: 'project binding' })
    }
    if (boardFile) {
      actions.push(await purgeBoardFile(boardFile))
    }
  }

  printActions(actions, notes, options)
}

/**
 * Every file of every agent in the registry (`setup/agents.ts`) that kanbo may
 * have written in this scope: each instruction file once, and each MCP file.
 * Claude Code's `~/.claude.json` is its own state file: `claude mcp remove`
 * edits it, not this. A block or an entry that is not in the shape kanbo
 * writes is asked about first (`--yes` answers it); a file whose markers do
 * not pair up is left alone, and the person is told in `notes`.
 */
async function planEdits(scope: McpScope, root: string, options: UninstallOptions, notes: string[]): Promise<PlannedEdit[]> {
  const edits: PlannedEdit[] = []
  for (const { path } of instructionPaths(scope, root)) {
    const asked = await planInstructionBlockRemovalAsking(path, { yes: options.yes })
    if (asked.note) {
      notes.push(asked.note)
    }
    edits.push({ change: asked.change, what: 'kanbo instruction block' })
  }
  for (const agent of AGENT_IDS) {
    const target = AGENTS[agent].mcpTarget(scope, root)
    if (target.format === 'claude-cli') {
      continue
    }
    const entry = readMcpEntry(target)
    if (entry === undefined || (!isKanboEntry(entry, scope) && !await confirmOwnEntryRemoval(AGENTS[agent].label, target.path, options, { notes }))) {
      continue
    }
    const change = target.format === 'toml' ? planCodexMcpServerRemoval(target.path) : planJsonMcpServerRemoval(target.path)
    edits.push({ change, what: 'kanbo MCP server' })
  }
  return edits
}

/**
 * The board file `kanbo init --file` made for this project — the only board
 * `--purge` may offer to delete. A host app's database or an external board is
 * not kanbo's to delete, and a binding that names none offers nothing.
 */
function findOwnBoardFile(root: string): string | null {
  const binding = findKanboProject(root)?.binding
  if (!binding?.dbPath) {
    return null
  }
  const path = resolve(root, binding.dbPath)
  return existsSync(path) ? path : null
}

/** Delete the board file only on a yes to a question that names it; `--yes` is not that answer. */
async function purgeBoardFile(path: string): Promise<UninstallAction> {
  if (!canPrompt()) {
    return { path, action: 'kept', note: 'board file: deleting it needs a confirmation in a terminal; delete it yourself if you mean to' }
  }
  // Everything else is done by now; Ctrl-C here is one more way of saying keep it.
  const answer = await getUi().confirm({
    message: `Delete the board file ${path} and every card in it? This cannot be undone.`,
    initialValue: false,
  }).catch((error: unknown) => {
    if (error instanceof CancelledError) {
      return false
    }
    throw error
  })
  if (!answer) {
    return { path, action: 'kept', note: 'board file' }
  }
  for (const file of [path, `${path}-wal`, `${path}-shm`]) {
    removeWithRetry(file, { force: true })
  }
  return { path, action: 'deleted', note: 'board file' }
}

function describePlan(edits: PlannedEdit[], claudeUser: boolean, bindingPath: string | null, boardFile: string | null, notes: string[]): string {
  const lines = ['kanbo uninstall will:']
  for (const edit of edits) {
    lines.push(`  edit    ${edit.change.path}  (remove the ${edit.what})`)
  }
  if (claudeUser) {
    lines.push(`  run     ${CLAUDE_USER_REMOVE.join(' ')}`)
  }
  if (bindingPath) {
    lines.push(`  delete  ${bindingPath}`)
  }
  if (boardFile) {
    lines.push(`  ask     whether to delete the board file ${boardFile} (only in a terminal; --yes does not answer this)`)
  }
  for (const note of notes) {
    lines.push(`Note: ${note}`)
  }
  lines.push('Files stay even when nothing is left in them. Boards stay unless you confirm deleting one.')
  return lines.join('\n')
}

function printActions(actions: UninstallAction[], notes: string[], options: UninstallOptions): void {
  if (options.json) {
    console.log(JSON.stringify({ actions, notes }, null, 2))
    return
  }
  if (actions.length === 0) {
    console.log('Nothing to remove: no kanbo block or MCP entry in the files kanbo writes.')
  }
  for (const action of actions) {
    console.log(`${action.action.padEnd(8)} ${action.path}${action.note ? `  (${action.note})` : ''}`)
  }
  for (const note of notes) {
    console.log(`Note: ${note}`)
  }
}
