import type { KanboCapabilities, KanboCapabilityCommand, KanboCapabilityTool } from './manifest'

/**
 * The same manifest `buildCapabilitiesManifest` returns, as Markdown a person
 * can read and an agent can paste into its own `CLAUDE.md` or `AGENTS.md`.
 *
 * Nothing here decides what the board can do — it only lays the manifest's own
 * fields out under headings. `kanbo capabilities` prints this by default, and
 * `kanbo mcp` serves it as `kanbo://capabilities.md` beside the JSON.
 */

/**
 * A table cell, safe from a pipe inside the text breaking the row it sits in —
 * the same escape the package README's own tables use for a command that
 * spells `\|` between two states.
 */
function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ').trim()
}

function renderStorages(manifest: KanboCapabilities): string[] {
  const rows = manifest.storages.map(storage =>
    `| \`${storage.kind}\` | ${cell(storage.label)} | ${cell(storage.description)} | ${storage.schemaEpoch} |`)
  return [
    '## Storages',
    '',
    '| Kind | Label | Description | Schema epoch |',
    '| --- | --- | --- | --- |',
    ...rows,
  ]
}

function renderTool(tool: KanboCapabilityTool): string {
  return `| \`${tool.name}\` | \`${cell(tool.cli.kanbo)}\` | ${cell(tool.description)} |`
}

function renderTools(manifest: KanboCapabilities): string[] {
  return [
    '## Tools',
    '',
    'Full JSON Schema for each tool\'s input is in the JSON manifest (`kanbo capabilities --json` or '
    + '`kanbo://capabilities`) — this table is the tools themselves and what to type instead of calling one.',
    '',
    '| Tool | `kanbo` | Does |',
    '| --- | --- | --- |',
    ...manifest.tools.map(renderTool),
  ]
}

function renderCommand(command: KanboCapabilityCommand): string {
  const options = command.options.map(option => `\`${option.flags}\`${option.mandatory ? ' (required)' : ''}`).join(', ')
  const humanOnly = command.humanOnly ? ' **Person only.**' : ''
  return `| \`kanbo ${command.path}\` | ${cell(command.description)}${humanOnly} | ${options ? cell(options) : '—'} |`
}

function renderCommands(manifest: KanboCapabilities): string[] {
  return [
    '## Commands',
    '',
    '| Command | Does | Options |',
    '| --- | --- | --- |',
    ...manifest.commands.map(renderCommand),
  ]
}

function renderRules(manifest: KanboCapabilities): string[] {
  return ['## Rules', '', ...manifest.rules.map(rule => `- ${rule}`)]
}

function renderEntryRules(manifest: KanboCapabilities): string[] {
  return [
    '## Column entry rules',
    '',
    'What a column may ask of a card before an agent moves it in. Which columns ask for which is per board: '
    + '`kanbo columns list` or `kanbo_columns`.',
    '',
    ...manifest.entryRules.map(entry => `- \`${entry.rule}\` — ${entry.description}`),
  ]
}

function renderCanonicalStrings(manifest: KanboCapabilities): string[] {
  const rows = Object.entries(manifest.canonicalStrings)
    .map(([name, value]) => `| ${cell(name)} | \`${cell(value)}\` |`)
  return [
    '## Canonical strings',
    '',
    'What the board writes for you, on a status line or in a system comment. A value ending in a space or `: ` '
    + 'is a prefix — the rest of the line is whatever the write was about.',
    '',
    '| Name | Value |',
    '| --- | --- |',
    ...rows,
  ]
}

function renderRoles(manifest: KanboCapabilities): string[] {
  return [
    '## Roles',
    '',
    `- Person: \`${manifest.roles.person}\``,
    `- Agent: \`${manifest.roles.agent}\``,
    '',
    'What the database itself refuses the agent role, on an external board, whichever client sends the write:',
    '',
    ...manifest.roles.refusals.map(refusal => `- ${refusal}`),
  ]
}

function renderLimits(manifest: KanboCapabilities): string[] {
  return ['## Limits', '', ...manifest.limits.map(limit => `- ${limit}`)]
}

/** The manifest, laid out under one heading per field — stable and diffable, never a snapshot to update by hand. */
export function renderCapabilitiesMarkdown(manifest: KanboCapabilities): string {
  return [
    '# Kanbo capabilities',
    '',
    `\`${manifest.package.name}\` ${manifest.package.version} — capabilities manifest version ${manifest.version}.`,
    '',
    ...renderStorages(manifest),
    '',
    ...renderTools(manifest),
    '',
    ...renderCommands(manifest),
    '',
    ...renderRules(manifest),
    '',
    ...renderEntryRules(manifest),
    '',
    ...renderCanonicalStrings(manifest),
    '',
    ...renderRoles(manifest),
    '',
    ...renderLimits(manifest),
    '',
  ].join('\n')
}
