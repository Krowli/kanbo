import type { Command } from 'commander'

import { KANBO_PACKAGE_VERSION } from '../../package-version'
import type { DoctorFinding } from '../doctor'
import { collectDoctorFindings } from '../doctor'
import { CliError, printResult } from '../output'

/**
 * `kanbo doctor` — check this install, this project and the agent tools that
 * reach it, and say what to do about anything wrong. Exits `1` when a check
 * fails; a warning alone does not.
 */
interface DoctorOptions {
  /** `--json` alone: every finding, as JSON; with fields, only those. */
  json?: string | true
}

/** How long `kanbo mcp` may take to answer `initialize`. */
const HANDSHAKE_TIMEOUT_MS = 10_000

const MARKS: Record<DoctorFinding['status'], string> = { ok: 'ok  ', warn: 'warn', fail: 'FAIL' }

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Check that kanbo, this project\'s board and your agents\' setup work')
    .option('--json [fields]', 'print the findings as JSON; name comma-separated fields to print only those')
    .action(async (options: DoctorOptions) => {
      const findings = await collectDoctorFindings({
        cwd: process.cwd(),
        self: process.argv[1] ?? null,
        handshakeTimeoutMs: HANDSHAKE_TIMEOUT_MS,
      })

      if (options.json !== undefined) {
        printResult({ value: { version: KANBO_PACKAGE_VERSION, findings } }, { json: options.json })
      }
      else {
        for (const finding of findings) {
          console.log(`${MARKS[finding.status]}  ${finding.check.padEnd(14)} ${finding.detail}`)
          if (finding.fix) {
            console.log(`${' '.repeat(21)}fix: ${finding.fix}`)
          }
        }
      }

      const failed = findings.filter(finding => finding.status === 'fail').length
      if (failed > 0) {
        throw new CliError(1, `kanbo doctor: ${failed} check${failed === 1 ? '' : 's'} failed.`)
      }
    })
}
