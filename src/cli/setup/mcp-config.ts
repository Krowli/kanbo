import { CliError } from '../output'
import type { FileChange } from './file-change'
import { findOnPath, globalMcpConfigPath } from './paths'
import { spawnCommandSync } from './process'
import { planTextFile, readTextFile } from './text-file'

/**
 * The board's MCP server entry, in the two formats the tools keep it in: the
 * `mcpServers` JSON map Claude Code (`.mcp.json`) and Cursor (`mcp.json`) read,
 * and the `[mcp_servers.<name>]` TOML table Codex reads (`config.toml`). Each
 * is planned before anything is written, found again by the doctor, and taken
 * out by `kanbo uninstall` without touching any other server.
 */

/** The name the board's MCP server is registered under, in every tool. */
export const MCP_SERVER_NAME = 'kanbo'

/** How every registration kanbo writes starts the server. */
export const MCP_COMMAND = 'kanbo'
export const MCP_ARGS = ['mcp'] as const

/** The line that registers the server with Claude Code for every project of this user. */
export const CLAUDE_USER_ADD = ['claude', 'mcp', 'add', '--scope', 'user', MCP_SERVER_NAME, '--', MCP_COMMAND, ...MCP_ARGS]
/** The line that takes that registration out again. */
export const CLAUDE_USER_REMOVE = ['claude', 'mcp', 'remove', MCP_SERVER_NAME, '--scope', 'user']

/**
 * A Codex table header naming this server or one of its subtables
 * (`[mcp_servers.kanbo.env]`), in every spelling TOML allows for the key: bare,
 * double-quoted and single-quoted all name the same server, and a check that
 * only knew the bare one would write a second table beside a registration the
 * person already has.
 */
const CODEX_HEADER_PATTERN = new RegExp(
  String.raw`^\s*\[\s*mcp_servers\s*\.\s*(?:${MCP_SERVER_NAME}|"${MCP_SERVER_NAME}"|'${MCP_SERVER_NAME}')\s*(\.[^\]]*)?\]`,
)

/** Any table header, which is where a table's keys end. */
const TOML_HEADER_PATTERN = /^\s*\[/

/** A `command = "..."` line, either string spelling. */
const TOML_COMMAND_PATTERN = /^\s*command\s*=\s*(?:"([^"]*)"|'([^']*)')/m

/**
 * The `mcpServers` map, merged rather than replaced: the file may already
 * describe servers that have nothing to do with this board. A `kanbo` entry
 * that is already there belongs to the person — it may point at a different
 * binary or carry arguments of its own — and is left as it is.
 */
export function planJsonMcpServer(path: string): FileChange {
  return planTextFile(path, (text) => {
    const existing = readJsonConfig(path, text)
    if (existing.mcpServers && MCP_SERVER_NAME in existing.mcpServers) {
      return null
    }
    const next = {
      ...existing,
      mcpServers: { ...existing.mcpServers, [MCP_SERVER_NAME]: { type: 'stdio', command: MCP_COMMAND, args: [...MCP_ARGS] } },
    }
    return `${JSON.stringify(next, null, 2)}\n`
  })
}

/**
 * The same file without the `kanbo` entry. Everything else stays, the
 * `mcpServers` object included when nothing else is left in it: kanbo does not
 * record which files it created, so it leaves the structure rather than guess.
 * A file it cannot read as a JSON object is not touched at all.
 */
export function planJsonMcpServerRemoval(path: string): FileChange {
  return planTextFile(path, (text) => {
    const existing = parseJsonObject(text)
    if (!existing || !isPlainObject(existing.mcpServers) || !(MCP_SERVER_NAME in existing.mcpServers)) {
      return null
    }
    const { [MCP_SERVER_NAME]: _removed, ...others } = existing.mcpServers
    return `${JSON.stringify({ ...existing, mcpServers: others }, null, 2)}\n`
  })
}

/**
 * The command a JSON registration starts the server with: `undefined` when the
 * file registers no `kanbo` server, `null` when it does but names no command
 * (a URL server, say).
 */
export function readJsonMcpCommand(path: string): string | null | undefined {
  const existing = parseJsonObject(readTextFile(path)?.text ?? null)
  const servers = existing?.mcpServers
  if (!isPlainObject(servers) || !isPlainObject(servers[MCP_SERVER_NAME])) {
    return undefined
  }
  const command = servers[MCP_SERVER_NAME].command
  return typeof command === 'string' && command.trim() ? command.trim() : null
}

/** Codex keeps its servers in TOML tables, so the table is appended rather than merged. */
export function planCodexMcpServer(path: string): FileChange {
  return planTextFile(path, (text) => {
    const existing = text ?? ''
    if (findCodexSections(existing).length > 0) {
      return null
    }
    const table = `[mcp_servers.${MCP_SERVER_NAME}]\ncommand = "${MCP_COMMAND}"\nargs = ${JSON.stringify(MCP_ARGS)}\n`
    return existing.trim() ? `${existing.replace(/\s*$/, '')}\n\n${table}` : table
  })
}

