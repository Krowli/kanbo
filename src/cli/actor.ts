import { hostname, userInfo } from 'node:os'

import type { BoardActor } from '../ops/types'
import { AGENT_KIND_MARKER, readAgentShellMarker } from './agent-shell'
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

/** Where a person does it instead — said after every refusal below. */
const HUMAN_ONLY_HINT = ' Run it in your own terminal, or on the board page (kanbo serve).'

/** What a person is told when an agent's shell tries to answer for them. */
export const APPROVAL_IS_HUMAN_MESSAGE
  = 'Approval is for a person. This shell belongs to an agent (KANBO_ACTOR_KIND=agent). '
    + 'Ask a person to approve it on the board or run "kanbo approve" in their own terminal.'
    + HUMAN_ONLY_HINT

/** The same, for sending a card back. */
export const RETURN_IS_HUMAN_MESSAGE
  = 'Return is for a person. This shell belongs to an agent (KANBO_ACTOR_KIND=agent). '
    + 'Ask a person to return it on the board or run "kanbo return" in their own terminal.'
    + HUMAN_ONLY_HINT

/** The same, for closing a sprint (ruling 5x-4). */
export const SPRINT_CLOSE_IS_HUMAN_MESSAGE
  = 'Closing a sprint is for a person. This shell belongs to an agent (KANBO_ACTOR_KIND=agent). '
    + 'Ask a person to close the sprint on the board or run "kanbo sprint close" in their own terminal.'
    + HUMAN_ONLY_HINT

/**
 * The same, for setting what a column asks of a card (ruling 6-1): an agent that
 * could clear a column's rules could walk any card past them.
 */
export const COLUMN_RULES_IS_HUMAN_MESSAGE
  = 'Column entry rules are for a person. This shell belongs to an agent (KANBO_ACTOR_KIND=agent). '
    + 'Ask a person to set them on the board or run "kanbo columns rules" in their own terminal.'
    + HUMAN_ONLY_HINT

/**
 * The same, for taking back the log a run names: an agent that could clear or
 * swap it could point a card's history at any log it liked.
 */
export const RUN_SESSION_REF_IS_HUMAN_MESSAGE
  = 'Changing or clearing the log a run names is for a person. This shell belongs to an agent (KANBO_ACTOR_KIND=agent). '
    + 'Ask a person to do it on the board or run "kanbo run clear-session" or "kanbo run attach-session --replace" in their own terminal.'
    + HUMAN_ONLY_HINT

/** The commands only a person may run, as typed after `kanbo` — the capabilities manifest reads this rather than naming them again. */
export const HUMAN_ONLY_ACTIONS = ['approve', 'return', 'sprint close', 'columns rules', 'run clear-session'] as const

/** What only a person may do: the commands above, and one option of a command anyone may run. */
type HumanOnlyAction = typeof HUMAN_ONLY_ACTIONS[number] | 'run attach-session --replace'

const HUMAN_ONLY_MESSAGES: Record<HumanOnlyAction, string> = {
  'approve': APPROVAL_IS_HUMAN_MESSAGE,
  'return': RETURN_IS_HUMAN_MESSAGE,
  'sprint close': SPRINT_CLOSE_IS_HUMAN_MESSAGE,
  'columns rules': COLUMN_RULES_IS_HUMAN_MESSAGE,
  'run clear-session': RUN_SESSION_REF_IS_HUMAN_MESSAGE,
  'run attach-session --replace': RUN_SESSION_REF_IS_HUMAN_MESSAGE,
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
 * Approving, returning, closing a sprint, setting a column's entry rules and
 * taking back the log a run names are the things only a person may do, and a shell
 * that says it belongs to an agent is not one. `KANBO_ACTOR_KIND=person` overrides
 * the marks — for a person's own terminal that an agent tool marked — so this
 * keeps an honest agent from approving its own work, and does not stop one that
 * sets the variable. Real enforcement needs a shared Postgres board with agents
 * on the agent role, where the database itself refuses.
 */
export function requireHumanActor(action: HumanOnlyAction): BoardActor {
  const marker = readAgentShellMarker()
  if (marker !== null) {
    // The messages name `KANBO_ACTOR_KIND=agent`; a shell an agent tool marked says which mark it carries.
    throw new CliError(EXIT_HUMAN_ONLY, HUMAN_ONLY_MESSAGES[action].replace(AGENT_KIND_MARKER, marker))
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
