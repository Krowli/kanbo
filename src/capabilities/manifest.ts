import { Command } from 'commander'
import { z } from 'zod'

import { HUMAN_ONLY_ACTIONS } from '../cli/actor'
import { registerKanboCommands } from '../cli/commands'
import { CLI_EXIT_CODES } from '../cli/output'
import type { EntryRule } from '../domain/entry-rules'
import { ENTRY_RULE_DESCRIPTIONS, ENTRY_RULES } from '../domain/entry-rules'
import type { KanboToolCliEquivalent } from '../mcp/tool-names'
import { KANBO_TOOL_CLI_EQUIVALENTS } from '../mcp/tool-names'
import { KANBO_TOOLS } from '../mcp/tools'
import { BOARD_RULES } from '../ops/agent-rules'
import { APPROVED_COMMENT } from '../ops/approval'
import { RETURNED_STATUS_LINE_PREFIX } from '../ops/cards'
import {
  LAUNCHED_STATUS_LINE_PREFIX,
  NO_REPORT_STATUS_LINE,
  RUN_FAILED_COMMENT,
  RUN_FAILED_COMMENT_PREFIX,
  RUN_FINISHED_COMMENT,
  RUN_STARTED_COMMENT_PREFIX,
  RUN_STOPPED_BY_YOU_COMMENT,
  RUN_STOPPED_COMMENT,
  RUN_STOPPED_REASON_PREFIX,
  STOPPED_BY_YOU_STATUS_LINE,
} from '../ops/runs'
import { KANBO_PACKAGE_VERSION } from '../package-version'
import {
  AGENT_APPROVAL_COMMENT_REFUSAL,
  AGENT_WAITING_REFUSAL,
  BOARD_AGENT_ROLE,
  BOARD_PERSON_ROLE,
} from '../postgres/roles.sql'
import { BOARD_SCHEMA_EPOCH } from '../schema-epoch'

/**
 * A machine-readable description of this board, for an agent that has never
 * seen it before: an orchestrator deciding how to work a card, a host wiring
 * up its own tools against the board, anything that is not a person reading
 * the README.
 *
 * Every list below is read out of the same constants and registrations the
 * board itself runs on — `KANBO_TOOLS`, `registerKanboCommands`,
 * `BOARD_RULES`, the canonical strings `ops/cards.ts` and `ops/runs.ts` write,
 * the roles `roles.sql.ts` creates — rather than written out a second time.
 * `manifest.test.ts` is what keeps that true: it fails the day one of those
 * sources gains something this file was not told about.
 *
 * `buildCapabilitiesManifest` and `renderCapabilitiesMarkdown` are the one
 * source two servings come from: `kanbo capabilities` prints either shape
 * from a terminal, and `kanbo mcp` serves both as resources
 * (`kanbo://capabilities`, `kanbo://capabilities.md`).
 */

/** The manifest's own shape version, bumped when a field is added or removed — not the package's version. */
export const CAPABILITIES_MANIFEST_VERSION = '3'

/** The board's name and the build that is answering, as `kanbo mcp` itself reports them. */
export interface KanboCapabilitiesPackage {
  name: string
  version: string
}

/** One of the three places a board can live, and what tells them apart. */
export interface KanboCapabilityStorage {
  /** `own-file` is `kanbo init --file`; `host-file` is a host app's own database; `postgres` is external. */
  kind: 'host-file' | 'own-file' | 'postgres'
  label: string
  description: string
  /** The board schema generation this build speaks, from `BOARD_SCHEMA_EPOCH` — the same number in all three. */
  schemaEpoch: number
}

/** One of the board's MCP tools, with the JSON Schema an orchestrator validates a call against. */
export interface KanboCapabilityTool {
  name: string
  title: string
  description: string
  /** `tool.inputSchema` converted with zod's own `toJSONSchema` — never hand-written. */
  inputSchema: Record<string, unknown>
  /** What to type instead, from `KANBO_TOOL_CLI_EQUIVALENTS`: the `kanbo` command. */
  cli: KanboToolCliEquivalent
}

/** One flag a CLI command takes, as commander itself declares it. */
export interface KanboCapabilityCommandOption {
  /** The flag spelling commander prints in `--help`, e.g. `--title <title>`. */
  flags: string
  description: string
  /** Set by `.requiredOption(...)`: the command refuses to run without it. */
  mandatory: boolean
}

/** One positional argument a CLI command takes, as commander itself declares it. */
export interface KanboCapabilityCommandArgument {
  name: string
  description: string
  required: boolean
}

