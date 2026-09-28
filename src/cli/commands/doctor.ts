import type { Command } from 'commander'

import { KANBO_PACKAGE_VERSION } from '../../package-version'
import type { DoctorFinding, DoctorInput } from '../doctor'
import { collectDoctorFindings } from '../doctor'
import { CliError, printResult } from '../output'
import { canPrompt } from '../ui/environment'
import { getUi } from '../ui/ui'
import type { UpdateCheck } from '../update-check'

/**
 * `kanbo doctor` — check this install, this project and the agent tools that
 * reach it, and say what to do about anything wrong. Exits `1` when a check
 * fails; a warning alone does not.
 *
 * `--fix` puts right what is kanbo's own to put right — an old instruction
 * block, kanbo's MCP entry pointing at a Node that moved, a board with no
 * columns, a board file older than this build — after showing the whole plan
 * and one question (or `--yes`), then checks again. It never deletes a file,
 * and never changes what is not kanbo's.
 */
interface DoctorOptions {
  /** `--json` alone: every finding, as JSON; with fields, only those. */
  json?: string | true
  fix?: boolean
  yes?: boolean
}

/** How long `kanbo mcp` may take to answer `initialize`. */
const HANDSHAKE_TIMEOUT_MS = 10_000

const MARKS: Record<DoctorFinding['status'], string> = { ok: 'ok  ', info: 'info', warn: 'warn', fail: 'FAIL' }

/** What `--fix` says to run when nobody could be asked. */
export const DOCTOR_FIX_YES_HINT = 'Run kanbo doctor --fix --yes to apply.'

/**
 * `update` is the check `kanbo` started for this run (`program.ts`): the doctor
 * reports what it heard rather than asking npm again, and `--fix`'s second
 * round of checks reuses the same answer.
 */
export function registerDoctorCommand(program: Command, update: UpdateCheck | null = null): void {
  program
    .command('doctor')
    .description('Check that kanbo, this project\'s board and your agents\' setup work')
    .option('--fix', 'fix what kanbo can, after one confirmation (never deletes anything)')
    .option('--yes', 'with --fix: apply the fixes without asking')
    .option('--json [fields]', 'print the findings as JSON; name comma-separated fields to print only those')
    .action(async (options: DoctorOptions) => {
      const machine = options.json !== undefined
      const input: DoctorInput = {
        cwd: process.cwd(),
        self: process.argv[1] ?? null,
        handshakeTimeoutMs: HANDSHAKE_TIMEOUT_MS,
      }
      const check = async (): Promise<DoctorFinding[]> => await collectDoctorFindings({
        ...input,
        // The run's own check skips machine output and opted-out environments already.
        update: machine ? null : update,
      })

      let findings = await check()
      if (options.fix) {
        // The findings first, then what --fix would do about them, then — once done — the checks again.
        if (!machine) {
          report(findings, options)
        }
        const after = await fix(findings, options, check)
        if (after) {
          findings = after
          if (!machine) {
            console.log('\nChecked again:')
          }
        }
        if (after || machine) {
          report(findings, options)
        }
      }
      else {
        report(findings, options)
      }

      const failed = findings.filter(finding => finding.status === 'fail').length
      if (failed > 0) {
        throw new CliError(1, `kanbo doctor: ${failed} check${failed === 1 ? '' : 's'} failed.`)
      }
    })
}

function report(findings: DoctorFinding[], options: DoctorOptions): void {
  if (options.json !== undefined) {
    const shown = findings.map(({ repair, ...finding }) => ({ ...finding, fixable: repair !== undefined }))
    printResult({ value: { version: KANBO_PACKAGE_VERSION, findings: shown } }, { json: options.json })
    return
  }
  for (const finding of findings) {
    console.log(`${MARKS[finding.status]}  ${finding.check.padEnd(14)} ${finding.detail}`)
    if (finding.fix) {
      console.log(`${' '.repeat(21)}fix: ${finding.fix}`)
    }
  }
}

/**
 * The fixable findings as one plan, one question, then the checks again;
 * `null` when nothing was applied.
 */
async function fix(
  findings: DoctorFinding[],
  options: DoctorOptions,
  check: () => Promise<DoctorFinding[]>,
): Promise<DoctorFinding[] | null> {
  // With JSON on stdout, everything said along the way goes to stderr.
  const say = options.json !== undefined ? console.error : console.log
  const repairs = findings.flatMap(finding => (finding.repair ? [finding.repair] : []))
  if (repairs.length === 0) {
    say('\nNothing for kanbo doctor --fix to do.')
    return null
  }

  say(['', 'kanbo doctor --fix will:', ...repairs.flatMap(repair => repair.plan), 'Nothing is deleted, and nothing else is changed.'].join('\n'))
  if (!options.yes) {
    if (!canPrompt()) {
      say(DOCTOR_FIX_YES_HINT)
      return null
    }
    if (!await getUi().confirm({ message: 'Apply these fixes?', initialValue: true })) {
      say('Nothing was changed.')
      return null
    }
  }

  for (const repair of repairs) {
    for (const line of await repair.apply()) {
      say(`  ${line}`)
    }
  }
  return await check()
}
