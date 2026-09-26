import type { Command } from 'commander'

import { KANBO_PACKAGE_VERSION } from '../../package-version'
import type { DoctorFinding } from '../doctor'
import { collectDoctorFindings } from '../doctor'
import { CliError } from '../output'

/**
 * `kanbo doctor` — check this install, this project and the agent tools that
 * reach it, and say what to do about anything wrong. Exits `1` when a check
 * fails; a warning alone does not.
 */
interface DoctorOptions {
  json?: boolean
}

/** How long `kanbo mcp` may take to answer `initialize`. */
const HANDSHAKE_TIMEOUT_MS = 10_000

const MARKS: Record<DoctorFinding['status'], string> = { ok: 'ok  ', warn: 'warn', fail: 'FAIL' }

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('check this install, this project\'s binding and board, instruction blocks and MCP registrations')
    .option('--json', 'print the findings as JSON')
    .action(async (options: DoctorOptions) => {
      const findings = await collectDoctorFindings({
        cwd: process.cwd(),
        self: process.argv[1] ?? null,
        handshakeTimeoutMs: HANDSHAKE_TIMEOUT_MS,
      })

      if (options.json) {
        console.log(JSON.stringify({ version: KANBO_PACKAGE_VERSION, findings }, null, 2))
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
