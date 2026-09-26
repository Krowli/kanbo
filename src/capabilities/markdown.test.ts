import { describe, expect, it } from 'vitest'

import { buildCapabilitiesManifest } from './manifest'
import { renderCapabilitiesMarkdown } from './markdown'

/**
 * No snapshot: a snapshot would go stale the moment a rule's wording changes
 * and get updated without anyone reading it. What has to hold is structural —
 * every entry the manifest carries gets a line of its own — and that is what
 * each check below asks for instead.
 */
describe('renderCapabilitiesMarkdown', () => {
  const manifest = buildCapabilitiesManifest()
  const markdown = renderCapabilitiesMarkdown(manifest)
  const lines = markdown.split('\n')

  it('has one heading per section, in order', () => {
    const headings = lines.filter(line => line.startsWith('## '))
    expect(headings).toEqual([
      '## Storages',
      '## Tools',
      '## Commands',
      '## Rules',
      '## Column entry rules',
      '## Canonical strings',
      '## Roles',
      '## Limits',
    ])
  })

  it.each(manifest.tools.map(tool => tool.name))('gives %s a table row', (name) => {
    const row = lines.some(line => line.startsWith('|') && line.includes(`\`${name}\``))
    expect(row, `${name} has no row`).toBe(true)
  })

  it.each(manifest.commands.map(command => command.path))('gives `kanbo %s` a table row', (path) => {
    const row = lines.some(line => line.startsWith('|') && line.includes(`\`kanbo ${path}\``))
    expect(row, `kanbo ${path} has no row`).toBe(true)
  })

  it.each(manifest.rules)('gives a rule a bullet of its own', (rule) => {
    expect(lines).toContain(`- ${rule}`)
  })

  it.each(manifest.limits)('gives a limit a bullet of its own', (limit) => {
    expect(lines).toContain(`- ${limit}`)
  })

  it.each(manifest.entryRules.map(entry => entry.rule))('lists the entry rule %s', (rule) => {
    expect(lines.some(line => line.startsWith(`- \`${rule}\``))).toBe(true)
  })

  it.each(Object.keys(manifest.canonicalStrings))('gives the canonical string %s a table row', (name) => {
    const row = lines.some(line => line.startsWith('|') && line.includes(`| ${name} |`))
    expect(row, `${name} has no row`).toBe(true)
  })

  it.each(manifest.roles.refusals)('gives a refusal a bullet of its own', (refusal) => {
    expect(lines).toContain(`- ${refusal}`)
  })

  it('names both roles', () => {
    expect(markdown).toContain(`\`${manifest.roles.person}\``)
    expect(markdown).toContain(`\`${manifest.roles.agent}\``)
  })

  it('is stable across two builds of the same manifest', () => {
    expect(renderCapabilitiesMarkdown(buildCapabilitiesManifest())).toBe(markdown)
  })
})
