import type { Command } from 'commander'

import { buildCapabilitiesManifest } from '../../capabilities/manifest'
import { renderCapabilitiesMarkdown } from '../../capabilities/markdown'
import { CliError, printResult } from '../output'

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
  /** `--json` alone: the whole manifest; with fields, only those. */
  json?: string | true
  markdown?: boolean
}

export function registerCapabilitiesCommand(program: Command): void {
  program
    .command('capabilities')
    .description('List what kanbo offers agents: tools, commands, rules and limits (no board needed)')
    .option('--json [fields]', 'print it as JSON; name comma-separated fields to print only those')
    .option('--markdown', 'print it as Markdown (the default)')
    .action((options: CapabilitiesOptions) => {
      if (options.json !== undefined && options.markdown) {
        throw new CliError(1, 'Pass --json or --markdown, not both.')
      }

      const manifest = buildCapabilitiesManifest()
      if (options.json !== undefined) {
        printResult({ value: manifest }, { json: options.json })
        return
      }
      console.log(renderCapabilitiesMarkdown(manifest))
    })
}