/**
 * The same file without the `kanbo` table and its subtables. A table runs from
 * its header to the next header, so every other table — and every line before
 * the first — is kept byte for byte.
 */
export function planCodexMcpServerRemoval(path: string): FileChange {
  return planTextFile(path, (existing) => {
    const sections = existing === null ? [] : findCodexSections(existing)
    if (existing === null || sections.length === 0) {
      return null
    }
    const lines = existing.split('\n')
    const removed = new Set(sections.flatMap(({ start, end }) => range(start, end)))
    const kept = lines.filter((_, index) => !removed.has(index))
    const next = kept.join('\n').replace(/^\n+/, '')
    return next.trim() ? `${next.replace(/\s*$/, '')}\n` : ''
  })
}

/** The command the Codex table starts the server with, with the same `undefined`/`null` meaning as the JSON one. */
export function readCodexMcpCommand(path: string): string | null | undefined {
  const text = readTextFile(path)?.text
  if (text === undefined) {
    return undefined
  }
  const main = findCodexSections(text).find(section => section.main)
  if (!main) {
    return undefined
  }
  const body = text.split('\n').slice(main.start, main.end).join('\n')
  const match = TOML_COMMAND_PATTERN.exec(body)
  return match ? (match[1] ?? match[2] ?? null) : null
}

/** Is the server registered with Claude Code for every project of this user (`~/.claude.json`, read only)? */
export function readClaudeUserMcpCommand(): string | null | undefined {
  return readJsonMcpCommand(globalMcpConfigPath('claude'))
}

/** What happened to a registration that goes through the `claude` command. */
export interface ClaudeCliOutcome {
  /** `ran` when `claude` did it, `manual` when the person has to run the line themselves. */
  state: 'ran' | 'manual'
  command: string
  /** Why it is the person's to run, when it is. */
  reason?: string
}

/**
 * Run `claude mcp …` when Claude Code is here to run it, and hand the line to
 * the person when it is not — or when it failed, with the first line it said.
 * `~/.claude.json` is Claude Code's own state file and is never edited by hand.
 */
export function runClaudeMcp(argv: readonly string[]): ClaudeCliOutcome {
  const command = argv.join(' ')
  const executable = findOnPath(argv[0]!)
  if (!executable) {
    return { state: 'manual', command, reason: `${argv[0]} is not on PATH` }
  }
  const result = spawnCommandSync(executable, argv.slice(1), { timeout: 60_000 })
  if (result.status === 0) {
    return { state: 'ran', command }
  }
  const said = `${result.stderr ?? ''}${result.stdout ?? ''}`.trim().split('\n')[0]
  return {
    state: 'manual',
    command,
    reason: result.error ? result.error.message : `${argv[0]} exited ${result.status ?? 'on a signal'}${said ? `: ${said}` : ''}`,
  }
}

/** The line ranges (`end` exclusive) of the `kanbo` table and its subtables. */
function findCodexSections(text: string): { start: number, end: number, main: boolean }[] {
  const lines = text.split('\n')
  const sections: { start: number, end: number, main: boolean }[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const match = CODEX_HEADER_PATTERN.exec(lines[index]!)
    if (!match) {
      continue
    }
    let end = index + 1
    while (end < lines.length && !TOML_HEADER_PATTERN.test(lines[end]!)) {
      end += 1
    }
    sections.push({ start: index, end, main: match[1] === undefined })
    index = end - 1
  }
  return sections
}

function range(start: number, end: number): number[] {
  return Array.from({ length: end - start }, (_, offset) => start + offset)
}

/**
 * The tool's configuration file (its text, byte order mark already gone) as
 * an object to merge into — or a refusal.
 *
 * A file that is valid JSON but not an object (a list, a string, `null`) is
 * something this command has no idea how to merge into, and spreading it would
 * quietly throw the person's file away. The file is left exactly as it is and
 * they are told which one to look at.
 */
function readJsonConfig(path: string, text: string | null): { mcpServers?: Record<string, unknown> } {
  if (text === null) {
    return {}
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  }
  catch {
    throw new CliError(1, `${path} is not valid JSON. Fix or remove it, then run kanbo init again.`)
  }
  if (!isPlainObject(parsed)) {
    throw new CliError(1, `${path} does not hold a JSON object. Fix or remove it, then run kanbo init again.`)
  }
  if (parsed.mcpServers !== undefined && !isPlainObject(parsed.mcpServers)) {
    throw new CliError(1, `${path} has an "mcpServers" that is not an object. Fix it, then run kanbo init again.`)
  }
  return parsed as { mcpServers?: Record<string, unknown> }
}

/** The file's text as a JSON object, or `null` when it is missing or anything else — for reading and removal, which never refuse. */
function parseJsonObject(text: string | null): Record<string, unknown> | null {
  if (text === null) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(text)
    return isPlainObject(parsed) ? parsed : null
  }
  catch {
    return null
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
