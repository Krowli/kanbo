import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'

import { CliError } from '../output'
import type { FileChange } from './file-change'
import type { McpLaunch } from './mcp-launch'
import { PORTABLE_MCP_LAUNCH } from './mcp-launch'
import { findOnPath } from './paths'
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

/** The portable way a registration starts the server; see `mcp-launch.ts` for the one Windows needs. */
export const MCP_COMMAND = PORTABLE_MCP_LAUNCH.command
export const MCP_ARGS = PORTABLE_MCP_LAUNCH.args

/** The line that registers the server with Claude Code for every project of this user. */
export function claudeUserAddArgv(launch: McpLaunch): string[] {
  return ['claude', 'mcp', 'add', '--scope', 'user', MCP_SERVER_NAME, '--', launch.command, ...launch.args]
}
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
const TOML_COMMAND_PATTERN = /^\s*command\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')/m

/** A one-line `args = [...]` array. */
const TOML_ARGS_PATTERN = /^\s*args\s*=\s*\[(.*)\]\s*$/m

/** The first key on a `key = …` or `key.sub = …` line; a line that goes on an array (`"mcp",`) has none. */
const TOML_KEY_PATTERN = /^\s*("[^"]*"|'[^']*'|[\w-]+)\s*[.=]/

/**
 * The line that lets Codex call the board's tools without asking. `codex exec`
 * never asks, so without it every `kanbo_*` call is refused ("approval policy
 * is never"); the key and value are Codex's own (`default_tools_approval_mode`
 * on an MCP server table, codex-rs/config mcp_types). Part of kanbo's own entry.
 */
const CODEX_APPROVAL_LINE = 'default_tools_approval_mode = "approve"'
const TOML_APPROVAL_PATTERN = /^\s*default_tools_approval_mode\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')/m
const TOML_APPROVAL_LINE = /^\s*default_tools_approval_mode\s*=/

/** A line that sets `command` or `args` — the two lines a rewrite replaces. */
const TOML_COMMAND_LINE = /^\s*command\s*=/
const TOML_ARGS_LINE = /^\s*args\s*=/

/** The script kanbo registers itself by: the package's `dist/cli.cjs`, or the `cli-main.cjs` it loads. */
const KANBO_SCRIPT_PATTERN = /[\\/]kanbo-cli[\\/]dist[\\/](?:cli|cli-main)\.cjs$/i

/** One string in a TOML array, either spelling. */
const TOML_STRING_PATTERN = /"(?:[^"\\]|\\.)*"|'[^']*'/g

/** How a registration is written. */
export interface McpWriteOptions {
  /**
   * Replace a `kanbo` entry that is already there. Only for one of kanbo's own
   * that no longer starts (`isStaleMcpEntry`): any other belongs to the person.
   */
  replace?: boolean
  /** Write `"type": "stdio"` (Claude Code, Cursor); Gemini CLI's entries have no `type`. Defaults to true. */
  withType?: boolean
}

/**
 * The `mcpServers` map, merged rather than replaced: the file may already
 * describe servers that have nothing to do with this board. A `kanbo` entry
 * that is already there belongs to the person — it may point at a different
 * binary or carry arguments of its own — and is left as it is, unless it is
 * kanbo's own gone stale and the caller says `replace`.
 */
