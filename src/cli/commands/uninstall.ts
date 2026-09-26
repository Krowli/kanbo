import { existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

import type { Command } from 'commander'

import { BINDING_FILE_PATH } from '../binding'
import { findKanboProject } from '../doctor'
import { CliError } from '../output'
import { confirmPlan, isInteractive } from '../setup/confirm'
import type { FileChange } from '../setup/file-change'
import { applyFileChange } from '../setup/file-change'
import { planInstructionBlockRemoval } from '../setup/instructions'
import {
  CLAUDE_USER_REMOVE,
  planCodexMcpServerRemoval,
  planJsonMcpServerRemoval,
  readClaudeUserMcpCommand,
  runClaudeMcp,
} from '../setup/mcp-config'
import type { McpClient } from '../setup/paths'
import {
  GLOBAL_INSTRUCTION_CLIENTS,
  globalInstructionPath,
  globalMcpConfigPath,
  PROJECT_INSTRUCTION_FILES,
  projectMcpConfigPath,
} from '../setup/paths'

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
  const edits = [
    ...(projectRoot ? planProjectEdits(projectRoot) : []),
    ...(withGlobal ? planGlobalEdits() : []),
  ].filter(edit => edit.change.next !== null)
  const claudeUser = withGlobal && readClaudeUserMcpCommand() !== undefined
  const bindingPath = projectRoot && options.purge ? join(projectRoot, BINDING_FILE_PATH) : null
  const purgeBinding = bindingPath !== null && existsSync(bindingPath)
  const boardFile = projectRoot && options.purge ? findOwnBoardFile(projectRoot) : null

  const actions: UninstallAction[] = []
  if (edits.length > 0 || claudeUser || purgeBinding || boardFile) {
    const confirmed = await confirmPlan({
      preview: describePlan(edits, claudeUser, purgeBinding ? bindingPath : null, boardFile),
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
      rmSync(bindingPath)
      actions.push({ path: bindingPath, action: 'deleted', note: 'project binding' })
    }
    if (boardFile) {
      actions.push(await purgeBoardFile(boardFile))
    }
  }

  printActions(actions, options)
}

function planProjectEdits(root: string): PlannedEdit[] {
  return [
    ...Object.values(PROJECT_INSTRUCTION_FILES).map(name => ({
      change: planInstructionBlockRemoval(join(root, name)),
      what: 'kanbo instruction block',
    })),
    ...(['claude', 'codex', 'cursor'] as const).map(client => ({
      change: planMcpRemoval(projectMcpConfigPath(root, client), client),
      what: 'kanbo MCP server',
    })),
  ]
}

function planGlobalEdits(): PlannedEdit[] {
  return [
    ...GLOBAL_INSTRUCTION_CLIENTS.map(client => ({
      change: planInstructionBlockRemoval(globalInstructionPath(client)),
      what: 'kanbo instruction block',
    })),
    // Claude Code's `~/.claude.json` is its own state file: `claude mcp remove` edits it, not this.
    ...(['codex', 'cursor'] as const).map(client => ({
      change: planMcpRemoval(globalMcpConfigPath(client), client),
      what: 'kanbo MCP server',
    })),
  ]
}

function planMcpRemoval(path: string, client: McpClient): FileChange {
  return client === 'codex' ? planCodexMcpServerRemoval(path) : planJsonMcpServerRemoval(path)
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
  if (!isInteractive()) {
    return { path, action: 'kept', note: 'board file: deleting it needs a confirmation in a terminal; delete it yourself if you mean to' }
  }
  const prompts = await import('@clack/prompts')
  const answer = await prompts.confirm({
    message: `Delete the board file ${path} and every card in it? This cannot be undone.`,
    initialValue: false,
  })
  if (answer !== true) {
    return { path, action: 'kept', note: 'board file' }
  }
  for (const file of [path, `${path}-wal`, `${path}-shm`]) {
    rmSync(file, { force: true })
  }
  return { path, action: 'deleted', note: 'board file' }
}

function describePlan(edits: PlannedEdit[], claudeUser: boolean, bindingPath: string | null, boardFile: string | null): string {
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
  lines.push('Files stay even when nothing is left in them. Boards stay unless you confirm deleting one.')
  return lines.join('\n')
}

function printActions(actions: UninstallAction[], options: UninstallOptions): void {
  if (options.json) {
    console.log(JSON.stringify({ actions }, null, 2))
    return
  }
  if (actions.length === 0) {
    console.log('Nothing to remove: no kanbo block or MCP entry in the files kanbo writes.')
    return
  }
  for (const action of actions) {
    console.log(`${action.action.padEnd(8)} ${action.path}${action.note ? `  (${action.note})` : ''}`)
  }
}
