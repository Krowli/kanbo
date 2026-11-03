import type { Command } from 'commander'

import { openInBrowser, presentServePage, resolveServeAccess } from '../../serve/access'
import type { ServeActors } from '../../serve/actors'
import { createPagePresence } from '../../serve/page-presence'
import type { PagePresence } from '../../serve/page-presence'
import { createServeProjects } from '../../serve/projects'
import {
  DEFAULT_SERVE_HOST,
  DEFAULT_SERVE_PORT,
  describePersonRights,
  startKanboServer,
} from '../../serve/server'
import { createCliActor, createPersonActor, isAgentShell } from '../actor'
import { findBinding, readProjectBinding } from '../binding'
import { openBoardSession } from '../command'
import { describeFailure } from '../failure'
import { CliError } from '../output'
import { readProjectRegistry } from '../project-registry'

/**
 * `kanbo serve` — the board over HTTP: the board page for a browser, and the
 * board's `/issues` routes for any other client.
 *
 * The routes serve the board and workspace this command resolves the way every
 * other command does, so a client written against them shows and edits this
 * board unchanged, whichever server answers them. Everything
 * about the door — the token, the origins, the body limit, who a request writes
 * as — is `../../serve/`.
 */

/** What `kanbo serve` is told. */
export interface ServeCommandOptions {
  port: string
  host: string
  db?: string
  databaseUrl?: string
  workspace?: string
  token?: string
  corsOrigin: string[]
  /** `false` under `--no-open`. */
  open: boolean
}

export function registerServeCommand(program: Command): void {
  program
    .command('serve')
    .description('Open the board in your browser')
    .option('--port <port>', 'port to listen on', String(DEFAULT_SERVE_PORT))
    .option('--host <host>', 'address to listen on; anything but this computer needs a token', DEFAULT_SERVE_HOST)
    .option('--db <path>', 'the board file to open')
    .option('--database-url <url>', 'a shared Postgres board to use instead of a board file')
    .option('--workspace <nameOrId>', 'the project, when this folder is not bound to one')
    .option('--token <token>', 'a password every request must carry (or set KANBO_SERVE_TOKEN); made up for you when left out')
    .option('--cors-origin <origin>', 'let pages from this web address call the board; repeat for more', collect, [])
    .option('--no-open', 'print the board page link without opening it in the browser')
    .action(async (options: ServeCommandOptions) => {
      const running = await startServe(options, { status: line => console.error(line), page: line => console.log(line) })
      const why = await waitForStop(running.idle)
      if (why === 'idle') {
        console.error('kanbo serve: the last board tab was closed — stopped.')
      }
      try {
        await running.close()
        process.exit(0)
      }
      catch (error) {
        console.error(describeFailure(error).message)
        process.exit(1)
      }
    })
}

/** A board page being served, and how to stop it. */
export interface RunningServe {
  /** The board page's link — with this run's token in it, when the token was made up for the run. */
  link: string
  /** Settles when the last board tab has closed; never, when this run does not stop by itself. */
  idle: Promise<void>
  /** Stop listening, then close the board. */
  close: () => Promise<void>
}

/** Where `startServe` says what it started: status lines, and the board page's own line. */
export interface ServeOutput {
  status: (line: string) => void
  page: (line: string) => void
}

/**
 * Open the board and serve it — everything `kanbo serve` does but wait. The
 * command waits for Ctrl-C (or the last board tab closing) and ends the
 * process; the home menu waits the same and comes back to its menu.
 */