export function planJsonMcpServer(path: string, launch: McpLaunch = PORTABLE_MCP_LAUNCH, options: McpWriteOptions = {}): FileChange {
  return planTextFile(path, (text) => {
    const existing = readJsonConfig(path, text)
    const present = existing.mcpServers?.[MCP_SERVER_NAME]
    if (present !== undefined && !options.replace) {
      return null
    }
    // A rewrite changes the command and its arguments and keeps whatever else the entry says.
    const entry = isPlainObject(present)
      ? { ...(options.withType === false ? {} : { type: 'stdio' }), ...present, command: launch.command, args: [...launch.args] }
      : options.withType === false
        ? { command: launch.command, args: [...launch.args] }
        : { type: 'stdio', command: launch.command, args: [...launch.args] }
    const next = {
      ...existing,
      mcpServers: { ...existing.mcpServers, [MCP_SERVER_NAME]: entry },
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
  const entry = readJsonMcpEntry(path)
  return entry === undefined ? undefined : entry.command
}

/** What a registration starts: its command (`null` when it names none) and its arguments. */
export interface McpEntry {
  command: string | null
  args: string[]
  /**
   * Everything else the entry says: its other JSON keys (a `type` other than
   * `stdio` among them), or its other TOML keys and subtables (`env`). kanbo
   * writes none but Codex's `default_tools_approval_mode = "approve"`, so an entry with any other is the person's.
   */
  otherFields: string[]
}

/** The JSON registration's command and arguments, `undefined` when the file registers no `kanbo` server. */
export function readJsonMcpEntry(path: string): McpEntry | undefined {
  const existing = parseJsonObject(readTextFile(path)?.text ?? null)
  const servers = existing?.mcpServers
  if (!isPlainObject(servers) || !isPlainObject(servers[MCP_SERVER_NAME])) {
    return undefined
  }
  const entry = servers[MCP_SERVER_NAME]
  const { command, args } = entry
  return {
    command: typeof command === 'string' && command.trim() ? command.trim() : null,
    args: Array.isArray(args) ? args.filter((arg): arg is string => typeof arg === 'string') : [],
    otherFields: Object.keys(entry).filter(key => key !== 'command' && key !== 'args' && !(key === 'type' && entry.type === 'stdio')),
  }
}

/**
 * Codex keeps its servers in TOML tables, so the table is appended rather than
 * merged. A Windows path is written as a TOML literal string (`'…'`), which
 * takes its backslashes as they are. With `replace`, the `command` and `args`
 * lines of the `kanbo` table are rewritten where they stand, and every other
 * line of it — and every subtable — is kept.
 */
export function planCodexMcpServer(path: string, launch: McpLaunch = PORTABLE_MCP_LAUNCH, options: Pick<McpWriteOptions, 'replace'> = {}): FileChange {
  return planTextFile(path, (text) => {
    const existing = text ?? ''
    const sections = findCodexSections(existing)
    const command = `command = ${tomlString(launch.command)}`
    const args = `args = [${launch.args.map(tomlString).join(', ')}]`
    const table = `[mcp_servers.${MCP_SERVER_NAME}]\n${command}\n${args}\n${CODEX_APPROVAL_LINE}\n`
    if (sections.length > 0) {
      const main = sections.find(section => section.main)
      if (!options.replace || !main) {
        return null
      }
      const lines = existing.split('\n')
      const body = lines.slice(main.start + 1, main.end)
        .filter(line => !TOML_COMMAND_LINE.test(line) && !TOML_ARGS_LINE.test(line))
      const approval = body.some(line => TOML_APPROVAL_LINE.test(line)) ? [] : [CODEX_APPROVAL_LINE]
      lines.splice(main.start + 1, main.end - main.start - 1, command, args, ...approval, ...body)
      return lines.join('\n')
    }
    return existing.trim() ? `${existing.replace(/\s*$/, '')}\n\n${table}` : table
  })
}

/**
 * Is this entry one kanbo wrote, in exactly the shape it writes it? `kanbo mcp`
 * (with `"type": "stdio"` or without), or a Node given by full path running
 * kanbo's own script (`…/kanbo-cli/dist/cli.cjs mcp`) — and nothing else: an
 * entry with an `env`, a `cwd` or any other field, or one that starts kanbo
 * some other way (`cmd /c kanbo mcp`, `npx -y kanbo-cli mcp`), is the
 * person's, and kanbo never rewrites or removes it without asking.
 */
export function isOwnMcpEntry(entry: McpEntry): boolean {
  const { command, args, otherFields } = entry
  if (command === null || otherFields.length > 0) {
    return false
  }
  if (command === MCP_COMMAND) {
    return args.length === MCP_ARGS.length && args.every((arg, index) => arg === MCP_ARGS[index])
  }
  return isAbsolutePath(command)
    && /^node(?:\.exe)?$/i.test(command.split(/[\\/]/).pop() ?? '')
    && args.length === 2
    && args[1] === 'mcp'
    && isAbsolutePath(args[0]!)
    && KANBO_SCRIPT_PATTERN.test(args[0]!)
}

/**
 * A `kanbo` registration of kanbo's own (`isOwnMcpEntry`) that no longer
 * starts, and that `kanbo connect` may therefore rewrite: one that names its
 * Node and script by full path when either is gone (a Node upgrade, a
 * reinstall elsewhere), or, on Windows, the bare `kanbo mcp` in the person's
 * own settings, which there is npm's `kanbo.cmd` shim.
 */
export function isStaleMcpEntry(entry: McpEntry, scope: 'project' | 'user', platform: NodeJS.Platform = process.platform): boolean {
  if (!isOwnMcpEntry(entry)) {
    return false
  }
  const { command, args } = entry
  if (isAbsolutePath(command!)) {
    return [command!, ...args.filter(isAbsolutePath)].some(file => !existsSync(file))
  }
  return platform === 'win32' && scope === 'user'
}

/**
 * Can this entry — one of the person's own, say — start at all here? Its
 * program by full path has to exist, or its bare name be on `PATH`.
 */
export function canStartMcpEntry(entry: McpEntry, platform: NodeJS.Platform = process.platform): boolean {
  if (entry.command === null) {
    return false
  }
  return isAbsolutePath(entry.command) ? existsSync(entry.command) : findOnPath(entry.command, { platform }) !== null
}

/** A full path on either system: `/…`, `C:\\…` or `\\\\server\\…`. */
function isAbsolutePath(value: string): boolean {
  return isAbsolute(value) || /^(?:[a-z]:[\\/]|\\\\)/i.test(value)
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
  const entry = readCodexMcpEntry(path)
  return entry === undefined ? undefined : entry.command
}

/** The Codex table's command and arguments, `undefined` when there is no `kanbo` table. */
export function readCodexMcpEntry(path: string): McpEntry | undefined {
  const text = readTextFile(path)?.text
  if (text === undefined) {
    return undefined
  }
  const sections = findCodexSections(text)
  const main = sections.find(section => section.main)
  if (!main) {
    return undefined
  }
  const lines = text.split('\n').slice(main.start + 1, main.end)
  const body = lines.join('\n')
  const command = TOML_COMMAND_PATTERN.exec(body)?.[1]
  const args = TOML_ARGS_PATTERN.exec(body)?.[1]
  const approval = TOML_APPROVAL_PATTERN.exec(body)?.[1]
  // kanbo writes the approval line itself; only its own value keeps the entry kanbo's.
  const ownApproval = approval !== undefined && readTomlString(approval) === 'approve'
  const keys = lines.flatMap((line) => {
    const key = TOML_KEY_PATTERN.exec(line)?.[1]
    return key === undefined ? [] : [readTomlKey(key)]
  })
  return {
    command: command === undefined ? null : readTomlString(command),
    args: args === undefined ? [] : (args.match(TOML_STRING_PATTERN) ?? []).map(readTomlString),
    otherFields: [
      ...keys.filter(key => key !== 'command' && key !== 'args' && !(key === 'default_tools_approval_mode' && ownApproval)),
      ...sections.filter(section => !section.main).map(section => section.subtable),
    ],
  }
}

/** A key's name, quotes taken off. */
function readTomlKey(key: string): string {
  return /^["']/.test(key) ? key.slice(1, -1) : key
}

/**
 * A basic string (`"…"`, JSON's escapes are TOML's), except for a value with a
 * backslash in it — a Windows path — which is written as a literal string so
 * it reads as it is, when it can be one.
 */
function tomlString(value: string): string {
  return value.includes('\\') && !/['\n\r]/.test(value) ? `'${value}'` : JSON.stringify(value)
}

function readTomlString(quoted: string): string {
  if (quoted.startsWith('\'')) {
    return quoted.slice(1, -1)
  }
  try {
    return JSON.parse(quoted) as string
  }
  catch {
    return quoted.slice(1, -1)
  }
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
  const command = displayCommand(argv)
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

/**
 * The line as a person would type it: a path with a space in it
 * (`C:\\Program Files\\…`) in double quotes. An argument that has quotes of
 * its own is shown as it is, since shells disagree on how to escape them.
 */
export function displayCommand(argv: readonly string[]): string {
  return argv.map(arg => (/\s/.test(arg) && !arg.includes('"') ? `"${arg}"` : arg)).join(' ')
}

/** The line ranges (`end` exclusive) of the `kanbo` table and its subtables. */
function findCodexSections(text: string): { start: number, end: number, main: boolean, subtable: string }[] {
  const lines = text.split('\n')
  const sections: { start: number, end: number, main: boolean, subtable: string }[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const match = CODEX_HEADER_PATTERN.exec(lines[index]!)
    if (!match) {
      continue
    }
    let end = index + 1
    while (end < lines.length && !TOML_HEADER_PATTERN.test(lines[end]!)) {
      end += 1
    }
    sections.push({ start: index, end, main: match[1] === undefined, subtable: match[1]?.replace(/^\s*\.\s*/, '').trim() ?? '' })
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
