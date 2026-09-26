import type { Command } from 'commander'

import { buildCapabilitiesManifest } from '../../capabilities/manifest'
import { renderCapabilitiesMarkdown } from '../../capabilities/markdown'
import { CliError } from '../output'

/**
 * `kanbo capabilities` — the board's tools, commands, rules and limits, for
 * whoever is deciding how to work it rather than working a card right now.
 *
 * No board is opened. Everything this command prints is board-independent —
 * a board's columns are its own and `kanbo prime` is where those live — so
 * there is nothing here to fail on a missing `--db` or a stale schema, and
 * none of the ordinary board flags apply. `kanbo mcp` serves the same two
 * shapes as resources, `kanbo://capabilities` and `kanbo://capabilities.md`,
 * from the same `buildCapabilitiesManifest`.
 */
interface CapabilitiesOptions {
  json?: boolean
  markdown?: boolean
}

export function registerCapabilitiesCommand(program: Command): void {
  program
    .command('capabilities')
    .description('the board\'s tools, commands, rules and limits — machine-readable, no board needed')
    .option('--json', 'print the manifest as JSON')
    .option('--markdown', 'print the manifest as Markdown (the default)')
    .action((options: CapabilitiesOptions) => {
      if (options.json && options.markdown) {
        throw new CliError(1, 'Pass --json or --markdown, not both.')
      }

      const manifest = buildCapabilitiesManifest()
      console.log(options.json ? JSON.stringify(manifest, null, 2) : renderCapabilitiesMarkdown(manifest))
    })
}
