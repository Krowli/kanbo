import { hostname, userInfo } from 'node:os'

import type { Command } from 'commander'

import type { BoardActor } from '../ops/types'
import { readAgentShellMarker } from './agent-shell'
import { CliError, EXIT_HUMAN_ONLY } from './output'

/**
 * Who the board is being written by, as far as a shell can tell.
 *
 * The HTTP route knows its actor from the session it was called with. A
 * terminal has no session, so the tool says the honest thing: this is something
 * outside any app, run by whoever owns this shell, on this machine. It is never
 * an argument — a caller that could name its own kind could name `user`, and
 * the one rule the board has about people would be worth nothing.
 */

/**
 * What an agent's shell is told when it tries a person's command, as two
 * lines: the refusal, addressed to the agent, and — for a person whose own
 * editor terminal carries an agent tool's mark — the same command with
 * `KANBO_ACTOR_KIND=person` in front, which lets it through.
 */
function refusal(what: string, askAPerson: string): (marker: string, command: string) => string {
  return (marker, command) => [
    `Only a person can ${what}. This shell belongs to an agent (${marker}): ask a person to ${askAPerson} on the board page (kanbo serve).`,
    describePersonOverride(command),
  ].join('\n')
}

/** The line every refusal and "no board" in an agent's shell ends with: how a person in an editor terminal runs `command` anyway. */
export function describePersonOverride(command: string): string {
  return `If you are a person in an editor terminal, run: KANBO_ACTOR_KIND=person ${command}`
}

/** What a person is told when an agent's shell tries to answer for them. */
export const describeApprovalRefusal = refusal('approve a card', 'approve it')

/** The same, for sending a card back. */
export const describeReturnRefusal = refusal('send a card back', 'return it')

/** The same, for closing a sprint (ruling 5x-4). */
export const describeSprintCloseRefusal = refusal('close a sprint', 'close it')

/**
 * The same, for setting what a column asks of a card (ruling 6-1): an agent that
 * could clear a column's rules could walk any card past them.
 */
export const describeColumnRulesRefusal = refusal('set what a column asks of a card', 'set it')

/**
 * The same, for changing the board's columns: every agent reads its work from
 * them, and `kanbo ready` from To Do.
 */
export const describeColumnChangesRefusal = refusal('change the board\'s columns', 'change them')

/**
 * The same, for taking back the log a run names: an agent that could clear or
 * swap it could point a card's history at any log it liked.
 */
export const describeRunSessionRefRefusal = refusal('change or clear the log a run names', 'do it')

/** The commands only a person may run, as typed after `kanbo` — the capabilities manifest reads this rather than naming them again. */
export const HUMAN_ONLY_ACTIONS = [
  'approve',
  'return',
  'sprint close',
  'columns rules',
  'columns add',
  'columns rename',
  'columns move',
  'columns remove',
  'columns template',
  'columns add-standard',
  'run clear-session',
] as const

/** What only a person may do: the commands above, and one option of a command anyone may run. */
type HumanOnlyAction = typeof HUMAN_ONLY_ACTIONS[number] | 'run attach-session --replace'

const HUMAN_ONLY_MESSAGES: Record<HumanOnlyAction, (marker: string, command: string) => string> = {
  'approve': describeApprovalRefusal,
  'return': describeReturnRefusal,
  'sprint close': describeSprintCloseRefusal,
  'columns rules': describeColumnRulesRefusal,
  'columns add': describeColumnChangesRefusal,
  'columns rename': describeColumnChangesRefusal,
  'columns move': describeColumnChangesRefusal,
  'columns remove': describeColumnChangesRefusal,
  'columns template': describeColumnChangesRefusal,
  'columns add-standard': describeColumnChangesRefusal,
  'run clear-session': describeRunSessionRefRefusal,
  'run attach-session --replace': describeRunSessionRefRefusal,
}