export async function startServe(options: ServeCommandOptions, output: ServeOutput): Promise<RunningServe> {
  const port = parsePort(options.port)
  // Refused before the board is opened: a server that would not be allowed
  // to start has no business connecting to anything first.
  const access = resolveServeAccess(options.host, options.token?.trim() || process.env.KANBO_SERVE_TOKEN?.trim() || null)

  const here = findBinding(process.cwd())
  // Started outside any project and told nothing about a board: the project
  // used most recently stands in for "here".
  const mostRecent = here === null && namesNoBoard(options) ? readProjectRegistry()[0] : undefined
  const defaultDir = here?.projectDir ?? mostRecent?.path ?? null
  const session = await openBoardSession(
    { db: options.db, databaseUrl: options.databaseUrl, workspace: options.workspace },
    'read',
    mostRecent?.path,
  )
  const projects = createServeProjects({
    defaultProject: defaultDir === null ? null : { dir: defaultDir, session },
    readRegistry: () => readProjectRegistry(),
    readBinding: dir => readProjectBinding(dir),
    openSession: async dir => await openBoardSession({}, 'read', dir),
  })
  const agentShell = isAgentShell()
  const actors: ServeActors = { writer: createCliActor(), person: agentShell ? null : createPersonActor() }

  // The server stops by itself exactly when this run opens the browser.
  const opensBrowser = !agentShell && process.stdout.isTTY === true && options.open
  let presence: PagePresence | undefined
  const idle = new Promise<void>((resolve) => {
    presence = opensBrowser ? createPagePresence({ onIdle: resolve }) : undefined
  })

  let server: Awaited<ReturnType<typeof startKanboServer>>
  try {
    server = await startKanboServer({
      session,
      projects,
      presence,
      actors,
      host: options.host,
      port,
      token: access.token,
      corsOrigins: options.corsOrigin,
    })
  }
  catch (error) {
    presence?.stop()
    await session.close()
    throw error
  }

  const projectCount = projects.list().length
  output.status(`kanbo serve: ${server.url} — workspace ${session.workspace.id}, ${projectCount} ${projectCount === 1 ? 'project' : 'projects'}, bearer token required${access.generated ? ' (generated for this run)' : ''}`)
  output.status(`kanbo serve: ${describePersonRights(actors)}`)
  presentServePage(
    { url: server.url, access, agentShell, terminal: process.stdout.isTTY === true, open: options.open },
    { print: output.page, openInBrowser },
  )

  return {
    link: access.generated ? `${server.url}/#token=${access.token}` : `${server.url}/`,
    idle,
    close: async () => {
      presence?.stop()
      try {
        await server.close()
      }
      finally {
        try {
          await projects.close()
        }
        finally {
          await session.close()
        }
      }
    },
  }
}

/** Whether neither a flag nor the environment says which board to open. */
function namesNoBoard(options: ServeCommandOptions): boolean {
  return !options.db && !options.databaseUrl && !options.workspace
    && !process.env.KANBO_DB_PATH && !process.env.KANBO_DATABASE_URL && !process.env.KANBO_WORKSPACE_ID
}

/** What `kanbo serve` with no options is told — the home menu serves the board this way. */
export const DEFAULT_SERVE_OPTIONS: ServeCommandOptions = {
  port: String(DEFAULT_SERVE_PORT),
  host: DEFAULT_SERVE_HOST,
  corsOrigin: [],
  open: true,
}

/**
 * Settles on the first Ctrl-C (SIGINT) or SIGTERM, or when `idle` settles, and
 * stops listening for both signals whichever it was.
 */
export function waitForStop(idle: Promise<void>): Promise<'interrupt' | 'idle'> {
  return new Promise((resolve) => {
    const finish = (why: 'interrupt' | 'idle'): void => {
      process.off('SIGINT', onSignal)
      process.off('SIGTERM', onSignal)
      resolve(why)
    }
    const onSignal = (): void => finish('interrupt')
    process.on('SIGINT', onSignal)
    process.on('SIGTERM', onSignal)
    void idle.then(() => finish('idle'))
  })
}

/** Settles on the first Ctrl-C (SIGINT) or SIGTERM, and stops listening for both. */
export async function waitForInterrupt(): Promise<void> {
  await waitForStop(new Promise(() => {}))
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value]
}

/** A port a caller typed, refused rather than guessed at when it is not one. */
function parsePort(value: string): number {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new CliError(1, `Expected a port between 0 and 65535, got "${value}".`)
  }
  return port
}