/** One leaf command of the `kanbo` binary — a command with no subcommands of its own. */
export interface KanboCapabilityCommand {
  /** How a person types it, without the leading `kanbo`: `card create`, `approve`. */
  path: string
  description: string
  arguments: KanboCapabilityCommandArgument[]
  options: KanboCapabilityCommandOption[]
  /** `true` for the commands `requireHumanActor` guards: refused in a shell that says it belongs to an agent. */
  humanOnly: boolean
  /** Every exit code this build promises, from `CLI_EXIT_CODES` — the same table for every command. */
  exitCodes: typeof CLI_EXIT_CODES
}

/** The two database roles an external board is worked through, and what the database itself refuses the agent. */
export interface KanboCapabilitiesRoles {
  person: string
  agent: string
  /** What the database says back when the agent role tries the two things that are a person's. */
  refusals: string[]
}

/** One rule a column may ask of a card before an agent moves the card in (ruling 6-1). */
export interface KanboCapabilityEntryRule {
  rule: EntryRule
  description: string
}

/** Everything an orchestrator can read about this board before it has opened one. */
export interface KanboCapabilities {
  version: string
  package: KanboCapabilitiesPackage
  storages: KanboCapabilityStorage[]
  tools: KanboCapabilityTool[]
  commands: KanboCapabilityCommand[]
  /** The board-independent rules `kanbo prime` states — no columns here, because a column is per board. */
  rules: string[]
  /** Every rule a column may ask of a card, from `ENTRY_RULES` — which columns ask for which is per board, in `kanbo_columns`. */
  entryRules: KanboCapabilityEntryRule[]
  /** The literal strings the board writes for a run's lifecycle, an approval and a return — prefixes end in the punctuation or space that precedes the part a caller fills in. */
  canonicalStrings: Record<string, string>
  roles: KanboCapabilitiesRoles
  limits: string[]
}

/** The package name and version this build reports — the same literal `kanbo mcp` and `kanbo --version` already use. */
const KANBO_PACKAGE: KanboCapabilitiesPackage = { name: 'kanbo', version: KANBO_PACKAGE_VERSION }

const KANBO_STORAGES: readonly KanboCapabilityStorage[] = [
  {
    kind: 'host-file',
    label: 'A host app\'s own database file',
    description: 'The board is nine tables among an app\'s own, beside a `workspaces` table the command line reads '
      + 'the project\'s workspace from. The app migrates the file itself; this package applies no migrations to '
      + 'it and reads and writes a schema someone else created. The app names the file with `KANBO_DB_PATH`.',
    schemaEpoch: BOARD_SCHEMA_EPOCH,
  },
  {
    kind: 'own-file',
    label: 'A board file of a project\'s own',
    description: '`.kanbo/board.db` by default (`kanbo init --file`). This package creates it, migrates it '
      + 'with its own drizzle-sqlite chain, and marks it so every later command reads it as its own rather than '
      + 'looking for a `workspaces` table that is not there.',
    schemaEpoch: BOARD_SCHEMA_EPOCH,
  },
  {
    kind: 'postgres',
    label: 'An external Postgres database',
    description: 'Nothing but the board — no other owner exists to migrate it. `kanbo migrate` is the only '
      + 'thing that ever does, and `kanbo roles apply` installs the two roles and the rules the database '
      + 'itself keeps about them.',
    schemaEpoch: BOARD_SCHEMA_EPOCH,
  },
]

/**
 * The literal strings the board writes on a card's behalf, keyed the way an
 * agent reading the README prose would name them. A key ending the value in a
 * space or a colon-space is a prefix: the rest of the line is filled in by
 * whatever the write was about, not part of the constant.
 */
function buildCanonicalStrings(): Record<string, string> {
  return {
    launched: LAUNCHED_STATUS_LINE_PREFIX,
    stoppedByYou: STOPPED_BY_YOU_STATUS_LINE,
    returned: RETURNED_STATUS_LINE_PREFIX,
    noReport: NO_REPORT_STATUS_LINE,
    runStarted: RUN_STARTED_COMMENT_PREFIX,
    runFinished: RUN_FINISHED_COMMENT,
    runFailed: RUN_FAILED_COMMENT,
    runFailedReason: RUN_FAILED_COMMENT_PREFIX,
    runStoppedByYou: RUN_STOPPED_BY_YOU_COMMENT,
    runStopped: RUN_STOPPED_COMMENT,
    runStoppedReason: RUN_STOPPED_REASON_PREFIX,
    approved: APPROVED_COMMENT,
  }
}

/** Every board tool, with its schema converted and its CLI equivalent attached. */
function buildTools(): KanboCapabilityTool[] {
  return KANBO_TOOLS.map(tool => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: z.toJSONSchema(z.object(tool.inputSchema)) as Record<string, unknown>,
    cli: KANBO_TOOL_CLI_EQUIVALENTS[tool.name],
  }))
}