/** The actor every board write from this tool is filed under. */
export function createCliActor(): BoardActor {
  return {
    kind: 'external',
    id: process.env.KANBO_ACTOR_ID?.trim() || safeUsername(),
    name: hostname(),
  }
}

/**
 * The person on the other end of this shell — or the refusal that says there
 * is none.
 *
 * Approving, returning, closing a sprint, setting a column's entry rules,
 * changing the board's columns and taking back the log a run names are the
 * things only a person may do, and a shell
 * that says it belongs to an agent is not one. `KANBO_ACTOR_KIND=person` overrides
 * the marks — for a person's own terminal that an agent tool marked — so this
 * keeps an honest agent from approving its own work, and does not stop one that
 * sets the variable. Real enforcement needs a shared Postgres board with agents
 * on the agent role, where the database itself refuses.
 *
 * `command` is what was typed (`typedCommand`), for the refusal's last line.
 */
export function requireHumanActor(action: HumanOnlyAction, command: string): BoardActor {
  const marker = readAgentShellMarker()
  if (marker !== null) {
    throw new CliError(EXIT_HUMAN_ONLY, HUMAN_ONLY_MESSAGES[action](marker, command))
  }
  return createPersonActor()
}

/**
 * The actor a card placement — `card create`, `card update`, `card move` —
 * runs as. It is filed `external` like every other write from this tool
 * (ruling 6-6). In a person's own terminal it also carries `placesForPerson`,
 * so a column's entry rules warn that person instead of holding the card back
 * (ruling 6-5), exactly as they do on the board page. In an agent's shell it
 * does not, and the column refuses the card.
 */
export function createPlacementActor(): BoardActor {
  return isAgentShell() ? createCliActor() : { ...createCliActor(), placesForPerson: true }
}

/**
 * The person who owns this shell, as the board files a person. Only for a
 * caller that has already asked `isAgentShell` — `requireHumanActor` for a
 * command, `kanbo serve` once when it starts.
 */
export function createPersonActor(): BoardActor {
  return { kind: 'user', id: safeUsername() }
}

/**
 * The account name this shell runs under, never a crash.
 *
 * `os.userInfo()` throws where the account has no entry in the system's user
 * database — a container started with an arbitrary uid, some Windows service
 * and domain setups — and a board write should not fail over a name. The
 * environment's own idea of the user comes next, then `unknown`.
 */
export function safeUsername(): string {
  try {
    const name = userInfo().username.trim()
    if (name) {
      return name
    }
  }
  catch {
    // No entry for this account; the environment may still know.
  }
  for (const variable of ['USER', 'USERNAME', 'LOGNAME']) {
    const name = process.env[variable]?.trim()
    if (name) {
      return name
    }
  }
  return 'unknown'
}

/**
 * Does this shell belong to an agent?
 *
 * `KANBO_ACTOR_KIND=agent` says so, and so does the mark an agent tool leaves
 * in the commands its agent runs (`AGENT_SHELL_MARKERS`), unless
 * `KANBO_ACTOR_KIND=person` says otherwise. Three things ask. `approve`,
 * `return`, `sprint close`, `columns rules` and taking back a run's log refuse
 * such a shell outright, no question is asked in it (`canPrompt`), and the
 * board resolution hands it the agent role's own connection string when the
 * project has one — the same question, answered once here.
 */
export function isAgentShell(): boolean {
  return readAgentShellMarker() !== null
}

/**
 * The command line that reached `command`, as a person would type it again:
 * `kanbo` and every word given to the program, quoted for a POSIX shell where
 * a word needs it.
 */
export function typedCommand(command: Command): string {
  let root = command
  while (root.parent) {
    root = root.parent
  }
  // Commander keeps the words it was parsed from on the root as `rawArgs`
  // (every `parse` sets it); its typings leave the property out.
  const { rawArgs } = root as Command & { rawArgs: string[] }
  return ['kanbo', ...rawArgs.map(quoteForShell)].join(' ')
}

function quoteForShell(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll('\'', '\'\\\'\'')}'`
}