/** Every leaf command the `kanbo` binary answers to, walked off its own registration. */
function buildCommands(): KanboCapabilityCommand[] {
  const program = new Command()
  registerKanboCommands(program)

  function walk(command: Command, prefix: string[]): KanboCapabilityCommand[] {
    return command.commands.flatMap((child) => {
      const path = [...prefix, child.name()]
      if (child.commands.length > 0) {
        return walk(child, path)
      }
      return [{
        path: path.join(' '),
        description: child.description(),
        arguments: child.registeredArguments.map(argument => ({
          name: argument.name(),
          description: argument.description,
          required: argument.required,
        })),
        options: child.options.map(option => ({
          flags: option.flags,
          description: option.description,
          mandatory: option.mandatory,
        })),
        humanOnly: (HUMAN_ONLY_ACTIONS as readonly string[]).includes(path.join(' ')),
        exitCodes: CLI_EXIT_CODES,
      }]
    })
  }

  return walk(program, [])
}

/** Everything this build of the board can tell an orchestrator about itself. */
export function buildCapabilitiesManifest(): KanboCapabilities {
  return {
    version: CAPABILITIES_MANIFEST_VERSION,
    package: KANBO_PACKAGE,
    storages: [...KANBO_STORAGES],
    tools: buildTools(),
    commands: buildCommands(),
    rules: [...BOARD_RULES],
    entryRules: ENTRY_RULES.map(rule => ({ rule, description: ENTRY_RULE_DESCRIPTIONS[rule] })),
    canonicalStrings: buildCanonicalStrings(),
    roles: {
      person: BOARD_PERSON_ROLE,
      agent: BOARD_AGENT_ROLE,
      refusals: [AGENT_WAITING_REFUSAL, AGENT_APPROVAL_COMMENT_REFUSAL],
    },
    limits: [
      'Only a person may approve or return a card. `kanbo approve` and `kanbo return` refuse a shell that '
      + 'says it belongs to an agent (`KANBO_ACTOR_KIND=agent`, or `CLAUDECODE=1`, `GEMINI_CLI=1` or `CURSOR_AGENT` '
      + 'unless `KANBO_ACTOR_KIND=person`; exit 4), and there is no flag past it.',
      'On an external board the same two rules are the database\'s own: a person\'s decision cannot be taken '
      + 'back, written over, or erased by the agent role, whichever client sends the write.',
      'Only a person may close a sprint. `kanbo sprint close` refuses an agent\'s shell '
      + '(exit 4), and the operation refuses any actor but a person; there is no MCP tool that closes one — '
      + '`kanbo_sprints` only reads. Unlike approval, the database role does not enforce this.',
      `The agent role (\`${BOARD_AGENT_ROLE}\`) may not delete a card at all — it holds select, insert and `
      + 'update on `issues` and nothing more, even though it may delete freely on every other board table.',
      'A column may ask a card to meet entry rules before it enters (`entryRules`). Anyone but a person moving, '
      + 'creating or bulk-moving a card into it early is refused with `board_column_rules_unmet` and one line per '
      + 'unmet rule (CLI exit 1); a person goes through and is told what is missing. Only a person sets the rules '
      + '— `kanbo columns rules` refuses an agent\'s shell (exit 4). The database role does not '
      + 'enforce them.',
      'Only a person changes the board\'s columns: `kanbo columns add`, `rename`, `move`, `remove`, `template` and '
      + '`add-standard` refuse an agent\'s shell (exit 4), and the rename, move, remove and add-missing operations '
      + 'refuse any actor but a person (`board_column_structure_requires_user`); no MCP tool changes columns. '
      + 'To Do can be neither removed nor renamed away from its slug `to_do`: `kanbo ready` takes work from it.',
      'No board tool or command deletes a card, agent role or not. Cancelling one is a move to another column. '
      + 'The one exception is `kanbo serve`\'s `DELETE /issues/:id`, which it answers only for '
      + 'a request presenting its token, on a server a person started, that has not sent `x-kanbo-actor: agent` '
      + '(403 `issue_delete_requires_user` otherwise).',
      '`kanbo migrate` and `kanbo roles apply` refuse a host app\'s own database file: the app migrates it, '
      + 'and this package never touches it.',
      'A write to a board older than this build\'s schema epoch is refused (exit 3) until `kanbo migrate` '
      + 'runs (on a host app\'s database, until the app migrates it) — reads stay open either way.',
      'There is no MCP tool that approves a card, and there never will be: `kanbo_wait_approval` hands the '
      + 'card to a person and ends the turn; only a person takes it back.',
    ],
  }
}
